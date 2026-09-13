<#
.SYNOPSIS
Install an NSIS package on a disposable Windows Actions runner, then verify two native launches.
.DESCRIPTION
Run after NSIS packaging and before publication. Existing desktop processes, known-folder
data or installation registrations cause refusal. This does not validate Office or model calls.
PowerShell 7 and Node from the build job are reused. A visible main window is mandatory;
a runner without an interactive desktop fails instead of substituting a copied Host smoke.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Installer,
    [Parameter(Mandatory)][string]$PreparedRoot,
    [Parameter(Mandatory)][string]$ExpectedVersion,
    [Parameter(Mandatory)][string]$OutputPath,
    [ValidateRange(60, 1200)][int]$StartupTimeoutSeconds = 600
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Native installation acceptance runs only on disposable GitHub-hosted Windows runners.'
}
if (-not [Environment]::UserInteractive) { throw 'The runner has no interactive desktop; native window acceptance is unavailable.' }
if (-not $env:RUNNER_TEMP -or -not (Test-Path -LiteralPath $env:RUNNER_TEMP -PathType Container)) {
    throw 'RUNNER_TEMP must be an existing runner-owned directory.'
}

$Installer = (Resolve-Path -LiteralPath $Installer).Path
$PreparedRoot = (Resolve-Path -LiteralPath $PreparedRoot).Path
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$preparedManifest = Join-Path $PreparedRoot '.bundle-manifest.json'
if (-not (Test-Path -LiteralPath $preparedManifest -PathType Leaf)) { throw 'Prepared release manifest is missing.' }
$node = (Get-Command node -CommandType Application).Source
$appDataRoot = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'DeepSeek Harness'
$defaultDshHome = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh'
foreach ($path in @($appDataRoot, $defaultDshHome)) {
    if (Test-Path -LiteralPath $path) { throw "Refusing existing user data: $path" }
}
if (@(Get-Process -Name 'dsh-desktop' -ErrorAction SilentlyContinue).Count -ne 0) {
    # The shipped NSIS preinstall hook closes this executable by name.
    throw 'An existing desktop process makes NSIS installation unsafe.'
}
foreach ($registryRoot in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall')) {
    $existing = @(Get-ChildItem $registryRoot -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object {
        $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -eq 'ClawMaster'
    })
    if ($existing.Count -ne 0) { throw 'Refusing to replace an existing ClawMaster installation.' }
}

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ClawMasterNativeWindow {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
}
'@

function Start-OwnedProgram([string]$Path, [string]$Arguments, [string]$WorkingDirectory) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $Path
    $info.Arguments = $Arguments
    $info.WorkingDirectory = $WorkingDirectory
    $info.UseShellExecute = $false
    $info.Environment['DSH_HOME'] = $script:dshHome
    $info.Environment.Remove('DSH_DESKTOP_REPO') | Out-Null
    $info.Environment.Remove('DSH_DESKTOP_LAUNCH') | Out-Null
    foreach ($key in @($info.Environment.Keys)) {
        if ($key -match 'KEY|SECRET|TOKEN|PASSWORD') { $info.Environment.Remove($key) | Out-Null }
    }
    return [Diagnostics.Process]::Start($info)
}

function Wait-NativeReady([Diagnostics.Process]$Desktop) {
    $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $Desktop.Refresh()
        if ($Desktop.HasExited) { throw "Desktop exited before readiness with code $($Desktop.ExitCode)." }
        $window = $Desktop.MainWindowHandle
        $rect = [ClawMasterNativeWindow+Rect]::new()
        $mainVisible = $window -ne [IntPtr]::Zero -and [ClawMasterNativeWindow]::IsWindowVisible($window) -and
            [ClawMasterNativeWindow]::GetWindowRect($window, [ref]$rect) -and
            ($rect.Right - $rect.Left) -ge 800 -and ($rect.Bottom - $rect.Top) -ge 600
        if ($mainVisible -and (Test-Path -LiteralPath $script:runtimePath -PathType Leaf)) {
            $runtime = Get-Content -LiteralPath $script:runtimePath -Raw | ConvertFrom-Json
            if ($runtime.status -eq 'ready' -and $runtime.desktopPid -eq $Desktop.Id) {
                $hostInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($runtime.hostPid)"
                if (-not $hostInfo -or $hostInfo.ParentProcessId -ne $Desktop.Id) { throw 'Ready Host is not owned by this desktop.' }
                $hostProcess = Get-Process -Id $runtime.hostPid
                $response = Invoke-WebRequest -Uri "http://127.0.0.1:$($runtime.port)/" -SkipHttpErrorCheck -TimeoutSec 10
                return @{
                    host = $hostProcess
                    record = [ordered]@{
                        desktopPid = $Desktop.Id; hostPid = $hostProcess.Id; hostParentPid = [int]$hostInfo.ParentProcessId
                        desktopPath = $Desktop.MainModule.FileName
                        startedAtUnixMs = ([DateTimeOffset]$Desktop.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
                        windowHandle = $window.ToInt64(); windowVisible = $true
                        windowWidth = $rect.Right - $rect.Left; windowHeight = $rect.Bottom - $rect.Top
                        httpStatus = [int]$response.StatusCode; runtime = $runtime
                    }
                }
            }
        }
        Start-Sleep -Milliseconds 250
    }
    throw 'Timed out waiting for the installed main window and its ready runtime manifest.'
}

function Close-OwnedDesktop([Diagnostics.Process]$Desktop, [Diagnostics.Process]$HostProcess, $Record) {
    $Record['closeMainWindow'] = $Desktop.CloseMainWindow()
    if (-not $Record['closeMainWindow']) { throw 'The native main window did not accept a normal close request.' }
    $Record['desktopExited'] = $Desktop.WaitForExit(45000)
    if (-not $Record['desktopExited']) { throw 'Normal main-window close did not exit the desktop.' }
    $Record['hostExited'] = $HostProcess.WaitForExit(15000)
    if (-not $Record['hostExited']) { throw 'The owned Host survived normal desktop exit.' }
    $Record['stopped'] = Get-Content -LiteralPath $script:runtimePath -Raw | ConvertFrom-Json
    $Record['settingsMarkerPreserved'] = (Get-FileHash -LiteralPath $script:settingsPath -Algorithm SHA256).Hash -eq $script:settingsHash
}

function Remove-OwnedDirectory([string]$Path) {
    # WebView2 and antivirus can release Windows file handles after the desktop has exited.
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while (Test-Path -LiteralPath $Path) {
        try { Remove-Item -LiteralPath $Path -Recurse -Force; return }
        catch [IO.IOException], [UnauthorizedAccessException] {
            if ([DateTime]::UtcNow -ge $deadline) { throw }
            Start-Sleep -Milliseconds 250
        }
    }
}

$testRoot = Join-Path $env:RUNNER_TEMP ('ClawMaster native 验收 # ' + [Guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $testRoot 'installed'
$dshHome = Join-Path $testRoot 'dsh-home'
$runtimePath = Join-Path $dshHome 'desktop/current-runtime.json'
$settingsPath = Join-Path $dshHome 'settings.yaml'
$originalUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$ownedAppData = $false
$ownedTestRoot = $false
$desktop = $null
$ownedHost = $null
$installerProcess = $null
$report = [ordered]@{ schemaVersion = 1; platform = 'win32'; verified = $false; installRoot = $installRoot; appDataRoot = $appDataRoot; runs = @() }
try {
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    $ownedTestRoot = $true
    New-Item -ItemType Directory -Path $appDataRoot | Out-Null
    $ownedAppData = $true
    New-Item -ItemType Directory -Path $dshHome | Out-Null
    Set-Content -LiteralPath $settingsPath -Value "# Native acceptance $([Guid]::NewGuid())`n{}" -Encoding utf8NoBOM
    $settingsHash = (Get-FileHash -LiteralPath $settingsPath -Algorithm SHA256).Hash
    @(@{ id = 'clawmaster-notes'; config = @{ vaultRoot = (Join-Path $testRoot 'notes-vault') } }) |
        ConvertTo-Json -Depth 5 -AsArray | Set-Content -LiteralPath (Join-Path $dshHome 'cordis.patch.yml') -Encoding utf8NoBOM
    @{ closeAction = 'exit'; agentEnvironment = 'windows' } | ConvertTo-Json |
        Set-Content -LiteralPath (Join-Path $appDataRoot 'desktop-settings.json') -Encoding utf8NoBOM
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null

    # NSIS parses the remainder after /D= as the directory, without quotes; it must be last.
    $installerProcess = Start-OwnedProgram $Installer "/S /D=$installRoot" $testRoot
    if (-not $installerProcess.WaitForExit(600000)) { throw 'NSIS silent installation timed out.' }
    if ($installerProcess.ExitCode -ne 0) { throw "NSIS installation failed: $($installerProcess.ExitCode)." }
    $exe = Join-Path $installRoot 'dsh-desktop.exe'
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'The NSIS package did not install dsh-desktop.exe at the requested location.' }
    $report['installedProductVersion'] = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe).ProductVersion
    if ($report['installedProductVersion'] -ne $ExpectedVersion) { throw 'The installed executable has an unexpected product version.' }

    foreach ($attempt in 1..2) {
        Write-Host "Installed desktop native launch $attempt of 2"
        $desktop = Start-OwnedProgram $exe '' $installRoot
        $ready = Wait-NativeReady $desktop
        $ownedHost = $ready.host
        $record = $ready.record
        $report.runs += $record
        Close-OwnedDesktop $desktop $ownedHost $record
        $ownedHost.Dispose()
        $ownedHost = $null
        $desktop.Dispose()
        $desktop = $null
    }
    $observations = Join-Path $testRoot 'observations.json'
    $report | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $observations -Encoding utf8NoBOM
    & $node (Join-Path $PSScriptRoot 'windows-native-evidence.mjs') $observations $preparedManifest $ExpectedVersion $OutputPath
    if ($LASTEXITCODE -ne 0) { throw 'Native desktop evidence verification failed.' }
} catch {
    $report['failure'] = $_.Exception.Message
    if (Test-Path -LiteralPath (Split-Path -Parent $OutputPath)) {
        $report | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $OutputPath -Encoding utf8NoBOM
    }
    throw
} finally {
    # Process objects retain the created process handle; no lookup or name-based kill can hit a reused PID.
    foreach ($ownedProcess in @($desktop, $ownedHost, $installerProcess)) {
        if ($null -ne $ownedProcess) {
            if (-not $ownedProcess.HasExited) {
                $ownedProcess.Kill($true)
                if (-not $ownedProcess.WaitForExit(15000)) { throw 'An owned process did not exit during cleanup.' }
            }
            $ownedProcess.Dispose()
        }
    }
    if ($ownedAppData) {
        [Environment]::SetEnvironmentVariable('Path', $originalUserPath, 'User')
        Remove-OwnedDirectory $appDataRoot
    }
    if ($ownedTestRoot) { Remove-OwnedDirectory $testRoot }
}
