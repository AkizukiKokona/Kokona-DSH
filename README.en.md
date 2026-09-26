<p align="center">
  <img src="resources/brand.svg" alt="KokonaHarness" width="420">
</p>

<p align="center">
  <b>GitHub</b> ·
  <a href="https://github.com/AkizukiKokona/KokonaHarness/releases/latest"><img alt="GitHub release" src="https://img.shields.io/github/v/release/AkizukiKokona/KokonaHarness?label=release&sort=semver&color=4d6bfe"></a>
  <a href="https://github.com/AkizukiKokona/KokonaHarness/tags"><img alt="GitHub tag" src="https://img.shields.io/github/v/tag/AkizukiKokona/KokonaHarness?label=tag&sort=semver"></a>
  <a href="https://github.com/AkizukiKokona/KokonaHarness/releases"><img alt="GitHub downloads" src="https://img.shields.io/github/downloads/AkizukiKokona/KokonaHarness/total?label=downloads"></a>
  <a href="https://github.com/AkizukiKokona/KokonaHarness/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/AkizukiKokona/KokonaHarness?label=stars&color=e3b341"></a>
</p>

<p align="center">
  <b>Codeberg</b> (mirror) ·
  <a href="https://codeberg.org/AkizukiKokona/KokonaHarness/releases"><img alt="Codeberg release" src="https://codeberg.org/AkizukiKokona/KokonaHarness/badges/release.svg"></a>
</p>

<p align="center">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078d4">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green">
</p>

# KokonaHarness

[简体中文](README.md) | English

A DeepSeek Harness (`dsh`) desktop shell. Electron + a web-rendered core, with two things the
existing half-finished desktops don't give you:

1. **The core updates independently of the app.** The shell and the DSH core are versioned
   separately. Any installed core version lives in its own directory; you switch or roll back
   without reinstalling the app. A bundled baseline core makes first launch work offline.
2. **A custom dark titlebar.** Frameless window, no white OS caption. The window controls sit on
   the same 48px line as the app's own sidebar brand, and the drag surface only occupies genuinely
   empty pixels — so the app's controls and `dsh-better-sidebar` keep working untouched.

## Architecture

```
KokonaHarness (Electron shell)
  main/            app lifecycle, windows, IPC
    runtime/       core version manager (baseline + registry channels)
    core/          profile bootstrap + dsh process spawn + readiness probe
  preload/         window-control bridge + titlebar injection into the DSH page
  renderer/        boot screen + core-management panel (vanilla TS)

DSH core (@deepseek-ai/dsh)   <- installed per-version into <userData>/runtime/<version>
  booted as: node <bin> --profile kokona --no-open --port <free>
  data dir:  $DSH_HOME (default ~/.dsh, shared with the official client)
```

The core is never patched. We only spawn the public CLI under our own profile and inject a titlebar
overlay into the served page.

## Shell integrations

Injected into the DSH web page (never by patching the core):

- **Settings header actions.** DSH's settings panel renders the `settings.action` slot in its
  content-column header (the seat that holds the built-in "open configuration file" button).
  KokonaHarness appends two sibling buttons there, styled by cloning the existing button's classes:
  - **DSH 终端** — opens the platform terminal at `DSH_HOME` with the active core's
    `node_modules/.bin` on `PATH`, so `dsh` is runnable immediately.
  - **重启菜单** — a dropdown: *重新加载界面* (`webContents.reload`), *重启* (stop + boot the core),
    *重启进安全模式*.
- **Settings "检查更新" tab.** A nav cell is injected into the settings nav; the panel has two sections:
  - **内核更新 (core)** — check the channel against npm, install a new core version, switch between
    installed versions, restart the core.
  - **外壳更新 (shell)** — check whether KokonaHarness itself has a new release. Codeberg first for China,
    GitHub first elsewhere (`updateSource` forces one). Releases only; when an update exists it offers
    an "open release page" button.
- **Safe mode** boots a sibling profile `<profile>-safe` created from the shipped `web` template,
  so no plugins load. It is the same mechanism the CLI documents as
  `dsh --profile rescue --from-default-profile web`.
- **Plugin market.** `dshmarket` ("DSH 可视化插件市场") is installed as a preset plugin.
- **Hides the leftover right-panel when the right sidebar is closed.** DSH keeps
  `[data-sidebar-right-panel]` mounted and visible after the right column collapses
  (`position:absolute`, anchored right against a 0-width `_rightbarCol`, `pointer-events:none`).
  Wallpaper-style plugins paint sidebar glass on it without checking the open state, leaving a
  translucent blur over the right half. KokonaHarness sets `display:none` on that panel while
  `_rightbarCol` has zero width, and restores it when expanded.

The window title is forced to `KokonaHarness` (`page-title-updated` is prevented), so the DSH page's own
document title never renames the window.

The settings anchors are structural, not hash-based: the actions container is the element whose class
ends in `_actions` immediately preceding the settings close button (`button[class*="_close"]`); the
nav list is `[class*="_navList"]` under the panel. React re-renders are covered by a
`MutationObserver` that re-injects.

## Titlebar (extension mode)

- Window is frameless on Windows/Linux; on macOS `titleBarStyle: 'hidden'` keeps the traffic lights.
- The injected overlay reads DSH's own `--dsh-frame-top-clearance` (48px) so controls line up with
  the sidebar brand.
- Dragging is done with multiple small drag segments computed from the actual layout: every
  interactive element in the top strip (buttons, the brand, `[data-slot]` chrome, better-sidebar
  controls) is excluded, so nothing is blocked.
- The window controls are pinned to the far right and never move. The app's own top-right utility
  clusters (`_headerUtilities` / `_headerCorner`) are slid left once with a `translateX` transform so
  the row reads `[app buttons][window controls]`. Only the outermost matching cluster is shifted
  (nested clusters are dropped, so nothing gets double-shifted), and the controls container is
  `pointer-events: none` (only the buttons capture events), so it never eats the app buttons' clicks.
- `dsh-better-sidebar` is untouched: we never reserve right-column width and never touch
  `--dsh-sidebar-height`.

## Requirements

- Node.js `^22.19.0 || >=24` on PATH (used to run the core). Install with
  `winget install OpenJS.NodeJS.LTS`.
- pnpm `>=11` on PATH for plugin management (`dsh plugin ...`). `npm i -g pnpm@11.7.0`.

## Develop

```sh
npm install
npm run dev          # electron-vite, hot reload for main/preload/renderer
npm run typecheck
npm run build
```

## Package

```sh
npm run prepare:baseline        # optional: vendor a core into resources/runtime-baseline
npm run dist                    # electron-builder -> release/
```

Without a bundled baseline the app installs the current channel version from npm on first launch.

## Boot splash and icon

While the core installs and starts, the window shows a splash: the app icon, the product name, and
the Windows 10 boot loader. The loader is a direct port of the `windows_10.css` demo: five dots, each
running one 4.8s multi-segment `rotate` keyframe (225°→945°, mixing `ease-out`/`linear`/`ease-in-out`)
staggered by 240ms, fading in at the start and out at 76% — that staggered fade is what makes the dots
appear to stream around the ring. When the core is ready the window navigates to the DSH page. If boot
fails, the error appears in the splash with a Retry button; **Details** reveals the live core log
(`kokona:logs`).

The splash follows DSH's own theme. The injected preload reads the DSH page's dark/light state and
reports it; the shell persists it as `lastTheme` and applies it to the splash on the next launch
(`<html data-theme="light|dark">`), falling back to the system preference before DSH has ever been
seen.

The icon lives at `resources/icon.png` (512×512) and is also imported by the renderer for the splash
(`src/renderer/src/assets/kokona.png`). `electron-builder` converts it to `.ico` for Windows and uses
it for macOS/Linux too. To replace it, drop a square PNG at both paths (or re-run the conversion
from a JPG with `System.Drawing` on Windows).

## Window and tray

The window is frameless. Closing it (the custom close button or the OS) **hides** it instead of
quitting, so the core keeps running and long tasks continue. A tray icon stays resident:

- **left-click** — show and focus the main window
- **right-click** — menu: `显示主界面` / `退出`

Quitting from the tray stops the core and exits. `window-all-closed` never quits on its own; the
`before-quit` path is the only shutdown, and it kills the core process tree first.

## Config

`<userData>/config.json`:

| key | default | meaning |
| --- | --- | --- |
| `channel` | `beta` | `beta` -> npm `next` (0.1.7-rc.2, the plugin ecosystem's version), `stable` -> npm `latest` (0.1.5-rc.3) |
| `profile` | `kokona` | DSH profile (the reserved `desktop` profile is not used); safe mode uses `kokona-safe` |
| `port` | `19387` | preferred port; falls back to a free one |
| `dshHome` | `null` | `null` -> `~/.dsh` (shared with the official client) |
| `nodePath` | `null` | explicit Node executable |
| `presetPlugins` | `["dsh-better-sidebar","dshmarket"]` | installed into the profile on first boot |
| `titlebar.height` | `48` | fallback when the app var is missing |
| `titlebar.controls` | `custom` | `custom` on Win/Linux; macOS uses traffic lights |
| `titlebar.insetRight` | `0` | extra left-padding for the controls (auto-avoids app controls) |
| `lastTheme` | `null` | last DSH theme seen (`dark`/`light`); drives the splash theme |
| `updateSource` | `auto` | shell update source: `auto` (locale/timezone, Chinese -> Codeberg) / `codeberg` / `github` |

## Shortcuts

- `Ctrl/Cmd + Shift + K` — toggle the core-management panel.

## Core updates

The settings **检查更新** tab (or `Ctrl/Cmd + Shift + K`) lists installed core versions. `检查更新`
resolves the channel against the npm registry; `安装` drops the new version into its own directory;
`使用` switches the active pointer and restarts the core. Nothing about the app binary changes.

- Installs are **atomic**: the core is installed into `<version>.installing` and only renamed into
  place on success, so an interrupted install can never leave a half-empty version directory.
- If the active version's files are incomplete, it is reinstalled directly from the pinned version —
  **no registry lookup** — so a repair never hangs on the network.
- Registry lookups have an 8s timeout.
- Switching restarts the core. If the new core does not become ready (e.g. the profile's plugins were
  built for a different core version — `dsh-better-sidebar` needs `0.1.7-rc.2`, not `0.1.5-rc.3`), it
  **auto-rolls back** to the previous version and reports it. A failed boot shows the splash with the
  error and a Retry button instead of leaving a dead page on screen.
