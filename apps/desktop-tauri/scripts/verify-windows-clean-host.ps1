<#
.SYNOPSIS
Install a released NSIS package on a disposable Windows runner with no Node/pnpm available,
then record whether the app can provision its runtime from the network alone.

.DESCRIPTION
`verify-windows-native.ps1` runs with the runner's preinstalled Node on PATH, so it only ever
exercises the "host Node present" branch of `ensure_runtime`. This script hides every Node it can
find (PATH entries, well-known install locations, the hosted tool cache) and then installs and
launches the released package, capturing `boot.log` so a clean-machine failure is reproducible
instead of inferred. No Node is required by this script itself.

Guards mirror the native acceptance: GitHub-hosted Windows runner, interactive desktop, disposable
user data. Hidden directories are restored in `finally`.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][string]$ExpectedVersion,
    [Parameter(Mandatory)][string]$OutputPath,
    [int]$ReadyTimeoutSeconds = 1500,
    [int]$SampleSeconds = 20
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Clean-host reproduction runs only on disposable GitHub-hosted Windows runners.'
}
if (-not [Environment]::UserInteractive) { throw 'The runner has no interactive desktop; window evidence is unavailable.' }
if (-not $env:RUNNER_TEMP -or -not (Test-Path -LiteralPath $env:RUNNER_TEMP -PathType Container)) {
    throw 'RUNNER_TEMP must be an existing runner-owned directory.'
}

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CleanHostWindow {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
}
'@

$Installer = (Resolve-Path -LiteralPath $Installer).Path
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$appDataRoot = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'DeepSeek Harness'
$bootLogPath = Join-Path $appDataRoot 'boot.log'
$runtimeManifestPath = Join-Path $appDataRoot 'runtime\manifest.json'

# --- hide every Node the app could reuse ---------------------------------------------------------
$pathEntries = @($env:Path -split ';' | Where-Object { $_ })
$strippedPathEntries = @($pathEntries | Where-Object { $_ -match '(?i)(node|npm|pnpm|nvm|volta|fnm)' })
$env:Path = ($pathEntries | Where-Object { $_ -notmatch '(?i)(node|npm|pnpm|nvm|volta|fnm)' }) -join ';'

$hideCandidates = @(
    (Join-Path $env:ProgramFiles 'nodejs'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs'),
    'C:\hostedtoolcache\windows\node',
    (Join-Path $env:LOCALAPPDATA 'fnm'),
    (Join-Path $env:LOCALAPPDATA 'Volta')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

$hidden = @()
$stillVisible = @()
foreach ($candidate in $hideCandidates) {
    $moved = "$candidate.clean-host-hidden"
    try {
        if (Test-Path -LiteralPath $moved) { Remove-Item -LiteralPath $moved -Recurse -Force }
        Move-Item -LiteralPath $candidate -Destination $moved -Force
        $hidden += [ordered]@{ from = $candidate; to = $moved }
    } catch {
        $stillVisible += "$candidate ($($_.Exception.Message))"
    }
}

$report = [ordered]@{
    schemaVersion = 1
    platform = 'win32'
    mode = 'clean-host-no-node'
    expectedVersion = $ExpectedVersion
    strippedPathEntries = $strippedPathEntries
    hiddenDirectories = $hidden
    hideFailures = $stillVisible
    nodeVisibleAfterHide = @()
    installer = $Installer
    verified = $false
}

$installRoot = Join-Path $env:RUNNER_TEMP ('clawmaster-clean-host-' + [guid]::NewGuid().ToString('N'))
$dshHome = Join-Path $env:RUNNER_TEMP ('clawmaster-clean-home-' + [guid]::NewGuid().ToString('N'))
# The app uses the isolated home under appDataRoot when no existing harness
# home is found (the custom $dshHome above is empty and has no markers).
$isolatedDshHome = Join-Path $appDataRoot 'dsh-home'
$desktop = $null

try {
    # Record what Node remains reachable; a non-empty list means the repro is not clean.
    foreach ($probe in @('node', 'npm', 'pnpm')) {
        $found = Get-Command $probe -CommandType Application -ErrorAction SilentlyContinue
        if ($found) { $report.nodeVisibleAfterHide += "$probe -> $($found.Source)" }
    }
    foreach ($wellKnown in @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
        'C:\hostedtoolcache\windows\node'
    )) {
        if ($wellKnown -and (Test-Path -LiteralPath $wellKnown)) { $report.nodeVisibleAfterHide += $wellKnown }
    }
    $script:reproClean = @($report.nodeVisibleAfterHide).Count -eq 0

    New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $dshHome -Force | Out-Null
    New-Item -ItemType Directory -Path $appDataRoot -Force | Out-Null
    @{ closeAction = 'exit'; agentEnvironment = 'windows' } | ConvertTo-Json |
        Set-Content -LiteralPath (Join-Path $appDataRoot 'desktop-settings.json') -Encoding utf8NoBOM
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null

    $report['startedAtUnixMs'] = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $installerProcess = Start-Process -FilePath $Installer -ArgumentList "/S /D=$installRoot" -PassThru
    if (-not $installerProcess.WaitForExit(600000)) { throw 'NSIS silent installation timed out.' }
    if ($installerProcess.ExitCode -ne 0) { throw "NSIS installation failed: $($installerProcess.ExitCode)." }
    $exe = Join-Path $installRoot 'dsh-desktop.exe'
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'The NSIS package did not install dsh-desktop.exe.' }
    $report['installedProductVersion'] = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe).ProductVersion

    $env:DSH_HOME = $dshHome
    $env:DSH_DESKTOP_SMOKE_ROOT = ''
    $desktop = Start-Process -FilePath $exe -WorkingDirectory $installRoot -PassThru
    $report['desktopPid'] = $desktop.Id

    $readyAt = $null
    $windowSeen = $false
    $blockedMs = $ReadyTimeoutSeconds * 1000
    $waited = 0
    while ($waited -lt $blockedMs) {
        Start-Sleep -Seconds $SampleSeconds
        $waited += $SampleSeconds * 1000
        $desktop.Refresh()
        if ($desktop.HasExited) {
            $report['desktopExitedEarly'] = $true
            $report['desktopExitCode'] = $desktop.ExitCode
            break
        }
        $handle = $desktop.MainWindowHandle
        if ($handle -ne [IntPtr]::Zero -and [CleanHostWindow]::IsWindowVisible($handle)) {
            $rect = [CleanHostWindow+Rect]::new()
            if ([CleanHostWindow]::GetWindowRect($handle, [ref]$rect)) {
                $windowSeen = $true
                $report['windowVisible'] = $true
                $report['windowWidth'] = $rect.Right - $rect.Left
                $report['windowHeight'] = $rect.Bottom - $rect.Top
            }
        }
        # Check both the custom DSH_HOME and the isolated home the app
        # falls back to when no existing harness home is found.
        $runtimePath = Join-Path $dshHome 'desktop\current-runtime.json'
        if (-not (Test-Path -LiteralPath $runtimePath -PathType Leaf)) {
            $runtimePath = Join-Path $isolatedDshHome 'desktop\current-runtime.json'
        }
        if (Test-Path -LiteralPath $runtimePath -PathType Leaf) {
            $runtime = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
            $report['runtimeStatus'] = $runtime.status
            if ($runtime.status -eq 'ready') { $readyAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); break }
        }
    }

    $report['windowSeen'] = $windowSeen
    $report['ready'] = ($null -ne $readyAt)
    $report['dshHomeUsed'] = $runtimePath
    if ($null -ne $readyAt) { $report['secondsToReady'] = [math]::Round(($readyAt - [int64]$report['startedAtUnixMs']) / 1000, 1) }
    $report['waitedSeconds'] = $waited / 1000

    if (Test-Path -LiteralPath $bootLogPath -PathType Leaf) {
        $bootText = Get-Content -LiteralPath $bootLogPath -Raw
        $report['bootLogBytes'] = $bootText.Length
        $bootLines = @($bootText -split "`r?`n" | Where-Object { $_ })
        $report['bootLogTail'] = @($bootLines | Select-Object -Last 80)
        $report['bootLogSignals'] = [ordered]@{
            provisionStarting = @($bootLines | Where-Object { $_ -match 'provision starting' }).Count
            provisionSkipped = @($bootLines | Where-Object { $_ -match 'provision skipped' }).Count
            provisionComplete = @($bootLines | Where-Object { $_ -match 'provision complete' }).Count
            nodeDownloadAttempted = @($bootLines | Where-Object { $_ -match '(?i)node download|downloading node|fetch_node' }).Count
            nodeDownloadFailed = @($bootLines | Where-Object { $_ -match '(?i)node download fallback' }).Count
            pnpmInstallRan = @($bootLines | Where-Object { $_ -match '(?i)pnpm install' }).Count
            errors = @($bootLines | Where-Object { $_ -match '(?i)error|failed|refus|timeout|timed out' }).Count
        }
    } else {
        $report['bootLogSignals'] = 'boot.log was never created'
    }
    if (Test-Path -LiteralPath $runtimeManifestPath -PathType Leaf) {
        $report['runtimeManifest'] = Get-Content -LiteralPath $runtimeManifestPath -Raw | ConvertFrom-Json
    }
    $report['verified'] = ($report['ready'] -eq $true)
} catch {
    $report['failure'] = $_.Exception.Message
} finally {
    if ($desktop -and -not $desktop.HasExited) { try { $desktop.Kill($true) } catch { } }
    foreach ($entry in $hidden) {
        if (Test-Path -LiteralPath $entry.to) {
            if (Test-Path -LiteralPath $entry.from) { Remove-Item -LiteralPath $entry.from -Recurse -Force -ErrorAction SilentlyContinue }
            Move-Item -LiteralPath $entry.to -Destination $entry.from -Force -ErrorAction SilentlyContinue
        }
    }
    if (Test-Path -LiteralPath $installRoot) { Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
    $report | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $OutputPath -Encoding utf8NoBOM
}

Write-Host '=== boot.log tail ==='
if ($report['bootLogTail']) { $report['bootLogTail'] | ForEach-Object { Write-Host $_ } }
Write-Host "=== clean-host repro: ready=$($report['ready']) secondsToReady=$($report['secondsToReady']) windowSeen=$($report['windowSeen']) ==="
if (-not $report['ready']) { exit 1 }
