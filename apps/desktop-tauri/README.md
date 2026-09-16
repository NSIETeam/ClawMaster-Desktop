# ClawMaster Desktop (Tauri)

English | [中文](README.zh.md)

ClawMaster's Rust/WebView shell over the existing `dsh web` runtime. The installer ships **harness source** without `node_modules`; first run scans the host for compatible Node.js and pnpm installations and an existing `~/.dsh` home, downloads missing Node.js or pnpm, then installs production dependencies against the bundled tree. Application metadata, the splash, notifications, and Web UI use the ClawMaster name, icon, and slogan “开启AI时代的企业协作”.

Desktop package version: **0.2.0-beta.6**. `build:harness` selects the ClawMaster client profile, sets the browser title before plugins load, and projects the existing product icon into the built favicon and PWA manifest. It records the resulting client digest; packaging rejects a different title, profile, manifest name, icon, or digest. Upstream Web asset sources retain their default branding.

The Tauri package is `@deepseek-ai/dsh-desktop-tauri`, independent of upstream Electron. The Host launch URL passes only in memory to a separate WebView, where upstream authentication issues the login cookie. Application commands belong to the local shell; loopback Host content receives only window dragging and double-click maximization permissions. Boot logs omit the launch token. The trimmed bundle includes `native/system` and permits unused development-tool patches only in that tree; patch application failures still stop installation.

## Architecture

| Layer | What ships | First run |
|---|---|---|
| **Installer** | Tauri binary + splash + trimmed monorepo slice (`bundled/harness/`) | — |
| **Build env** | — | Reuse host Node 22.19+ or 24+ and pnpm when present; otherwise Node (npmmirror) and pnpm (via npm + npmmirror registry) |
| **Dependencies** | — | `pnpm install --prod --no-frozen-lockfile` in the platform application-data directory (trimmed bundle vs lockfile; `CI` unset so pnpm does not force frozen install) |
| **Host** | — | `node apps/cli/lib/bin.js web --host 127.0.0.1`; a loader plugin that fails at start is disabled and the Host is retried |
| **UI** | Native window decorations and local `shell.html` close dialog | A child WebView embeds `dsh web`; macOS uses an overlay with hidden title text and reserves room for native traffic lights. The system owns window appearance; Web settings own the embedded client theme |
| **Tray** | Native tray icon | First close asks minimize-to-tray vs quit and remembers the answer in `desktop-settings.json`; tray can change that later, show the window, install the Sakana plugin catalog (`dsh plugin --profile web add github:Sakana-yuyu/dsh-plugins` into the live Host home), check for updates, restart, or quit. Restart and Quit stop the Host Node process tree; Restart then relaunches the desktop process. A successful catalog install restarts the same way so the catalog loads. Minimize-to-tray leaves the Host running |
| **Notify** | Overlay plugin + localhost POST | `turn/end` with `completed` shows a toast and plays `sounds/complete.wav` when the window is unfocused |
| **Updates** | No automatic-update endpoint configured | Startup sends no update requests; the tray reports that the ClawMaster update channel is unconfigured. The release public key is bundled; configuring its matching HTTPS endpoints enables signed updates |
| **Agent environment (Windows)** | Windows (default) or WSL | Tray sets `desktop-settings.json`; WSL starts Linux `dsh web` in the default WSL2 distro; restart required |

Windows desktop ships one installer, one desktop binary, and one Web client (`dsh web` in the WebView); this is not a second SKU and not a second Web UI. The tray Agent environment toggle only chooses where the Host process runs: Windows Node with pwsh, or Linux Node with bash inside the default WSL2 distro. Switching is operational, not a second codebase: restart is required; Windows keeps the isolated desktop home while WSL uses the distro `~/.dsh`; sessions are not shared; credentials and `.env` are copied once into the Linux home when both files are missing there. A second installer or forked Web client would duplicate the updater, overlay, homes, and CI and is not shipped. In WSL mode, workspace browse uses Linux paths such as `/mnt/d/...` for a Windows drive; `packages/` is unchanged; if Docker Desktop is the default distro, set an eligible WSL2 distro with `wsl --set-default`.

The bundled tree includes built `apps/cli/lib` and `apps/web/dist`, `packages/*/*` excluding examples and test-support, `native/system`, `vendor/*`, patches, and the production lockfile. Copying excludes dependency and development directories even when the copy root itself is `node_modules`; workspace `devDependencies` are stripped without rewriting the immutable Office runtime or its corresponding sources. `assertPreparedBundle` rejects excluded directories, symbolic links, and payload digests that differ from the prepared manifest before the tree can ship.

The installation includes the built `frontends/dsh` package and the exact plugin versions below. Native and WSL launches preload [desktop-defaults.mjs](scripts/desktop-defaults.mjs) before `dsh web`, validate artifacts, and append missing Web profile bundles while preserving existing dependencies and user patches. Native launch requires an absolute preload path, converts it to a `file:` URL, and reports conversion failure before starting Node; the [preload decision](../../.agents/notes/implemented/bug-fix/2026-09-13-desktop-node-preload-file-url.md) explains the Windows and filename-encoding requirements. Source-checkout `dev:local` skips this installation-specific preload. Installed plugins reuse the current DSH workspace dependencies, preventing prerelease peer ranges from installing another core version.

| Plugin | Desktop default |
| --- | --- |
| `@xmanrui/dsh-im@4.20.0` | Platform login and IM settings with fixed ClawMaster client and Host copy; connections require actual account login. |
| `dsh-better-sidebar@0.19.1` | Document, browser and terminal panels with fixed native-tab compatibility and localized ClawMaster copy. |
| `@nanmicoder/dsh-agent-teams@0.1.17` | Team tools and panel; members use DSH model settings. |
| `dsh-routing-suite@0.1.2` | Installs the Smart routing preset; selecting it adds task guidance without switching models. |
| `@openviking/dsh-memory-plugin@0.3.0` | Installed with the memory runtime disabled; enable after configuring a separate OpenViking service. |

WatchDog is the product's left navigation entry; its tool shortcuts open the editor, browser and terminal. CSV/TSV processing is built into the AI tools, with no separate data-processing page. CRM and ERP are optional right-side components for reviewing records and manual changes: in Settings → Side card → Sidebar content, enable the component, open Feature settings, then choose Open in sidebar. Registration opens no tab and creates no Workspace. An explicit open reuses the current non-archived Session or lazily creates a Session in the shared WatchDog Desk workspace; the native tab can be closed and reopened. The [frontend README](../../frontends/dsh/README.md) owns the AI tool and business-data behavior.

Routing preset files are copied only when absent under `$DSH_HOME/.agent-presets/routing-suite`, preserving user edits. Fixed [Routing](patches/dsh-routing-suite@0.1.2.patch) and [OpenViking](patches/@openviking__dsh-memory-plugin@0.3.0.patch) compatibility patches use current DSH Session Projections to reconstruct history; OpenViking also preserves request-series markers. Patches are hashed installation inputs, and patch failures stop installation.

The fixed [IM patch](patches/@xmanrui__dsh-im@4.20.0.patch) uses ClawMaster in client and Host product copy, connection status, approvals, questions, errors, setup display names, and the Slack application template. The IM header uses the product slogan. Better Sidebar localizes product copy in its supported dictionaries; Agent Teams, OpenViking, and Routing Suite use branded package descriptions. The IM Host artifact changes only source-matched static string literals. [IM provenance](patches/dsh-im@4.20.0.provenance.json) and [Sidebar provenance](patches/dsh-better-sidebar@0.19.1.provenance.json) bind sources and artifacts to the patches. Package identifiers, DeepSeek model-provider names, protocol fields, credential paths, licenses, and user or model text remain intact; no page-wide text replacement runs.

The fixed [Better Sidebar patch](patches/dsh-better-sidebar@0.19.1.patch) retains browser URL, title and back/forward history through the public tab update API. Native records use both Session and tab identity, survive temporary unmounts, and release state when the native tab's lifetime signal aborts. The [right Sidebar](../../packages/client/ui-sidebar-right/README.md#the-expand-button) keeps the current Session's docked and floating content mounted during global-panel visits, preserving unsaved editor text and iframe documents while hidden. Save before switching Sessions, closing a tab or quitting; retained browser navigation is not saved editor content.

The [Office component](../../frontends/office/README.md) supplies local ONLYOFFICE viewers for basic DOCX, XLSX, and PPTX editing and saving through the existing sidebar. A conflicting save preserves changed disk content. Complex layouts, macros, encrypted files, and legacy formats remain outside acceptance. The viewer retains legal notices and corresponding-source access; its README owns file limits, runtime preparation, and licensing.

### IM workspaces and bundled packages

Desktop preparation creates the persistent directory `$DSH_HOME/watchdog-workspaces/im` without registering a default DSH Workspace. The [desktop policy](defaults/cordis.patch.yml) supplies that directory through `config.weixin.workspace`, `config.feishu.workspace`, `config.dingtalk.workspace` and `config.wecom.workspace` on `xmanrui-dsh-im`. The plugin registers the Workspace when a conversation needs it. Existing bots retain their saved workspace; change it through Settings → IM Bots → the bot's Workspace selector. The selector clears that bot's chat bindings and preserves old Sessions and files; subsequent messages use the selected workspace. This fixed directory does not allocate a new task directory per message.

User patches apply last. DSH replaces the IM entry's `config` shallowly rather than deeply merging the channel objects, so a user-supplied `config` must include every channel default the deployment needs. Preparation preserves that user configuration and existing directory contents.

An explicit profile-installed IM package takes precedence over the bundled patched package, even when both report version `4.20.0`. The release operator verifies this transition against the installed desktop:

1. Quit ClawMaster normally and privately back up the selected `$DSH_HOME/profiles/web`, `$DSH_HOME/integrations/dsh-weixin`, `$DSH_HOME/.credentials.yaml` and `$DSH_HOME/storages/workspace.json`; preserve any other connected channel directories under `integrations`.
2. With the desktop's `dsh` command and the same `DSH_HOME`, run the supported removal below. It removes the profile dependency and bundle registration; it does not remove IM accounts or Session data.
3. Start the packaged desktop. Its preload restores the installation-owned IM bundle. Verify that profile resolution reaches the installed runtime's patched client and Host and that both SHA-256 values match `patchedSha256["lib/client.js"]` and `patchedSha256["lib/index.js"]` in the bundled IM provenance; version equality alone is insufficient.
4. Check the existing bot's connection and workspace in IM settings. Restoring the private profile and integration backup after quitting provides the rollback path.

```sh
dsh plugin --profile web remove @xmanrui/dsh-im --config.ignore-scripts=true
```

<a id="optional-local-openviking-service"></a>
### Optional local OpenViking service

The installation layer `@clawmaster/dsh-desktop-policy` disables `openviking-memory-runtime` by default while retaining its plugin inventory entry. Memory requires a separately configured [OpenViking service](https://docs.openviking.ai/en/agent-integrations/17-dsh). The macOS [local deployment helper](scripts/openviking-local.py) prepares it outside the application under `~/Library/Application Support/ClawMaster/OpenViking` by default; it does not change DSH profiles or `~/.openviking`.

| Helper command | Operation |
| --- | --- |
| `prepare` | Creates a private deployment, installs pinned Python packages and the embedding model, and writes a launchd job draft without loading it. Existing managed files must match; differing files are preserved and rejected. |
| `serve` | Runs the authenticated server in the foreground. The launchd job uses this command and owns the independent daemon when explicitly loaded. |
| `doctor` | Runs OpenViking diagnostics with the managed configuration and redacts credential values from its output. |
| `provision` | Uses the authenticated API to create the dedicated `clawmaster` account and `watchdog` USER credential, then writes `config/ovcli.conf`; an existing client key is checked and preserved. |

The helper pins OpenViking `0.4.19` and `llama-cpp-python` `0.3.35`, verifies the embedding model's SHA-256, and uses local 512-dimensional `bge-small-zh-v1.5-f16` embeddings. Storage and embedding run locally; text summarization uses the configured DeepSeek model, defaulting to `deepseek-flash`. At each start, the runner reads `refs.DEEPSEEK_API_KEY` from the selected DSH credential file, defaulting to `~/.dsh/.credentials.yaml`, and injects it into the server process environment. The server configuration contains environment references; the launchd job contains no credential values. The service binds to `127.0.0.1:1933` by default with API-key authentication and has a separate private root credential.

The OpenViking server is distributed under AGPL-3.0; the DSH memory plugin is Apache-2.0. The helper installs the server into a separate local environment, outside the Tauri payload. The integration plugin's license does not replace the server's license.

After provisioning, give the DSH Host `OPENVIKING_CLI_CONFIG_FILE` pointing to the private deployment's `config/ovcli.conf`, merge the following into `$DSH_HOME/profiles/web/cordis.patch.yml`, and restart. The plugin uses the USER credential, not the server root credential. Preparing files or observing an authenticated healthy server does not establish desktop memory capture or recall; those require an enabled client connection and a cross-Session workflow.

```yaml
- id: openviking-memory-runtime
  disabled: false
  config:
    endpoint: http://127.0.0.1:1933
```

When enabled, upstream defaults capture user and assistant messages, excluding tool results; unreachable requests enter a local replay queue. `syncTurns: false` stops new message capture but can still replay queued requests and commit sessions. Use plugin `disabled: true` to stop it completely. User profile patches apply after the desktop policy, preserving an explicit enabled choice.

### Mirrors (override via env)

| Variable | Default |
|---|---|
| `DSH_NODE_MIRROR` | `https://npmmirror.com/mirrors/node` |
| `DSH_NPM_REGISTRY` | `https://registry.npmmirror.com` |

### Dev vs production

| Mode | Env | Behavior |
|---|---|---|
| **Local dev** | `DSH_DESKTOP_LAUNCH=local` | Use monorepo checkout + PATH `node`/`pnpm`; skip mirror fetch |
| **Production** | (default) | Copy `harness-source` from installer → app data → mirror install → boot |

Writable paths live in the `DeepSeek Harness` directory under the platform data directory resolved by `dirs::data_dir()` (`%APPDATA%\DeepSeek Harness` on Windows and `~/Library/Application Support/DeepSeek Harness` on macOS; Linux also appends `DeepSeek Harness` to its platform data directory):

- `harness-versions/<bundle-hash>/` — bundle-specific source + `node_modules` after first `pnpm install`
- `runtime/` — Node, pnpm-global, manifest
- `dsh-home/` — fallback session data when no existing Harness home is found
- `bin/` — spawnable `dsh.exe` / `dsh.cmd` / `pnpm.cmd` written onto the Host PATH and, when missing, the user Path
- `cache/` — downloaded Node zip or tarball

First launch scans the process `PATH` (on Windows, plus the durable user and machine Path) and well-known install locations for Node `^22.19 || >=24` and a usable pnpm before any mirror fetch. It then adopts `$DSH_HOME` (process or, on Windows, the user/machine environment) or `~/.dsh` when that directory already holds sessions, credentials, `.env`, profiles, or settings, and copies missing files from the isolated `dsh-home/` into the selected home. It writes spawnable `dsh` / `pnpm` shims (`dsh.exe` is the desktop binary running as a CLI trampoline) and prepends the selected Node / pnpm directories (plus Git `cmd`/`bin` when `git` or `bash` is missing on that discovery PATH) onto the Host PATH so in-app `spawn('dsh')`, `dsh plugin`, MCP `npx`, and agent `bash`/`git` lookups resolve. Windows does not write an extensionless `dsh` file. Windows Host and CLI children do not allocate a console when the parent has no visible console. The user Path receives the shim directory via the registry, and the Node or pnpm directory only when that command is still absent as a spawnable file. The provisioner still downloads Node for Windows x64/x86, macOS x64/arm64, and Linux x64/arm64 when the scan finds none. Zip and tar.gz extraction reject entries outside the expected Node archive root. Unix archives retain executable permissions. A privately installed pnpm runs through the selected Node binary; a host pnpm is invoked directly. Bundle-specific harness directories let an update provision new source without deleting files used by an older running Host; compatible Node and pnpm runtimes are reused across source updates. The bundled workspace file is derived from the repository's `pnpm-workspace.yaml` with package membership trimmed and unused development-tool patches permitted. When provisioning fails, the app reuses the newest harness tree whose dependencies are installed; install and download steps have deadlines, and cleanup retains the three newest harness trees plus registered Workspace directories. The native shell permits one application instance and focuses the existing window on repeated launches. On macOS, reopening from the Dock or Finder shows and focuses the existing window hidden by the close preference, without starting another Host. Release builds with a configured update channel check after the main window opens; update-network or manifest failures are logged and do not hold the splash. A ready runtime manifest skips the host toolchain scan and compares Node by file size instead of hashing `node.exe`. Window chrome, tray, updater, toast, and completion sound stay in this Rust crate. Host collaboration is an overlay plugin copied into `$DSH_HOME/desktop-overlay` and loaded with `dsh web --patch`; `packages/` is not modified.

Cleanup reads `storages/workspace.json` from the selected DSH home. A runtime directory is retained when it equals, contains, or lies inside a registered Workspace path; resolved filesystem aliases receive the same protection. A missing registry permits a new installation. An existing unreadable registry, unsupported unit version, or invalid path stops automatic cleanup with a diagnostic that omits stored values. Dependency repair and source reseeding refuse to replace a protected or uncertain directory, preserving its files and runtime manifest for manual recovery.

## Build

macOS requires 11.0 or later, matching the provisioned Node.js 22.19 runtime and native addon target. Linux release builds install `musl-tools` and run the complete `native/system` native build to include the static Landlock launcher and both libc addon variants; the root addon-only source-test build is insufficient. Landlock also needs an enforcing kernel; its functional probe, rather than the kernel version alone, determines availability. See the [native support matrix](../../native/system/docs/support-matrix.md).

From the repo root (needs built CLI + web dist). Release signing material is supplied through `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` by the release owner:

```powershell
pnpm --dir apps/desktop-tauri run build:harness
cd apps/desktop-tauri
pnpm install
pnpm run build:win
```

Installer output: `src-tauri/target/release/bundle/nsis/ClawMaster_0.2.0-beta.6_x64-setup.exe`

The NSIS installer bundles **English**, **Simplified Chinese**, and **Traditional Chinese**. Language follows the OS locale automatically (no language picker); if the locale is unsupported, English is used. Native splash, tray, close-dialog, and splash-status copy follow the same rule (`zh*` → Chinese, otherwise English). The embedded `dsh web` client keeps its own Settings language. Before copying files, the installer silently closes `dsh-desktop.exe` and its child process tree. After installation, it recreates an existing desktop shortcut with the versioned standalone ICO resource and notifies Explorer to invalidate stale icon cache entries.

## Release

The release matrix includes Windows x64, macOS Apple Silicon, and Linux x64. ClawMaster no longer publishes an Intel Mac installer; Intel Mac users must keep their existing version or migrate to a supported platform.

Pushing a `desktop-v*` tag runs [the desktop release workflow](../../.github/workflows/desktop-release.yml). It builds Windows x64 NSIS installers, macOS Intel/Apple Silicon DMGs, and Linux x64 AppImage/deb packages, then publishes one prerelease after every matrix job succeeds. Each updater artifact carries a Tauri signature; the versioned release includes `latest.json`, `clawmaster-release-signing.pub`, and `SHA256SUMS.txt`. The workflow uses ad-hoc macOS application signing and verifies the resulting bundle, without Apple notarization or Windows publisher signing. A manual dispatch rebuilds an existing matching tag. The default application includes the release public key but leaves `plugins.updater.endpoints` empty, so it sends no update requests and these prereleases do not automatically replace installed applications. Release owners must configure a ClawMaster-controlled HTTPS manifest matching that key to enable updates; nonempty endpoints without a public key return an error.

Release assets belong to the public [ClawMaster-Desktop repository](https://github.com/NSIETeam/ClawMaster-Desktop/releases) and include the operating system and architecture in their names. Tauri updater signatures authenticate downloaded artifacts with the configured updater key. macOS ad-hoc signing checks bundle integrity without certifying a developer identity; it does not include Apple notarization. Windows packages have no publisher certificate.

The transparent [light SVG](../../frontends/dsh/src/clawmaster.svg) and [dark SVG](../../frontends/dsh/src/clawmaster-dark.svg) share one outline, rendered in black and white respectively. The application selects the icon from its resolved Web theme; the splash follows the system appearance. The Web favicon preserves the light SVG bytes. The [icon generator](scripts/generate-icons.mjs) creates native icon formats from the light vector source during desktop preparation, sorting ICNS entries by type while preserving their encoded images. Desktop branding verification rejects embedded or linked images inside the SVG. The [original PNG](../../frontends/dsh/src/clawmaster.png) remains a visual reference. macOS hides native title text; the shell draws no separate title row. Windows installation also includes a version-qualified ICO file so shortcut icon lookup does not reuse an older executable-path cache key.

[Build provenance](scripts/build-provenance.mjs) binds the complete harness build and product preparation to a full Git commit, committed tree, working-source SHA-256 and relative dirty-file list. Preparation rejects source changes or replaced Host, client and frontend artifacts after compilation. The default `development` mode produces an explicit development build ID, including `dirty` when source differs. `DSH_DESKTOP_BUILD_MODE=release` requires clean source and release-mode records throughout the workflow. Generated native icon files are verified build outputs rather than source inputs; their platform encoders can change bytes without changing the SVG. A source change requires another complete `build:harness` before `prepare:dist`.

The payload's `.bundle-manifest.json` includes `desktopVersion` and `buildProvenance`; the matching `.build-provenance.json` participates in `contentSha256`. The installer carries these records without `.git`. Each platform's `*-build.json` release attachment identifies its source and artifacts, and publication checks its commit, tree, version and clean release mode against the tag. The provenance checks run in `test:bundle`.

Prepare the payload without compiling the native shell, after `build:harness` and Office resource preparation:

```powershell
node scripts/prepare-dist.mjs
```

## Run

**Dev (monorepo checkout):**

```powershell
# repo root: pnpm --dir apps/desktop-tauri run build:harness  (once)
cd apps/desktop-tauri
$env:DSH_DESKTOP_LAUNCH='local'
pnpm run dev
```

**Installed app:** use the package for your system from GitHub Releases. First launch shows the splash while it scans the host, selects an existing DSH home, and installs missing tools or dependencies before opening the Web UI.

## Scripts

The native Host writes `$DSH_HOME/desktop/current-runtime.json` after readiness and marks its own record stopped on normal exit. The record includes the bundle digest, source provenance, process identity and observation time; provisioning metadata and memory entries are not live-state authorities. The frontend's `runtime_status` tool reads this file afresh and requires the current Host PID, refusing stopped, missing or malformed records. Historical observations retain their dates. Empty unregistered generation directories do not consume the three rollback slots; registered Workspace directories remain protected. WSL and source-development launches do not publish this native identity record.

| Script | Purpose |
|---|---|
| `scripts/bundle-harness-source.mjs` | Trim + copy monorepo slice → `bundled/harness/` |
| `scripts/prepare-dist.mjs` | Splash dist + bundle (Tauri `beforeBuildCommand`) |
| `scripts/serve-dist.mjs` | Static server for `tauri dev` splash |
| `scripts/openviking-local.py` | Explicit macOS preparation, serving, diagnostics and USER credential provisioning for an external local OpenViking service |
| `overlay/desktop-notify/` | Cordis overlay: POST completed turns to the native notify port |

Startup regression: copy the trimmed bundle to a temporary directory, install production dependencies there, set DSH_DESKTOP_SMOKE_ROOT to that directory, and run pnpm run test:startup. With a private home, it checks desktop plugin defaults, authentication, cross-origin write rejection, empty CRM/ERP data, lazy Workspace creation, and a CRM record retained after a Host restart on another port. It calls no model API.
