# AGENTS

KokonaHarness is an Electron shell around the public DeepSeek Harness (`@deepseek-ai/dsh`) CLI.

## Layout

- `src/main/` — Electron main. `runtime/` manages core versions, `core/` boots the CLI.
- `src/preload/index.ts` — context bridge + the titlebar injection (the important file).
- `src/renderer/` — vanilla TS boot screen and core panel. No framework.
- `src/shared/` — types, constants, the `KokonaApi` surface.

## Rules

- Never patch or fork the DSH core. Spawn the public CLI only.
- Do not use the reserved `desktop` profile; the CLI rejects it. KokonaHarness uses `kokona`.
- The titlebar must never block app interaction. Drag surfaces are computed as the gaps between
  interactive elements, never a full-width overlay.
- Do not touch `--dsh-sidebar-height` or reserve right-column width; that belongs to better-sidebar.
- Settings header buttons go into DSH's own `settings.action` slot. Anchor structurally (class ends
  with `_actions`, preceding `button[class*="_close"]`); never by hashed class prefix.
- Safe mode must boot a plugin-free profile (`<profile>-safe` from the `web` template); never try to
  disable plugins by guessing loader entry ids.
- Closing the window hides it; the app stays resident in the tray. Never quit from
  `window-all-closed`. All shutdown goes through the `before-quit` path, which stops the core first.
- Keep the renderer dependency-free.

## Commands

```sh
npm run dev
npm run typecheck
npm run build
npm run prepare:baseline   # vendor a core into resources/runtime-baseline
npm run dist
```

## Verify

`npm run typecheck` must pass. `npm run build` must produce `out/main`, `out/preload`,
`out/renderer`. Manual smoke test: `npm run dev` should boot a core, show the dark titlebar over
the DSH page, and `Ctrl/Cmd+Shift+K` should open the core panel.
