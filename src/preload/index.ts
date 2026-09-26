import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { contextBridge, ipcRenderer, webFrame, type IpcRendererEvent } from 'electron'
import { IPC } from '../shared/constants'
import type { EditContextState, EditMenuEntry, KokonaApi, UpdateInfo } from '../shared/api'
import type { AppConfig, RuntimeSnapshot, ShellUpdateInfo, WindowState } from '../shared/types'

const api: KokonaApi = {
  snapshot: () => ipcRenderer.invoke(IPC.snapshot) as Promise<RuntimeSnapshot>,
  getConfig: () => ipcRenderer.invoke(IPC.getConfig) as Promise<AppConfig>,
  setConfig: (patch) => ipcRenderer.invoke(IPC.setConfig, patch) as Promise<AppConfig>,
  checkUpdates: () => ipcRenderer.invoke(IPC.checkUpdates) as Promise<UpdateInfo>,
  installCore: (version) => ipcRenderer.invoke(IPC.installCore, version) as Promise<string[]>,
  switchCore: (version) => ipcRenderer.invoke(IPC.switchCore, version) as Promise<void>,
  restartCore: () => ipcRenderer.invoke(IPC.restartCore) as Promise<void>,
  restartSafe: () => ipcRenderer.invoke(IPC.restartSafe) as Promise<void>,
  relaunchApp: (safe) => ipcRenderer.invoke(IPC.relaunchApp, safe) as Promise<void>,
  reloadUi: () => ipcRenderer.send(IPC.reloadUi),
  openTerminal: () => ipcRenderer.invoke(IPC.openTerminal) as Promise<void>,
  revealData: () => ipcRenderer.invoke(IPC.revealData) as Promise<string>,
  revealPath: (path) => ipcRenderer.invoke(IPC.revealPath, path) as Promise<void>,
  getLogs: () => ipcRenderer.invoke(IPC.logs) as Promise<string[]>,
  reportTheme: (theme) => ipcRenderer.send(IPC.reportTheme, theme),
  checkShellUpdate: () => ipcRenderer.invoke(IPC.checkShellUpdate) as Promise<ShellUpdateInfo>,
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url) as Promise<void>,
  editContext: (state) => ipcRenderer.invoke(IPC.editContext, state) as Promise<EditMenuEntry[]>,
  editAction: (action) => ipcRenderer.send(IPC.editAction, action),
  window: {
    minimize: () => ipcRenderer.send(IPC.windowControl, 'minimize'),
    maximize: () => ipcRenderer.send(IPC.windowControl, 'maximize'),
    unmaximize: () => ipcRenderer.send(IPC.windowControl, 'unmaximize'),
    toggleMaximize: () => ipcRenderer.send(IPC.windowControl, 'toggle-maximize'),
    close: () => ipcRenderer.send(IPC.windowControl, 'close')
  },
  onSnapshot: (callback) => {
    const handler = (_event: IpcRendererEvent, snapshot: RuntimeSnapshot) => callback(snapshot)
    ipcRenderer.on(IPC.snapshot, handler)
    return () => ipcRenderer.off(IPC.snapshot, handler)
  },
  onWindowState: (callback) => {
    const handler = (_event: IpcRendererEvent, state: WindowState) => callback(state)
    ipcRenderer.on(IPC.windowState, handler)
    return () => ipcRenderer.off(IPC.windowState, handler)
  }
}

contextBridge.exposeInMainWorld('kokona', api)

const HOST_ID = 'kokona-titlebar'
const STYLE_ID = 'kokona-titlebar-style'
const MENU_CLASS = 'kokona-menu'
const SETTINGS_ACTIONS_ATTR = 'data-kokona-actions'
const CLEARANCE_VAR = '--dsh-frame-top-clearance'
const FALLBACK_HEIGHT = 48
const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="tab"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="combobox"]',
  '[contenteditable="true"]',
  '[data-window-no-drag]',
  '[data-slot="sidebar.brand.mark"]',
  '[data-slot="sidebar.brand.name"]',
  '[data-slot="shell.leading"]'
].join(',')

interface Rect {
  left: number
  right: number
}

function isDshPage(): boolean {
  if (!/^https?:$/.test(location.protocol)) return false
  return location.hostname === '127.0.0.1' || location.hostname === 'localhost' || location.hostname === '[::1]'
}

function isDark(): boolean {
  const body = document.body
  if (body?.dataset.dsDarkTheme !== undefined) return true
  const root = document.documentElement
  if (root.dataset.dsTheme === 'dark') return true
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function clearanceHeight(): number {
  const nodes: Array<Element | null> = [
    document.documentElement,
    document.body,
    document.getElementById('root')
  ]
  for (const node of nodes) {
    if (!node) continue
    const raw = getComputedStyle(node).getPropertyValue(CLEARANCE_VAR)
    const value = Number.parseFloat(raw)
    if (Number.isFinite(value) && value > 0) return value
  }
  return FALLBACK_HEIGHT
}

function mergeIntervals(intervals: Rect[]): Rect[] {
  const sorted = [...intervals].sort((a, b) => a.left - b.left)
  const merged: Rect[] = []
  for (const interval of sorted) {
    const last = merged[merged.length - 1]
    if (last && interval.left <= last.right + 1) last.right = Math.max(last.right, interval.right)
    else merged.push({ ...interval })
  }
  return merged
}

function freeIntervals(width: number, blocked: Rect[]): Rect[] {
  const merged = mergeIntervals(blocked)
  const free: Rect[] = []
  let cursor = 0
  for (const interval of merged) {
    if (interval.left > cursor + 1) free.push({ left: cursor, right: interval.left })
    cursor = Math.max(cursor, interval.right)
  }
  if (cursor < width - 1) free.push({ left: cursor, right: width })
  return free
}

function controlButton(label: string, path: string, action: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute('aria-label', label)
  button.title = label
  button.dataset.kokonaControl = label
  button.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    action()
  })
  return button
}

function ensureShellStyle(theme?: 'dark' | 'light'): void {
  if (document.getElementById(STYLE_ID)) return
  const resolved = theme ?? (isDark() ? 'dark' : 'light')
  const symbol = resolved === 'dark' ? '#e6e6e6' : '#1b1b1f'
  const hover = resolved === 'dark' ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.07)'
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
#${HOST_ID} { position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647; pointer-events: none; user-select: none; -webkit-user-select: none; }
#${HOST_ID} .kokona-drag { position: absolute; top: 0; height: 100%; -webkit-app-region: drag; pointer-events: auto; }
#${HOST_ID} .kokona-controls { position: absolute; top: 0; right: 0; height: 100%; display: flex; align-items: stretch; -webkit-app-region: no-drag; pointer-events: none; }
#${HOST_ID} .kokona-controls button { width: 46px; height: 100%; display: inline-flex; align-items: center; justify-content: center; margin: 0; padding: 0; border: 0; background: transparent; color: ${symbol}; cursor: default; -webkit-app-region: no-drag; pointer-events: auto; }
#${HOST_ID} .kokona-controls button:hover { background: ${hover}; }
#${HOST_ID} .kokona-controls button[data-kokona-control="close"]:hover { background: #e81123; color: #fff; }
#${HOST_ID} .kokona-controls svg { display: block; }
.${MENU_CLASS} { position: fixed; z-index: 2147483647; min-width: 188px; padding: 6px; border-radius: 12px; background: var(--dsw-alias-bg-layer-2, #1d1d25); border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.12)); box-shadow: var(--dsw-elevation-prominent, 0 12px 32px rgba(0,0,0,0.45)); display: flex; flex-direction: column; gap: 2px; }
.${MENU_CLASS} button { text-align: left; border: 0; background: transparent; color: var(--dsw-alias-label-primary, #e8e8ee); font: inherit; font-size: 13px; line-height: 18px; padding: 8px 10px; border-radius: 8px; cursor: pointer; -webkit-app-region: no-drag; }
.${MENU_CLASS} button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.08)); }
.${MENU_CLASS} button.kokona-danger { color: var(--dsw-alias-state-warning-primary, #f0a020); }
html:not([data-theme="dark"]):not(:has(body[data-ds-dark-theme])) { --kokona-surface-soft: rgba(245, 246, 247, 0.72); --kokona-surface-glass: rgba(255, 255, 255, 0.72); --kokona-surface-chip: rgba(250, 250, 250, 0.72); --kokona-surface-selected: rgba(255, 255, 255, 0.95); --kokona-surface-float: rgba(255, 255, 255, 0.85); --kokona-surface-menu: rgba(255, 255, 255, 0.94); --kokona-selected-ring: rgba(0, 0, 0, 0.35); }
html[data-theme="dark"], body[data-ds-dark-theme] { --kokona-surface-soft: rgba(255, 255, 255, 0.07); --kokona-surface-glass: rgba(255, 255, 255, 0.07); --kokona-surface-chip: rgba(255, 255, 255, 0.07); --kokona-surface-selected: rgba(255, 255, 255, 0.16); --kokona-surface-float: rgba(58, 58, 60, 0.85); --kokona-surface-menu: rgba(58, 58, 60, 0.94); --kokona-selected-ring: rgba(255, 255, 255, 0.9); }
html [class*="_panel"]:has([class*="_navList"]) [class*="_rowCard"],
html [class*="_panel"]:has([class*="_navList"]) [class*="_cards"] > [class*="_card"] { background-color: var(--kokona-surface-glass) !important; }
html [class*="_panel"]:has([class*="_navList"]) [class*="_selector"],
html [class*="_panel"]:has([class*="_navList"]) [class*="_themeCube"],
html [class*="_panel"]:has([class*="_navList"]) [class*="_stepper"],
html [class*="_panel"]:has([class*="_navList"]) [class*="_switcher"],
html [class*="_panel"]:has([class*="_navList"]) [class*="_setting"] > [class*="_button"] { background-color: var(--kokona-surface-soft) !important; }
html [class*="_panel"]:has([class*="_navList"]) [class*="_themeCube"][class*="_selected"],
html [class*="_panel"]:has([class*="_navList"]) [class*="_themeCube"][aria-pressed="true"] { background-color: var(--kokona-surface-selected) !important; border-color: #ffffff !important; border-width: 2px !important; box-shadow: 0 0 0 1px var(--kokona-selected-ring), 0 6px 18px rgba(0, 0, 0, 0.18) !important; }
[class*="_newSession"]:not([class*="_newSession"] *) { background-color: var(--kokona-surface-glass) !important; }
[class*="_presented"] [class*="_file"]:not([class*="_file"] *) { background-color: var(--kokona-surface-chip) !important; }
[class*="_tools"] [class*="_add"]:not([class*="_add"] *) { background-color: var(--kokona-surface-float) !important; }
/* The composer's add menu (dsh-client-ui-commands) declares no background and no
   backdrop-filter at all - it is a shadow over whatever sits behind it, which is why its rows
   were unreadable. It gets the menu surface, a step more opaque than the floating one so the
   text sits on real ground. Anchored on _labelText together with _viewport, which only this
   card has. */
[class*="_card"]:has([class*="_labelText"]):has([class*="_viewport"]) {
  background-color: var(--kokona-surface-menu) !important;
  backdrop-filter: blur(calc(var(--we-blur, 16px) * 1.8)) saturate(calc(var(--we-saturate, 1.8) * 1.15)) brightness(1.03) !important;
  -webkit-backdrop-filter: blur(calc(var(--we-blur, 16px) * 1.8)) saturate(calc(var(--we-saturate, 1.8) * 1.15)) brightness(1.03) !important;
}
/* Inline code used to be painted here with a blanket code:not(pre code) chip.
   That also caught the <code> elements that are *labels* rather than code: the
   update panel's version strings, the Agent preset card's id, and the turn-error
   code chip — the SERVER you see in the failed-turn notice is
   MessageItem.turnErrorCode, a bare <code> with no radius of its own, so the
   blanket rule dropped a square translucent rectangle into a place that never had
   one. The shell already styles real inline code (.markdown :not(pre) > code in
   MarkdownText.module.css, with its own border and radius), so route its token
   instead and leave every other <code> alone. No per-element exceptions needed. */
/* 「已编辑 N 个文件」(dsh-client-ui-deliverables ChangedFiles) fills the card with
   the opaque --dsw-alias-bg-layer-1 and repaints the header with --changes-fill.
   Paint the card with the same glass as the 产物 rows and let the header show it
   through instead of adding a second layer. */
[data-changed-files] { background-color: var(--kokona-surface-glass) !important; --changes-fill: transparent !important; --changes-hover: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12)) !important; }
/* The 产物 hover preview — the card that pops off a file row showing its diff. Two solid
   layers stack here: HoverCard.module.css paints .card with a hard-coded --dsw-hovercard-bg
   (#2C2C2E dark, near-white light) and .preview with --dsw-alias-bg-layer-1. Because the card
   is position:fixed it renders outside [data-conversation-scroll], so neither the wallpaper
   tint nor the transcript's bg-layer-1 remap reaches it, and it lands as a solid slab over
   the glass. YG wants it translucent but a step whiter than the 产物 rows, so it still reads
   as floating above them. Anchored on data-diff-note, which is authored by the core and
   appears only inside such a preview, rather than on the hashed module class. */
[class*="_card"]:has([data-diff-note]),
[class*="_preview"]:has([data-diff-note]) { background-color: var(--kokona-surface-float) !important; }
/* Every code surface — markdown code blocks, the edit/diff block, tool IO cards,
   the skill card — fills with --dsw-alias-markdown-code-block, an opaque
   near-white in the light theme. Route it to the same chip the 产物 cards use.
   --dsw-alias-markdown-inline-code is the inline-code counterpart (#fafafa) and is
   only consumed by markdown content, so remapping it here replaces the deleted
   blanket rule without touching anything that merely happens to be a <code>. */
body { --dsw-alias-markdown-code-block: var(--kokona-surface-chip) !important; --dsw-alias-markdown-inline-code: var(--kokona-surface-chip) !important; }
/* Three components repaint that fill on a nested node: the code card's toolbar
   header, the code block's sticky banner, and the code block's <pre>. Two 0.72
   layers stack back into near-white, so drop the inner repaint and let the card
   underneath show through. */
[data-code-block-banner],
[data-code-block-content] pre,
[class*="_instructionsCard"] > [class*="_instructionsHeader"] { background-color: transparent !important; }
/* The settings dialog is the one scope the wallpaper plugin re-tints, and it only
   remaps bg-layer-1/2/3 — --dsw-alias-bg-module-platform stays an opaque #f5f6f7
   (light) / #2c2c2e (dark). Everything inside the dialog that reads it therefore
   shows as a flat slab: the Agent preset cards' default and disabled states, the
   neutral tags, the chat preference rows, the model and permission selectors.
   Route the token through the same glass the neighbouring surfaces use. */
html [class*="_panel"]:has([class*="_navList"]) { --dsw-alias-bg-module-platform: var(--kokona-surface-glass); }
/* A Tag with tone=solid paints --dsw-alias-label-primary (near-black in the light
   theme) and writes its label in --dsw-alias-bg-layer-3, which the plugin turns
   translucent — the text all but disappears into the capsule. Use the selected
   surface and an explicit readable label instead. */
html [class*="_panel"]:has([class*="_navList"]) [data-tone="solid"] { background-color: var(--kokona-surface-selected) !important; color: var(--dsw-alias-label-primary) !important; border: .5px solid rgba(255, 255, 255, 0.7) !important; }
/* The Agent preset card marked as the current default (li[data-agent-preset-id])
   fills with that same opaque token, so it reads as a dark slab while every other
   card picks up the glass. Mark the choice exactly the way the 深浅色/自动 cubes
   mark theirs, so the two selectors speak one language. */
html [data-agent-preset-id][class*="_cardActive"] { background-color: var(--kokona-surface-selected) !important; border-color: #ffffff !important; border-width: 2px !important; box-shadow: 0 0 0 1px var(--kokona-selected-ring), 0 6px 18px rgba(0, 0, 0, 0.18) !important; }
/* A card the current build cannot select (dev tools off) shares that token but is
   not a selection — keep it a plain translucent surface. */
html [data-agent-preset-id][class*="_cardSelectionDisabled"] { background-color: var(--kokona-surface-soft) !important; }
/* 「加载更早」 (ChatView _older) fills its button with
   --dsw-alias-interactive-bg-hover-solid, an opaque near-white; it only looks
   translucent while loading because the disabled state drops to opacity .6. */
[class*="_older"] > button { background-color: var(--kokona-surface-glass) !important; }
/* The scroll-to-bottom pill fills with --dsw-alias-button-floating-fill (opaque)
   and carries no backdrop blur. Same veil as the composer, and blur behind it so
   the transcript stays legible through the button. */
button[class*="_toBottom"] { background-color: var(--kokona-surface-glass) !important; backdrop-filter: blur(var(--we-blur, 16px)) saturate(var(--we-saturate, 1.8)); }
button[class*="_toBottom"]:hover { background-color: var(--kokona-surface-selected) !important; }
/* The compaction row (「上下文已压缩」). Collapsed it is an ordinary button on the
   transcript, but once expanded the core makes its header position:sticky with
   background: var(--dsw-alias-bg-base) and border-radius: 0 — an opaque base colour the
   wallpaper plugin never re-tints and the transcript remap above does not cover. That is the
   white rectangle riding over the glass.
   It is forced fully transparent rather than frosted: YG wants no plate under the header at
   all. The tradeoff is his call and it is real — the header is sticky, so content scrolling
   beneath it stays visible through the text instead of being masked. */
[class*="_compactionRow"]:has([class*="_compactionBody"]) [class*="_compactionButton"] {
  background: transparent !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  box-shadow: none !important;
}
[class*="_compactionRow"]:has([class*="_compactionBody"]) [class*="_compactionButton"]:hover { background: transparent !important; }
/* The code-block banner inside the expanded body is sticky too and carries the same opaque
   fill. data-code-block-banner is authored by the core rather than hashed. */
[class*="_compactionBody"] [data-code-block-banner] {
  background: transparent !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  box-shadow: none !important;
}
/* TurnTriggerNodeView — the attribution notice above a turn that is not from a
   human (webhook, goal, subagent, schedule) — is a <section data-turn-trigger>
   filled with --dsw-alias-markdown-code-block and outlined. NOT the same element as
   the SERVER chip (that was the turn-error <code> above); this one is a designed
   disclosure card. It is kept background-free because the chip token turned it into
   another white block in the transcript — restore the fill here if the card look is
   wanted back. */
[data-turn-trigger] { background-color: transparent !important; border-color: transparent !important; }
/* Everything else in the transcript that still fills with bg-layer-1: the turn
   preview tooltip, the subagent frame, the deliverables output block. Outside the
   settings dialog nothing re-tints that token, so they paint pure #fff over the
   wallpaper. Remap it for the transcript scope only — the settings dialog keeps the
   plugin's own (more specific) recipe. */
body[data-we-wallpaper] [data-conversation-scroll] { --dsw-alias-bg-layer-1: var(--kokona-surface-glass); }
/* The RIGHT column (better-sidebar's data-sidebar-right-panel) has its own
   wallpaper-engine knob set — 侧栏模糊 / 侧栏透明度 / 侧栏玻璃颜色 — and the live
   values (172px blur, a 24% tint, saturate 2.83) frost it into a sheet of mica
   with the wallpaper invisible behind it. YG likes the composer card, so the panel
   reuses exactly that recipe: the 玻璃 slider's blur radius (--we-blur), the
   composer's veil alpha (--we-glass-alpha * 0.8, the same number
   --dsw-specific-input-major is built from), the flat material saturation and the
   full-strength sheen. The panel's own tint colour stays, so it still reads as the
   sidebar and not as the composer. Scoped to the right panel on purpose: the left
   sidebar keeps the 侧栏 sliders. */
body[data-we-sidebar-glass] [data-sidebar-right-panel][data-sidebar-right-open] {
  --we-sidebar-blur: var(--we-blur, 16px);
  --we-sidebar-tint: calc(var(--we-glass-alpha, 0.2) * 80%);
  --we-sidebar-saturate: var(--we-saturate, 1.8);
  --we-sidebar-sheen: 1;
}
/* better-sidebar's bottom dock (the workbench that slides up from the bottom, and
   holds the terminal / browser / preview panes). Its own fill is
   background: var(--dsw-alias-bg-layer-1) — an opaque #fff, because the wallpaper
   plugin only re-tints that token inside the settings dialog, and the plugin never
   matches this class at all — so the dock was a solid sheet with the 侧栏 tint on the
   surfaces inside it. Reproduce the RIGHT panel's recipe verbatim instead: the log
   shows that panel computing to color(srgb .404 .863 .906 / .1648) — the 侧栏 colour
   at --we-sidebar-tint — with backdrop-filter blur(16px) saturate(1.3)
   brightness(1.04) contrast(1.01). Its blur radius is the composer's (--we-blur),
   because the tint slider is driven by the glass alpha, which is why the panel reads
   as frosted glass rather than as a cyan sheet. The colour itself is deliberately NOT
   overridden: at 16% over a blurred wallpaper it is the same tint the right panel
   has. A first attempt painted this with --kokona-surface-glass (a 0.72 chip veil)
   and went solid white — that value is for small chips, never a full-width panel. */
body[data-we-sidebar-glass] [class*="_bottomPanel"] {
  background-color: color-mix(in srgb, var(--we-sidebar-color, #ffffff) var(--we-sidebar-tint, 20%), transparent) !important;
  backdrop-filter: blur(var(--we-sidebar-blur, 16px)) saturate(var(--we-sidebar-saturate, 1.3)) brightness(var(--we-glass-brightness, 1.04)) contrast(1.01) !important;
  -webkit-backdrop-filter: blur(var(--we-sidebar-blur, 16px)) saturate(var(--we-sidebar-saturate, 1.3)) brightness(var(--we-glass-brightness, 1.04)) contrast(1.01) !important;
  --we-sidebar-blur: var(--we-blur, 16px);
  --we-sidebar-tint: calc(var(--we-glass-alpha, 0.2) * 80%);
  --we-sidebar-sheen: 1;
}
/* The 轨迹 (trajectory) view is a whole page painted with --dsw-alias-bg-layer-1 —
   qBU-ya_root on the outside, then the split, the table and the details column — so
   it reads as one solid white sheet instead of the wallpaper. YG wants it like a
   normal conversation: no base at all. The :has([data-trajectory-scroll]) guard can
   only match ancestors of the trajectory's own scroll pane, so the _root / _split /
   _table / _details suffixes cannot catch anything else on the page. */
[class*="_root"]:has([data-trajectory-scroll]),
[class*="_split"]:has([data-trajectory-scroll]),
[class*="_table"]:has([data-trajectory-scroll]),
[class*="_details"]:has([data-trajectory-scroll]),
[data-trajectory-scroll] {
  background-color: transparent !important;
}
/* The hero's 预览版 pill is a flat --dsw-alias-state-business-tertiary with no glass
   at all. YG wants a faint blue frosted pill instead. Only the surface changes:
   the pill's own border-radius, padding, align-self and margins stay untouched, so
   it keeps sitting at the top-right of the headline exactly where it was. */
[class*="_previewBadge"] {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 14%, transparent) !important;
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 34%, transparent) !important;
  backdrop-filter: blur(10px) saturate(1.6) brightness(1.03) !important;
  -webkit-backdrop-filter: blur(10px) saturate(1.6) brightness(1.03) !important;
}
/* The ask-user card (the one this shell's question tool renders into) paints itself with
   --dsw-specific-input-major, which is opaque white in light mode — the card reads as a solid
   slab over the wallpaper while every other surface is glass. Remapping the token ON the card
   is enough: custom properties resolve at computed-value time, so the card's own
   background: var(--dsw-specific-input-major) and any descendant that reads the same token
   both follow. No need to override each of them.
   Anchored on descendants that only this card has: _fieldInput is its free-text field, _strip
   its warning strip. Both question variants are covered. */
[class*="_card"]:has([class*="_fieldInput"]),
[class*="_card"]:has([class*="_strip"]) {
  --dsw-specific-input-major: var(--kokona-surface-glass);
  background-color: var(--kokona-surface-glass) !important;
  backdrop-filter: blur(var(--we-blur, 16px)) saturate(var(--we-saturate, 1.8)) !important;
  -webkit-backdrop-filter: blur(var(--we-blur, 16px)) saturate(var(--we-saturate, 1.8)) !important;
}
/* The 后台任务 dropdown (dsh-client-ui-jobs) is a flat --dsw-specific-menu panel with
   backdrop-filter: var(--dsw-menu-backdrop-filter), which resolves to none here — so the menu
   and the job detail it expands sit on the same flat tone and read as one block. Two levels:
   the menu becomes the floating surface (same token and frost as the right-click edit menu, so
   the two dropdowns match), and the expanded detail gets the softer, recessed surface so the
   output clearly sits inside the menu rather than merging with the list.
   Anchored on _sectionHeader, which only this module's menu has. */
[class*="_menu"]:has([class*="_sectionHeader"]) {
  background-color: var(--kokona-surface-float) !important;
  backdrop-filter: blur(calc(var(--we-blur, 16px) * 1.8)) saturate(calc(var(--we-saturate, 1.8) * 1.15)) brightness(1.03) !important;
  -webkit-backdrop-filter: blur(calc(var(--we-blur, 16px) * 1.8)) saturate(calc(var(--we-saturate, 1.8) * 1.15)) brightness(1.03) !important;
}
[class*="_menu"]:has([class*="_sectionHeader"]) [class*="_panel"] {
  background-color: var(--kokona-surface-soft) !important;
  border-radius: var(--dsw-radius-md, 8px) !important;
}
/* The sidebar brand slot. The official whale and wordmark are inline SVGs with no
   src, so the replacement is injected as an inline SVG element by installBrand():
   a data: URL would be subject to the page's CSP, and an external image cannot
   inherit currentColor. Under a Windows titlebar the row is 40px tall with
   overflow hidden, so the height has to open up: the lockup renders 72px tall,
   which is 3x the official 24px brand row and the ceiling YG allowed. Everything
   is forced left-aligned inside the row.

   Containment is load-bearing. The official row is 40px tall with overflow hidden;
   growing the lockup to ~219px wide while leaving the row on overflow visible made
   the SVG set the flex row's min-content width, so the lockup fought the resizable
   sidebar for control of the column width and the whole horizontal layout
   oscillated. min-width:0 on every ancestor plus overflow hidden keeps the row out
   of the width negotiation: in a narrow sidebar the lockup letterboxes inside its
   box (preserveAspectRatio is xMinYMid, so it stays left-aligned and vertically
   centered) instead of pushing the sidebar wider. */
[class*="_logoRow"] {
  height: auto !important;
  min-height: 76px !important;
  min-width: 0 !important;
  max-width: 100% !important;
  overflow: hidden !important;
  align-items: center !important;
}
[class*="_logoRow"] [class*="_brand"] {
  justify-content: flex-start !important;
  min-width: 0 !important;
  max-width: 100% !important;
  overflow: hidden !important;
}
[class*="_logoRow"] [class*="_brandIdentity"] {
  height: auto !important;
  justify-content: flex-start !important;
  min-width: 0 !important;
  max-width: 100% !important;
  overflow: hidden !important;
}
/* Hidden only while the replacement is mounted, so a failed asset read degrades to
   the stock brand instead of leaving an empty row. */
body[data-kokona-brand] [class*="_logoRow"] [class*="_brandIdentity"] > * {
  display: none !important;
}
body[data-kokona-brand] [class*="_logoRow"] svg[data-kokona-brand-mark] {
  display: block !important;
  height: 72px !important;
  width: auto !important;
  min-width: 0 !important;
  max-width: 100% !important;
  flex: 0 1 auto;
}
`
  document.head.appendChild(style)
}

/** Gap kept between a shifted app cluster and the window controls. */
const SHIFT_GAP = 12
/** Ceiling on one cluster's shift, so a container that ignores margin-right can never run away. */
const SHIFT_MAX = 260

interface ShiftState {
  original: number
  applied: number
}

const shiftState = new WeakMap<HTMLElement, ShiftState>()
const pendingShift = new WeakMap<HTMLElement, number>()
let shiftedClusters = new Set<HTMLElement>()

/**
 * True while a CSS transition is running on something that reaches into the top
 * strip. Sidebars animate their width, so during the animation every rect up
 * there is a snapshot of the motion rather than the final position.
 */
function topStripBusy(height: number): boolean {
  for (const animation of document.getAnimations()) {
    if (animation.playState !== 'running') continue
    if (!(animation instanceof CSSTransition)) continue
    const target = (animation.effect as KeyframeEffect | null)?.target
    if (!(target instanceof HTMLElement)) continue
    const rect = target.getBoundingClientRect()
    if (rect.bottom > 0 && rect.top < height) return true
  }
  return false
}

/**
 * Outermost top-strip containers in the right half of the window. Each ancestor
 * must still sit entirely inside the strip, stay in the right half, stay inside
 * the window, and stay narrower than half the window — so the walk can never
 * climb into the conversation header or the whole column.
 */
function topStripClusters(height: number, width: number, host: HTMLElement): HTMLElement[] {
  const found = new Set<HTMLElement>()
  for (const element of document.querySelectorAll(INTERACTIVE_SELECTOR)) {
    if (host.contains(element)) continue
    if (!element.matches('button, a[href], [role="button"]')) continue
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    if (rect.top >= height || rect.bottom <= 0) continue
    if (rect.left < width * 0.5 || rect.left >= width) continue
    let cluster = element as HTMLElement
    let depth = 0
    for (let parent = cluster.parentElement; parent && depth < 4; parent = parent.parentElement, depth += 1) {
      const bounds = parent.getBoundingClientRect()
      if (bounds.width <= 0 || bounds.height <= 0) break
      if (bounds.width > width * 0.5) break
      if (bounds.top < 0 || bounds.bottom > height) break
      if (bounds.left < width * 0.5 || bounds.right > width + 1) break
      cluster = parent
    }
    found.add(cluster)
  }
  const list = Array.from(found)
  return list.filter((target) => !list.some((other) => other !== target && other.contains(target)))
}

function shiftOf(element: HTMLElement): number {
  return shiftState.get(element)?.applied ?? 0
}

/** Move a cluster left by exactly `shift` px, remembering its authored margin. */
function applyShift(element: HTMLElement, shift: number): void {
  let state = shiftState.get(element)
  if (!state) {
    const current = Number.parseFloat(window.getComputedStyle(element).marginRight)
    state = { original: Number.isFinite(current) ? current : 0, applied: 0 }
    shiftState.set(element, state)
  }
  if (state.applied === shift) return
  state.applied = shift
  // '' hands the property back to the shell's own rule; the conversation header
  // corner ships margin-right:-16px, which a flat override used to clobber.
  element.style.marginRight = shift === 0 ? '' : `${state.original + shift}px`
}

function releaseShifts(): void {
  for (const element of shiftedClusters) applyShift(element, 0)
  shiftedClusters = new Set()
}

function installTitlebar(config: AppConfig): void {
  const host = document.createElement('div')
  host.id = HOST_ID
  host.style.height = `${clearanceHeight()}px`
  document.documentElement.appendChild(host)

  const theme = config.titlebar.theme === 'auto' ? (isDark() ? 'dark' : 'light') : config.titlebar.theme
  ensureShellStyle(theme)
  api.reportTheme(theme)
  const reportTheme = () => api.reportTheme(isDark() ? 'dark' : 'light')
  new MutationObserver(reportTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'class']
  })
  new MutationObserver(reportTheme).observe(document.body, {
    attributes: true,
    attributeFilter: ['data-ds-dark-theme', 'class']
  })
  document.documentElement.dataset.kokonaShell = 'true'

  const dragLayer = document.createElement('div')
  dragLayer.style.position = 'absolute'
  dragLayer.style.inset = '0'
  dragLayer.style.pointerEvents = 'none'
  host.appendChild(dragLayer)

  const controls = document.createElement('div')
  controls.className = 'kokona-controls'
  controls.style.paddingRight = `${config.titlebar.insetRight}px`
  const drawControls = config.titlebar.controls === 'custom' && process.platform !== 'darwin'
  if (drawControls) {
    const minimize = controlButton('minimize', 'M0.5 5 H9.5', () => api.window.minimize())
    const maximize = controlButton('maximize', 'M1 1 H9 V9 H1 Z', () => api.window.toggleMaximize())
    const close = controlButton('close', 'M1 1 L9 9 M9 1 L1 9', () => api.window.close())
    controls.append(minimize, maximize, close)
    api.onWindowState((state) => {
      maximize.innerHTML = state.maximized
        ? '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 3 H7 V9 H1 Z M3 3 V1 H9 V7 H7" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1 H9 V9 H1 Z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    })
  }
  host.appendChild(controls)

  const layout = () => {
    host.style.height = `${clearanceHeight()}px`
    const width = document.documentElement.clientWidth
    const height = host.getBoundingClientRect().height
    for (const child of Array.from(dragLayer.children)) child.remove()

    const appElements = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR)).filter(
      (element) => !host.contains(element)
    )

    controls.style.paddingRight = `${config.titlebar.insetRight}px`

    // Reserve room for the window controls by shifting only the top-strip
    // clusters that actually reach into them, right-most first, each by exactly
    // its own overlap. The old code gave every cluster a flat 3*46+12 margin, so
    // the utilities and the header corner each moved 150px and any stray button
    // added another — that stacking, plus the margins it never gave back, is the
    // drift.
    const controlsRect = controls.getBoundingClientRect()
    if (controlsRect.width <= 0) {
      releaseShifts()
    } else if (topStripBusy(height)) {
      // A sidebar is animating. Measuring now would apply a shift the next pass
      // has to take back — the buttons visibly jump out and return. Hold the
      // current shift and look again once the motion stops.
      if (retries < 40) {
        retries += 1
        scheduleRetry()
      }
    } else {
      retries = 0
      const ordered = topStripClusters(height, width, host)
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .sort((a, b) => b.rect.right - a.rect.right)
      let boundary = controlsRect.left - SHIFT_GAP
      let needConfirm = false
      for (const entry of ordered) {
        const applied = shiftOf(entry.element)
        const naturalRight = entry.rect.right + applied
        const naturalLeft = entry.rect.left + applied
        const wanted = Math.min(SHIFT_MAX, Math.max(0, Math.round(naturalRight - boundary)))
        let effective = applied
        if (wanted === applied) {
          pendingShift.delete(entry.element)
        } else if (pendingShift.get(entry.element) === wanted) {
          applyShift(entry.element, wanted)
          pendingShift.delete(entry.element)
          effective = wanted
        } else {
          // First sighting of this value. A one-off snapshot — a slot re-mounting,
          // a frame of an animation this pass cannot see — would otherwise move
          // the buttons and move them straight back. Require the same answer twice.
          pendingShift.set(entry.element, wanted)
          needConfirm = true
        }
        boundary = naturalLeft - effective - SHIFT_GAP
      }
      const live = new Set(ordered.map((entry) => entry.element))
      for (const element of shiftedClusters) {
        if (!live.has(element)) applyShift(element, 0)
      }
      shiftedClusters = live
      if (needConfirm) scheduleRetry()
    }

    const blocked: Rect[] = []
    if (controlsRect.width > 0) blocked.push({ left: controlsRect.left, right: controlsRect.right })
    for (const element of appElements) {
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue
      if (rect.top > height || rect.bottom < 0) continue
      blocked.push({ left: Math.max(0, rect.left), right: Math.min(width, rect.right) })
    }

    const step = 10
    const midY = Math.max(1, Math.floor(height / 2))
    for (let x = 0; x < width; x += step) {
      for (const element of document.elementsFromPoint(x, midY)) {
        if (host.contains(element)) continue
        const clickable =
          element.matches(INTERACTIVE_SELECTOR) || getComputedStyle(element).cursor === 'pointer'
        if (clickable) {
          blocked.push({ left: x, right: Math.min(width, x + step) })
          break
        }
      }
    }

    for (const interval of freeIntervals(width, blocked)) {
      if (interval.right - interval.left < 8) continue
      const segment = document.createElement('div')
      segment.className = 'kokona-drag'
      segment.style.left = `${interval.left}px`
      segment.style.width = `${interval.right - interval.left}px`
      segment.addEventListener('dblclick', (event) => {
        event.preventDefault()
        api.window.toggleMaximize()
      })
      dragLayer.appendChild(segment)
    }
  }

  let scheduled = 0
  const schedule = () => {
    if (scheduled) return
    scheduled = window.setTimeout(() => {
      scheduled = 0
      layout()
    }, 200)
  }

  // Re-measure soon after a pass that could not settle (busy strip, or a shift
  // waiting for its second sighting). Single-flight so overlapping passes cannot
  // stack timers.
  let retryTimer = 0
  const scheduleRetry = () => {
    if (retryTimer) return
    retryTimer = window.setTimeout(() => {
      retryTimer = 0
      layout()
    }, 140)
  }
  let retries = 0

  layout()
  window.addEventListener('resize', schedule)
  // Attribute changes matter as much as childList ones: toggling a sidebar flips
  // a class / data attribute and animates the width, which moves every top-strip
  // rect without adding or removing a single node. Watching childList alone
  // missed that, so the reserved margin stayed stale and the buttons sat shifted.
  // Our own margin writes are filtered out so a pass cannot re-trigger itself.
  new MutationObserver((records) => {
    let relevant = false
    for (const record of records) {
      if (host.contains(record.target)) continue
      if (record.type === 'attributes' && record.target instanceof HTMLElement) {
        if (record.attributeName === 'style' && shiftedClusters.has(record.target)) continue
      }
      relevant = true
      break
    }
    if (relevant) schedule()
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'data-sidebar-right-open', 'data-sidebar-right-panel', 'data-dsh-better-sidebar', 'data-we-sidebar-glass', 'data-we-wallpaper']
  })
  const stop = window.setInterval(layout, 1500)
  window.setTimeout(() => window.clearInterval(stop), 15000)
}

let menuEl: HTMLElement | null = null
let menuCleanup: (() => void) | null = null

function closeMenu(): void {
  if (menuEl) menuEl.remove()
  menuEl = null
  if (menuCleanup) menuCleanup()
  menuCleanup = null
}

let safeModeActive = false
api.onSnapshot((snapshot) => {
  safeModeActive = snapshot.safeMode
})

function openRestartMenu(anchor: HTMLElement, zh: boolean): void {
  if (menuEl) {
    closeMenu()
    return
  }
  ensureShellStyle()
  const menu = document.createElement('div')
  menu.className = MENU_CLASS
  const items: Array<[string, boolean, () => void]> = [
    [zh ? '重新加载界面' : 'Reload interface', false, () => api.reloadUi()],
    [zh ? '重启客户端' : 'Restart app', false, () => void api.relaunchApp(safeModeActive)],
    [zh ? '仅重启内核' : 'Restart core only', false, () => void api.restartCore()]
  ]
  if (safeModeActive) {
    items.push([zh ? '退出安全模式并重启' : 'Leave safe mode and restart', false, () => void api.relaunchApp(false)])
  } else {
    items.push([
      zh ? '重启进安全模式（屏蔽全部插件）' : 'Restart in safe mode (all plugins off)',
      true,
      () => void api.relaunchApp(true)
    ])
  }
  for (const [label, danger, action] of items) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    if (danger) button.classList.add('kokona-danger')
    button.addEventListener('click', () => {
      closeMenu()
      action()
    })
    menu.appendChild(button)
  }
  document.body.appendChild(menu)
  const rect = anchor.getBoundingClientRect()
  menu.style.top = `${Math.round(rect.bottom + 6)}px`
  menu.style.left = `${Math.round(Math.max(8, rect.right - menu.offsetWidth))}px`
  menuEl = menu
  const onDocumentClick = (event: MouseEvent) => {
    const target = event.target as Node
    if (menuEl && !menuEl.contains(target) && target !== anchor) closeMenu()
  }
  document.addEventListener('click', onDocumentClick, true)
  menuCleanup = () => document.removeEventListener('click', onDocumentClick, true)
}

function findSettingsActions(): HTMLElement | null {
  for (const close of Array.from(document.querySelectorAll('button[class*="_close"]'))) {
    const previous = close.previousElementSibling
    if (previous instanceof HTMLElement && /_actions/.test(previous.className)) return previous
  }
  return null
}

function makeSettingsButton(label: string, templateClass: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  if (templateClass) {
    button.className = templateClass
  } else {
    button.style.cssText =
      'height:28px;padding:0 12px;border-radius:8px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer;-webkit-app-region:no-drag;'
  }
  button.textContent = label
  return button
}

function injectSettingsActions(): void {
  const actions = findSettingsActions()
  if (!actions || actions.querySelector(`[${SETTINGS_ACTIONS_ATTR}]`)) return
  ensureShellStyle()
  const template = actions.querySelector('button')
  const templateClass = template ? template.className : ''
  const zh = /[\u4e00-\u9fff]/.test(actions.textContent ?? '') || document.documentElement.lang.startsWith('zh')
  const wrap = document.createElement('div')
  wrap.setAttribute(SETTINGS_ACTIONS_ATTR, 'true')
  wrap.style.cssText = 'display:flex;align-items:center;gap:8px;'
  const terminal = makeSettingsButton(zh ? 'DSH 终端' : 'DSH terminal', templateClass)
  terminal.title = zh ? '在 DSH_HOME 打开终端，dsh 可直接使用' : 'Open a terminal at DSH_HOME with dsh on PATH'
  terminal.addEventListener('click', () => void api.openTerminal())
  const restart = makeSettingsButton(zh ? '重启菜单' : 'Restart menu', templateClass)
  restart.title = zh
    ? '重新加载界面 / 重启客户端 / 仅重启内核 / 安全模式'
    : 'Reload / restart app / restart core only / safe mode'
  restart.addEventListener('click', (event) => {
    event.stopPropagation()
    openRestartMenu(restart, zh)
  })
  wrap.append(terminal, restart)
  actions.appendChild(wrap)
}

const UPDATE_NAV_ATTR = 'data-kokona-update-nav'
const UPDATE_PANEL_ATTR = 'data-kokona-update-panel'
const NAV_BOUND_ATTR = 'data-kokona-nav-bound'

let updatePanel: HTMLElement | null = null

let cachedSettingsRoot: HTMLElement | null = null

function settingsRoot(): HTMLElement | null {
  const cached = cachedSettingsRoot
  if (cached && cached.isConnected && cached.querySelector('[class*="_navList"]')) return cached
  const close = document.querySelector('button[class*="_close"]')
  const panel = close?.closest('[class*="_panel"]')
  cachedSettingsRoot =
    panel instanceof HTMLElement && panel.querySelector('[class*="_navList"]') ? panel : null
  return cachedSettingsRoot
}

function actionButton(label: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.style.cssText =
    'height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer;-webkit-app-region:no-drag;'
  return button
}

function row(): HTMLElement {
  const node = document.createElement('div')
  node.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;'
  return node
}

function statusLine(): HTMLElement {
  const node = document.createElement('p')
  node.style.cssText =
    'font-size:12px;min-height:18px;margin:8px 0 0;color:var(--dsw-alias-label-secondary,#9a9aa8);white-space:pre-wrap;'
  return node
}

function sectionTitle(text: string): HTMLElement {
  const node = document.createElement('div')
  node.textContent = text
  node.style.cssText =
    'font-size:13px;font-weight:600;margin:20px 0 8px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));'
  return node
}

function buildUpdatePanel(): HTMLElement {
  const wrap = document.createElement('div')
  wrap.setAttribute(UPDATE_PANEL_ATTR, 'true')
  wrap.style.cssText =
    'width:100%;box-sizing:border-box;padding:8px 24px 24px;background:transparent;color:var(--dsw-alias-label-primary,#e8e8ee);'
  const heading = document.createElement('h2')
  heading.textContent = '检查更新'
  heading.style.cssText = 'font-size:16px;font-weight:600;margin:0 0 4px;'
  const sub = document.createElement('p')
  sub.textContent = '内核与外壳分开更新，可分别检查。'
  sub.style.cssText = 'margin:0 0 4px;color:var(--dsw-alias-label-secondary,#9a9aa8);font-size:12px;'
  wrap.append(heading, sub)

  const coreTitle = document.createElement('div')
  coreTitle.textContent = '内核更新'
  coreTitle.style.cssText = 'font-size:13px;font-weight:600;margin:16px 0 8px;'
  const coreRow = row()
  const coreCheck = actionButton('检查内核更新')
  const coreRestart = actionButton('重启内核')
  coreRow.append(coreCheck, coreRestart)
  const coreStatus = statusLine()
  const listTitle = document.createElement('div')
  listTitle.textContent = '已安装版本'
  listTitle.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#9a9aa8);margin:14px 0 6px;'
  const list = document.createElement('div')
  list.style.cssText = 'display:flex;flex-direction:column;gap:6px;'
  wrap.append(coreTitle, coreRow, coreStatus, listTitle, list)

  const shellTitle = sectionTitle('外壳更新')
  const shellRow = row()
  const shellCheck = actionButton('检查外壳更新')
  shellRow.append(shellCheck)
  const shellStatus = statusLine()
  const notes = document.createElement('pre')
  notes.style.cssText =
    'display:none;margin:12px 0 0;max-height:220px;overflow:auto;background:transparent;color:var(--dsw-alias-label-primary,inherit);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:8px;padding:10px;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;'
  wrap.append(shellTitle, shellRow, shellStatus, notes)

  const refreshCore = async (): Promise<void> => {
    const snapshot = await api.snapshot()
    coreStatus.textContent = `当前内核 ${snapshot.coreVersion ?? '无'} · 频道 ${snapshot.channel}`
    list.replaceChildren()
    const versions = [...snapshot.installedVersions]
    if (snapshot.coreVersion && !versions.includes(snapshot.coreVersion)) versions.push(snapshot.coreVersion)
    for (const version of versions) {
      const item = document.createElement('div')
      item.style.cssText =
        'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:8px;'
      const code = document.createElement('code')
      code.textContent = version
      const use = actionButton(version === snapshot.coreVersion ? '使用中' : '使用')
      use.disabled = version === snapshot.coreVersion
      use.addEventListener('click', async () => {
        use.disabled = true
        use.textContent = '切换中…'
        await api.switchCore(version)
      })
      item.append(code, use)
      list.append(item)
    }
  }

  coreCheck.addEventListener('click', async () => {
    coreCheck.disabled = true
    coreStatus.textContent = '检查中…'
    try {
      const info = await api.checkUpdates()
      if (!info.latest) {
        coreStatus.textContent = '该频道没有可用版本。'
      } else if (info.latest === info.current) {
        coreStatus.textContent = `已是最新：${info.latest}`
      } else {
        coreStatus.textContent = `发现新版本 ${info.latest}（当前 ${info.current ?? '无'}）`
        const install = actionButton(`安装 ${info.latest}`)
        install.addEventListener('click', async () => {
          install.disabled = true
          install.textContent = '安装中…'
          try {
            await api.installCore(info.latest as string)
            coreStatus.textContent = `已安装 ${info.latest}`
            await refreshCore()
          } catch (error) {
            coreStatus.textContent = `安装失败：${(error as Error).message}`
            install.disabled = false
            install.textContent = `安装 ${info.latest}`
          }
        })
        coreRow.append(install)
      }
    } catch (error) {
      coreStatus.textContent = `检查失败：${(error as Error).message}`
    } finally {
      coreCheck.disabled = false
    }
  })
  coreRestart.addEventListener('click', () => void api.restartCore())

  let openButton: HTMLButtonElement | null = null
  const setOpenButton = (url: string | null): void => {
    openButton?.remove()
    openButton = null
    if (!url) return
    openButton = actionButton('打开发行页')
    openButton.addEventListener('click', () => void api.openExternal(url))
    shellRow.append(openButton)
  }

  void api.snapshot().then((snapshot) => {
    shellStatus.textContent = `当前版本 ${snapshot.shellVersion}`
  })

  shellCheck.addEventListener('click', async () => {
    shellCheck.disabled = true
    shellStatus.textContent = '检查中…'
    notes.style.display = 'none'
    try {
      const info = await api.checkShellUpdate()
      if (info.latest && info.hasUpdate) {
        shellStatus.textContent = `发现新版本 ${info.latest}（当前 ${info.current}）· 来源 ${info.source}`
        setOpenButton(info.url)
        if (info.notes) {
          notes.textContent = info.notes
          notes.style.display = 'block'
        }
      } else if (info.latest) {
        shellStatus.textContent = `已是最新（${info.current}）· 来源 ${info.source}`
        setOpenButton(null)
      } else {
        shellStatus.textContent = `暂无发行版${info.error ? `（${info.error}）` : ''}`
        setOpenButton(null)
      }
    } catch (error) {
      shellStatus.textContent = `检查失败：${(error as Error).message}`
      setOpenButton(null)
    } finally {
      shellCheck.disabled = false
    }
  })

  void refreshCore()
  return wrap
}

const HIDDEN_ATTR = 'data-kokona-options-hidden'
let previousActiveNav: { cell: HTMLElement; token: string } | null = null

function optionsContainer(): HTMLElement | null {
  const root = settingsRoot()
  const options = root?.querySelector('[class*="_options"]')
  return options instanceof HTMLElement ? options : null
}

function hideOptionsChildren(options: HTMLElement): void {
  for (const child of Array.from(options.children)) {
    if (!(child instanceof HTMLElement)) continue
    if (child.hasAttribute(UPDATE_PANEL_ATTR) || child.hasAttribute(HIDDEN_ATTR)) continue
    child.setAttribute(HIDDEN_ATTR, child.style.display)
    child.style.display = 'none'
  }
}

function restoreOptionsChildren(options: HTMLElement): void {
  for (const child of Array.from(options.children)) {
    if (!(child instanceof HTMLElement) || !child.hasAttribute(HIDDEN_ATTR)) continue
    child.style.display = child.getAttribute(HIDDEN_ATTR) ?? ''
    child.removeAttribute(HIDDEN_ATTR)
  }
}

function activeNavToken(navList: HTMLElement): string | null {
  for (const cell of Array.from(navList.querySelectorAll('[class*="_navCell"]'))) {
    if (cell.hasAttribute(UPDATE_NAV_ATTR)) continue
    for (const token of Array.from(cell.classList)) {
      if (/active/i.test(token)) return token
    }
  }
  return null
}

function setOurNavActive(active: boolean): void {
  const cell = document.querySelector(`[${UPDATE_NAV_ATTR}]`)
  if (!(cell instanceof HTMLElement)) return
  const navList = cell.parentElement
  if (!(navList instanceof HTMLElement)) return
  if (active) {
    const token = activeNavToken(navList)
    if (token) {
      for (const other of Array.from(navList.querySelectorAll('[class*="_navCell"]'))) {
        if (other === cell || !(other instanceof HTMLElement) || !other.classList.contains(token)) continue
        other.classList.remove(token)
        other.removeAttribute('aria-current')
        previousActiveNav = { cell: other, token }
      }
      cell.classList.add(token)
    }
    cell.setAttribute('aria-current', 'page')
    return
  }
  for (const token of Array.from(cell.classList)) {
    if (/active/i.test(token)) cell.classList.remove(token)
  }
  cell.removeAttribute('aria-current')
  if (previousActiveNav && document.contains(previousActiveNav.cell)) {
    previousActiveNav.cell.classList.add(previousActiveNav.token)
    previousActiveNav.cell.setAttribute('aria-current', 'page')
  }
  previousActiveNav = null
}

function closeUpdateTab(): void {
  if (updatePanel) {
    updatePanel.remove()
    updatePanel = null
    const options = optionsContainer()
    if (options) restoreOptionsChildren(options)
    setOurNavActive(false)
  }
}

function openUpdateTab(): void {
  if (updatePanel && !document.contains(updatePanel)) updatePanel = null
  if (updatePanel) return
  const options = optionsContainer()
  if (!options) return
  hideOptionsChildren(options)
  updatePanel = buildUpdatePanel()
  options.appendChild(updatePanel)
  setOurNavActive(true)
}

function injectSettingsTabs(): void {
  const root = settingsRoot()
  if (!root) return
  const navList = root.querySelector('[class*="_navList"]')
  if (!(navList instanceof HTMLElement)) return
  if (!navList.hasAttribute(NAV_BOUND_ATTR)) {
    navList.setAttribute(NAV_BOUND_ATTR, 'true')
    navList.addEventListener(
      'click',
      (event) => {
        const target = event.target
        const ours = target instanceof Element && Boolean(target.closest(`[${UPDATE_NAV_ATTR}]`))
        if (!ours) closeUpdateTab()
      },
      true
    )
  }
  if (navList.querySelector(`[${UPDATE_NAV_ATTR}]`)) return
  const template = navList.querySelector('[class*="_navCell"]')
  if (!(template instanceof HTMLElement)) return
  const cell = template.cloneNode(true) as HTMLElement
  cell.setAttribute(UPDATE_NAV_ATTR, 'true')
  cell.className = cell.className
    .split(' ')
    .filter((name) => !/active/i.test(name))
    .join(' ')
  cell.removeAttribute('aria-current')
  const labelNode = cell.querySelector('[class*="_navLabel"]')
  if (labelNode) labelNode.textContent = '检查更新'
  else cell.textContent = '检查更新'
  cell.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    openUpdateTab()
  })
  navList.appendChild(cell)
}

function observeSettings(): void {
  let frame = 0
  const run = (): void => {
    frame = 0
    injectSettingsActions()
    injectSettingsTabs()
  }
  const schedule = (): void => {
    if (frame) return
    frame = window.requestAnimationFrame(run)
  }

  run()

  // The settings dialog is portalled onto <body>, so its mount is a body-level
  // childList change. Scheduling on the next animation frame lands the injected
  // cell in the SAME paint as the shell's own nav cells; the old trailing
  // 250ms debounce made it appear one step late.
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (!(node instanceof HTMLElement)) continue
        if (!node.matches('[role="dialog"]') && !node.querySelector('[role="dialog"]')) continue
        schedule()
        return
      }
    }
  }).observe(document.body, { childList: true })

  // While the dialog is mounted, React may re-render the nav list and drop the
  // injected cell, so re-check. Guarded by the cached root: with the dialog
  // closed this callback is one property read, never a document scan.
  new MutationObserver(() => {
    if (cachedSettingsRoot?.isConnected) schedule()
  }).observe(document.body, { childList: true, subtree: true })

  // Safety net for any mount path the observers miss.
  window.setInterval(() => {
    if (cachedSettingsRoot?.isConnected) return
    injectSettingsActions()
    injectSettingsTabs()
  }, 1200)
}

function syncRightPanel(): void {
  const panel = document.querySelector('[data-sidebar-right-panel]')
  if (!(panel instanceof HTMLElement)) return
  const column = panel.closest('[class*="_rightbarCol"]')
  if (!(column instanceof HTMLElement)) return
  const collapsed = column.getBoundingClientRect().width < 2
  const hidden = panel.style.getPropertyValue('display') === 'none'
  if (collapsed && !hidden) panel.style.setProperty('display', 'none', 'important')
  else if (!collapsed && hidden) panel.style.removeProperty('display')
}

const BRAND_ATTR = 'data-kokona-brand'
const BRAND_MARK_ATTR = 'data-kokona-brand-mark'
const HERO_HEADLINE = '沐浴晨光，方得救赎！'
const HERO_SOURCE = ['探索未至之境', 'Into the Unknown']

let brandSourceCache: string | null | undefined

function brandSource(): string | null {
  if (brandSourceCache !== undefined) return brandSourceCache
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'brand.svg') : '',
    join(process.cwd(), 'resources', 'brand.svg')
  ]
  brandSourceCache = null
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (existsSync(candidate)) {
        brandSourceCache = readFileSync(candidate, 'utf8')
        break
      }
    } catch {
      // keep looking: a missing asset must never break the page
    }
  }
  return brandSourceCache
}

/**
 * Replace the sidebar's official whale and wordmark with the project lockup.
 * Injected as a real SVG element rather than a CSS background: the artwork is
 * hard-coded black, and remapping it to currentColor is the only way it follows
 * the sidebar's ink instead of vanishing in the dark theme — an external image
 * cannot inherit currentColor, and a data: URL would answer to the page CSP.
 */
function installBrand(): void {
  const identity = document.querySelector('[class*="_logoRow"] [class*="_brandIdentity"]')
  if (!(identity instanceof HTMLElement)) return
  if (identity.querySelector(`svg[${BRAND_MARK_ATTR}]`)) return
  const source = brandSource()
  if (!source) return
  const holder = document.createElement('div')
  holder.innerHTML = source
  const svg = holder.querySelector('svg')
  if (!svg) return
  svg.setAttribute(BRAND_MARK_ATTR, '')
  svg.setAttribute('preserveAspectRatio', 'xMinYMid meet')
  svg.removeAttribute('width')
  svg.removeAttribute('height')
  for (const node of Array.from(svg.querySelectorAll('[fill="#000"], [fill="#000000"]'))) {
    node.setAttribute('fill', 'currentColor')
  }
  identity.appendChild(svg)
  document.body.setAttribute(BRAND_ATTR, '')
}

/** The hero headline is a locale string (hero.headline); swap the copy in place. */
function installHeroCopy(): void {
  const group = document.querySelector('[class*="_titleGroup"]')
  if (!(group instanceof HTMLElement)) return
  const headline = group.firstElementChild
  if (!(headline instanceof HTMLElement)) return
  const current = (headline.textContent ?? '').trim()
  if (!HERO_SOURCE.includes(current)) return
  headline.textContent = HERO_HEADLINE
}

/**
 * The core's open-in-app menu cannot open a file in File Explorer.
 *
 * Its `explorer` entry launches the path as an Explorer target, which does nothing
 * at all for a file — Explorer opens a target, it does not "open with" one — so the
 * click lands nowhere and the menu looks dead. Its reveal gesture has a second
 * defect: it passes `/select,` and the path as two argv entries, and Explorer parses
 * its own command line, so it sees an empty selection and opens a bare window.
 *
 * Neither is reachable from CSS and the core is never patched, so the gesture is
 * intercepted on the transport the client actually uses. `POST open-in-app/open`
 * carries the path in its body; the hook swallows it for the explorer app, answers
 * with a synthetic success, and asks the main process to reveal the path properly.
 *
 * The hook has to run in the page's own world because that is where the client's
 * global fetch lives, and `webFrame.executeJavaScript` is the one entry point that
 * reaches it from an isolated preload. The two worlds share no objects, so they talk
 * over a DOM event — the one channel both can see.
 */
const OPEN_IN_APP_FIX_ATTR = 'data-kokona-open-in-app'
const OPEN_IN_APP_REVEAL_EVENT = 'kokona:reveal'

function installOpenInAppFix(): void {
  if (document.documentElement.hasAttribute(OPEN_IN_APP_FIX_ATTR)) return
  document.documentElement.setAttribute(OPEN_IN_APP_FIX_ATTR, '')
  document.addEventListener(OPEN_IN_APP_REVEAL_EVENT, (event) => {
    const target = (event as CustomEvent<unknown>).detail
    if (typeof target === 'string' && target !== '') void api.revealPath(target)
  })
  const source = `(() => {
  if (window.__kokonaOpenInAppFix) return
  window.__kokonaOpenInAppFix = true
  const native = window.fetch.bind(window)
  window.fetch = (input, init) => {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase()
      if (method === 'POST' && /(^|\\/)open-in-app\\/open$/.test(url) && init && typeof init.body === 'string') {
        const body = JSON.parse(init.body)
        if (body && body.app === 'explorer' && typeof body.path === 'string' && body.path !== '') {
          document.dispatchEvent(new CustomEvent('${OPEN_IN_APP_REVEAL_EVENT}', { detail: body.path }))
          return Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }))
        }
      }
    } catch {
      // An unreadable body is not ours to interpret; fall through to the real fetch.
    }
    return native(input, init)
  }
})()`
  void webFrame.executeJavaScript(source).catch(() => {
    // A page that refuses injection keeps the stock gesture.
  })
}

/**
 * Electron ships no default context menu, so a right-click on text does nothing at all.
 * This reports what the click landed on and lets the main process decide the menu; the
 * renderer only draws it, and only the main process can read the clipboard anyway.
 *
 * A live selection always earns the menu, because copying what is selected is the point.
 * Otherwise the pointer has to be on actual text — an element that merely contains text is
 * not enough, or right-clicking anywhere in a padded panel would claim the gesture — and
 * widgets are skipped so a plugin that puts its own menu on a button keeps it.
 */
const EDIT_MENU_ATTR = 'data-kokona-edit-menu'

/** Input types whose selection APIs are unusable, or which hold nothing editable. */
const NON_TEXT_INPUTS =
  /^(?:number|email|date|time|datetime-local|month|week|range|color|file|checkbox|radio|submit|button|reset|image|hidden)$/

/** Widgets own their right-click; only real text inside them is claimed. */
const WIDGET_SELECTOR =
  'button, a, select, summary, label, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"], [role="radio"], [role="slider"]'

function isTextField(element: Element | null): element is HTMLInputElement | HTMLTextAreaElement {
  if (element instanceof HTMLTextAreaElement) return true
  return element instanceof HTMLInputElement && !NON_TEXT_INPUTS.test(element.type)
}

function selectionWithin(element: Element): boolean {
  const selection = window.getSelection()
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return false
  return element.contains(selection.getRangeAt(0).commonAncestorContainer)
}

/** A selection anywhere in the document — which is what a copy would actually take. */
function selectionAnywhere(): boolean {
  const selection = window.getSelection()
  return selection !== null && !selection.isCollapsed && selection.toString().length > 0
}

/**
 * Whether the point is over a text node rather than over padding, an icon or a widget.
 *
 * caretRangeFromPoint is Chromium's spelling and caretPositionFromPoint is the standard
 * name. Both are non-standard, so both are looked up rather than assumed, and an element
 * that merely contains text does not count — otherwise a right-click on any padded panel
 * would claim the gesture.
 */
function textUnderPoint(x: number, y: number): boolean {
  type WithCaret = Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node } | null
  }
  const doc = document as WithCaret
  try {
    if (typeof doc.caretRangeFromPoint === 'function') {
      const range = doc.caretRangeFromPoint(x, y)
      if (range !== null) return range.startContainer.nodeType === Node.TEXT_NODE
    }
    if (typeof doc.caretPositionFromPoint === 'function') {
      const position = doc.caretPositionFromPoint(x, y)
      if (position !== null) return position.offsetNode.nodeType === Node.TEXT_NODE
    }
  } catch {
    // A rejected lookup just means "not text".
  }
  return false
}

/**
 * Null means "not our gesture" — the click is handed back to the page untouched.
 */
function describeEditTarget(target: Element, x: number, y: number): EditContextState | null {
  const field = target.closest('input, textarea')
  if (isTextField(field)) {
    if (field.disabled) return null
    let hasSelection = false
    try {
      hasSelection = field.selectionStart !== field.selectionEnd
    } catch {
      // Some input types reject the selection indices outright.
      hasSelection = false
    }
    return {
      editable: !field.readOnly,
      hasSelection,
      hasContent: field.value.length > 0
    }
  }

  // A rich-text surface. isContentEditable settles inheritance and contenteditable="false",
  // which a bare [contenteditable] lookup would get wrong.
  const rich = target.closest('[contenteditable]')
  if (rich instanceof HTMLElement && rich.isContentEditable) {
    return {
      editable: true,
      hasSelection: selectionWithin(rich),
      hasContent: (rich.textContent ?? '').length > 0
    }
  }

  // Not an editable surface, so this is plain text: a transcript message, a code block, a
  // table cell, a log line. A selection is enough on its own — that is the case this
  // exists for — otherwise the pointer has to be on text and outside any widget.
  const selected = selectionAnywhere()
  if (!selected && (target.closest(WIDGET_SELECTOR) !== null || !textUnderPoint(x, y))) return null

  // Nothing here can be cut into or pasted over, so the menu offers copy and select-all.
  return { editable: false, hasSelection: selected, hasContent: true }
}

/**
 * The menu surface. A native menu cannot be styled at all — the OS paints it — so this is
 * drawn in the page to get the same frosted material as the dock and the right panel. Only
 * the surface is custom: the actions are still Electron's own.
 *
 * The frost is the sidebar's kind of mica, but not its depth: the sidebar's own radius (the
 * 侧栏模糊 slider) frosts the wallpaper into an opaque sheet, which is wrong for a menu that
 * has to stay legible over whatever it covers. Deriving from the 玻璃 slider instead keeps
 * the menu tied to the same control as the composer while sitting a clear step above it.
 */
const EDIT_MENU_ID = 'kokona-edit-menu'
const EDIT_MENU_STYLE_ID = 'kokona-edit-menu-style'
const EDIT_MENU_STYLE = `
#${EDIT_MENU_ID} {
  position: fixed;
  z-index: 2147483000;
  min-width: 112px;
  padding: 4px;
  margin: 0;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--we-sidebar-color, #ffffff) 26%, transparent);
  background-color: color-mix(in srgb, var(--we-sidebar-color, #ffffff) var(--we-sidebar-tint, 20%), transparent);
  backdrop-filter: blur(calc(var(--we-blur, 16px) * 1.8)) saturate(calc(var(--we-saturate, 1.8) * 1.15)) brightness(1.03);
  -webkit-backdrop-filter: blur(calc(var(--we-blur, 16px) * 1.8)) saturate(calc(var(--we-saturate, 1.8) * 1.15)) brightness(1.03);
  box-shadow: 0 12px 32px rgba(0, 0, 0, .28), 0 2px 8px rgba(0, 0, 0, .16);
  color: inherit;
  font-size: 13px;
  line-height: 1;
  user-select: none;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
#${EDIT_MENU_ID} .kokona-edit-sep {
  height: 1px;
  margin: 4px 6px;
  background-color: color-mix(in srgb, currentColor 18%, transparent);
}
#${EDIT_MENU_ID} .kokona-edit-item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: default;
}
#${EDIT_MENU_ID} .kokona-edit-item[data-enabled='true']:hover {
  background-color: var(--kokona-surface-selected, color-mix(in srgb, currentColor 14%, transparent));
}
#${EDIT_MENU_ID} .kokona-edit-item[data-enabled='false'] { opacity: .38; }
/* nowrap on both, with the key pushed to the far edge. The box is a min-width, so it grows to
   fit instead of letting the label and the shortcut run into each other. */
#${EDIT_MENU_ID} .kokona-edit-label { white-space: nowrap; }
#${EDIT_MENU_ID} .kokona-edit-key { margin-left: auto; padding-left: 2px; white-space: nowrap; opacity: .55; font-size: 12px; }
`

let editMenuElement: HTMLElement | null = null

function closeEditMenu(): void {
  if (editMenuElement === null) return
  editMenuElement.remove()
  editMenuElement = null
  document.removeEventListener('pointerdown', closeEditMenuOnOutside, true)
  document.removeEventListener('keydown', closeEditMenuOnKey, true)
  document.removeEventListener('scroll', closeEditMenu, true)
  window.removeEventListener('blur', closeEditMenu)
  window.removeEventListener('resize', closeEditMenu)
}

function closeEditMenuOnOutside(event: Event): void {
  if (event.target instanceof Node && editMenuElement?.contains(event.target) === true) return
  closeEditMenu()
}

function closeEditMenuOnKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeEditMenu()
}

/** Keep the menu inside the window: flip rather than overflow. */
function placeEditMenu(menu: HTMLElement, x: number, y: number): void {
  const rect = menu.getBoundingClientRect()
  const margin = 8
  menu.style.left = `${Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin))}px`
  menu.style.top = `${Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin))}px`
}

function openEditMenu(entries: EditMenuEntry[], x: number, y: number): void {
  closeEditMenu()
  const menu = document.createElement('div')
  menu.id = EDIT_MENU_ID
  menu.setAttribute('role', 'menu')
  for (const entry of entries) {
    if (entry.separated) {
      const separator = document.createElement('div')
      separator.className = 'kokona-edit-sep'
      menu.append(separator)
    }
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'kokona-edit-item'
    item.setAttribute('role', 'menuitem')
    item.dataset.enabled = String(entry.enabled)
    item.disabled = !entry.enabled
    const label = document.createElement('span')
    label.className = 'kokona-edit-label'
    label.textContent = entry.label
    const key = document.createElement('span')
    key.className = 'kokona-edit-key'
    key.textContent = entry.accelerator
    item.append(label, key)
    // Focus has to stay in the field: the edit actions run on whatever is focused, so a
    // button that takes focus would send them nowhere.
    item.addEventListener('mousedown', (event) => event.preventDefault())
    item.addEventListener('click', () => {
      closeEditMenu()
      if (entry.enabled) api.editAction(entry.action)
    })
    menu.append(item)
  }
  menu.addEventListener('mousedown', (event) => event.preventDefault())
  document.body.append(menu)
  editMenuElement = menu
  placeEditMenu(menu, x, y)
  document.addEventListener('pointerdown', closeEditMenuOnOutside, true)
  document.addEventListener('keydown', closeEditMenuOnKey, true)
  document.addEventListener('scroll', closeEditMenu, true)
  window.addEventListener('blur', closeEditMenu)
  window.addEventListener('resize', closeEditMenu)
}

function installEditContextMenu(): void {
  if (document.documentElement.hasAttribute(EDIT_MENU_ATTR)) return
  document.documentElement.setAttribute(EDIT_MENU_ATTR, '')
  const style = document.createElement('style')
  style.id = EDIT_MENU_STYLE_ID
  style.textContent = EDIT_MENU_STYLE
  document.head.append(style)
  // Capture phase: read the selection before any page handler can change it.
  document.addEventListener(
    'contextmenu',
    (event) => {
      const target = event.target instanceof Element ? event.target : null
      if (target === null) return
      const x = event.clientX
      const y = event.clientY
      const state = describeEditTarget(target, x, y)
      if (state === null) return
      // Claim the gesture synchronously, before the await below can lose the turn.
      event.preventDefault()
      const entry = target.closest('input, textarea, [contenteditable]')
      if (entry instanceof HTMLElement) {
        // Right-clicking a field should put the caret where the click landed, which is what
        // the edit actions act on.
        entry.focus()
      } else if (document.activeElement instanceof HTMLElement) {
        // The actions run on whatever is focused, so a field that still holds focus would
        // swallow them. With nothing focused, copy and select-all act on the document
        // selection instead — which is the text that was right-clicked.
        document.activeElement.blur()
      }
      // The clipboard can only be read in the main process, so the entries are built there.
      void api
        .editContext(state)
        .then((entries) => openEditMenu(entries, x, y))
        .catch(() => {
          // No menu is better than a broken one.
        })
    },
    true
  )
}

/**
 * The core's tool errors arrive in English whatever the display language is, and one of
 * them is also misleading: it refuses to edit a file it has not observed and reports that
 * the file "has not been read", which is frequently not true.
 *
 * The observation table lives in the core's memory: dsh-fs-observation-policy keys it by
 * session in a WeakMap, and the gate is rebuilt every time the plugin is applied, so a core
 * restart or a plugin reload empties it. Files that were read minutes earlier then fail as
 * if they had never been opened. The remedy is the same either way — read the file again —
 * but the wording blames the model instead of the restart, which sends anyone debugging it
 * the wrong way.
 *
 * The core is never patched, so both corrections ride under the error instead: a Chinese
 * rendering of it, and for the unobserved case a note explaining why the message is
 * misleading. Detection is by the message text, because the error renders as a plain
 * string with no stable hook of its own.
 */
const FS_NOTE_ATTR = 'data-kokona-fs-note'
const FS_HINT_NEEDLE = 'file has not been read'
const FS_HINT_MESSAGE =
  '这个报错未必是真的「没读过」。文件观测记录只存在核心进程的内存里，核心重启或插件重载后会清空，所以重启前读过的文件也会报这个。重读一次该文件再试即可。'

/**
 * Only shapes that translate completely are listed. A message whose middle is supplied by
 * the provider would come out half English, which is worse than leaving it alone.
 */
const FS_TRANSLATIONS: Array<{ pattern: RegExp; render: (path: string) => string }> = [
  {
    pattern: /cannot modify "([^"]+)":\s*file has not been read/,
    render: (path) => `无法修改「${path}」：该文件尚未被读取 —— 请先读取该文件，然后重试。`
  },
  {
    pattern: /cannot edit "([^"]+)":\s*not found/,
    render: (path) => `无法编辑「${path}」：文件不存在。`
  }
]

/**
 * Simplified Chinese only. A Traditional reader would get a line they can read but did not
 * ask for, which is worse than none. `documentElement.lang` wins when the page sets it;
 * otherwise the renderer's own locale is the display language.
 */
function prefersSimplifiedChinese(): boolean {
  const declared = (document.documentElement.lang || '').trim().toLowerCase()
  const language = declared === '' ? (navigator.language || '').trim().toLowerCase() : declared
  return /^zh\b/.test(language) && /hant|tw|hk|mo/.test(language) === false
}

function translateFsError(original: string): string | null {
  for (const entry of FS_TRANSLATIONS) {
    const match = entry.pattern.exec(original)
    if (match !== null) return entry.render(match[1] ?? '')
  }
  return null
}

const FS_NOTE_LINE_STYLE = 'margin: 6px 0 0; font-size: 12px; line-height: 1.6; opacity: .8; user-select: text'

// Inline and derived from currentColor, so it follows the theme without a stylesheet.
const FS_NOTE_BOX_STYLE = [
  'margin: 6px 0 2px',
  'padding: 6px 10px',
  'border-radius: 8px',
  'border: 1px solid color-mix(in srgb, currentColor 18%, transparent)',
  'background-color: color-mix(in srgb, currentColor 8%, transparent)',
  'font-size: 12px',
  'line-height: 1.5',
  'opacity: .85',
  'user-select: text'
].join('; ')

/**
 * The lines that ride under one core error: its Chinese rendering, and — for the
 * unobserved-file case — why the message is misleading. Either can be absent; a note with
 * neither is not inserted at all.
 */
function buildFsNote(original: string): HTMLElement | null {
  const note = document.createElement('div')
  note.setAttribute(FS_NOTE_ATTR, '')

  const translated = prefersSimplifiedChinese() ? translateFsError(original) : null
  if (translated !== null) {
    const line = document.createElement('div')
    line.textContent = translated
    line.style.cssText = FS_NOTE_LINE_STYLE
    note.append(line)
  }

  if (original.includes(FS_HINT_NEEDLE)) {
    const hint = document.createElement('div')
    hint.textContent = FS_HINT_MESSAGE
    hint.style.cssText = FS_NOTE_BOX_STYLE
    note.append(hint)
  }

  return note.childElementCount > 0 ? note : null
}

/**
 * Where a note goes. The core renders a failed tool call as a collapsed card: a role=button
 * trigger (the element owning aria-expanded) holding the title and the error summary as flex
 * children, plus a body that only mounts once expanded. A note appended next to the error
 * text therefore becomes a flex item on the header's own line, reads as part of the header,
 * and sits above a body that may well be empty. Anchoring on the card instead — the trigger's
 * parent — drops it below the whole thing as its own block. Outside a card the parent is
 * already the right place, so nothing changes for plain prose.
 */
function noteAnchor(node: Node): Element | null {
  const owner = node.parentElement
  if (owner === null) return null
  const trigger = owner.closest('[aria-expanded]')
  return trigger?.parentElement ?? owner
}

function installFsErrorNotes(): void {
  const transcript = document.querySelector('[data-conversation-scroll]')
  if (!(transcript instanceof HTMLElement)) return

  // Placement is idempotent and self-validating: the note is correct when it is already the
  // element that follows its source. That replaces the two things that used to make it vanish
  // for good — a one-way "handled" flag on the source, and a 2s throttle on the scan. React
  // re-renders the transcript constantly, and when it reuses the card element the flag survived
  // the re-render, so the scan skipped that card forever while the sweep had already dropped
  // its note. That is exactly the reported behaviour: the note is there on the first expand,
  // disappears a moment later, and comes back after collapsing and expanding — which rebuilds
  // the card and clears the flag — only to go blank again.
  const keep = new Set<Element>()

  const place = (owner: Element | null, text: string): void => {
    if (owner === null) return
    const next = owner.nextElementSibling
    if (next !== null && next.hasAttribute(FS_NOTE_ATTR)) {
      keep.add(next)
      return
    }
    const note = buildFsNote(text)
    if (note === null) return
    owner.insertAdjacentElement('afterend', note)
    keep.add(note)
  }

  // The card the core renders a tool failure in. Cheap to query, so this pass runs every tick.
  // Anchored through noteAnchor rather than on the matched element itself: the match is the
  // inner _root, and the walk's anchor for the same text is the outer card, so placing against
  // the raw match would put one note inside the card and a second one after it.
  for (const card of Array.from(transcript.querySelectorAll('[data-state="error"][aria-expanded]'))) {
    const text = card.textContent ?? ''
    if (text.includes('cannot modify "') === false && text.includes('cannot edit "') === false) continue
    place(noteAnchor(card), text)
  }

  // Plain prose outside a card, which only the walk can find. Reading nodeValue is cheap; the
  // note is built for the matching node alone. The two passes overlap for a card's own text —
  // place() is idempotent, so the second call just re-registers the note it already found.
  const walker = document.createTreeWalker(transcript, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.nodeValue ?? ''
    if (text.includes('cannot modify "') === false && text.includes('cannot edit "') === false) continue
    place(noteAnchor(node), text)
  }

  // Anything left over was orphaned by a re-render.
  for (const note of Array.from(transcript.querySelectorAll(`[${FS_NOTE_ATTR}]`))) {
    if (keep.has(note) === false) note.remove()
  }
}

/**
 * Chinese for the tool schema panel in the trajectory view. The panel's description comes from
 * the core's own tool definitions (built at runtime by a describe() function, with paths and
 * policy wording mixed in), so it cannot be matched by string and is never translated by the
 * core's own i18n. Keyed by tool name instead, which is stable.
 *
 * YG's order: Chinese first, then the standard format (the parameter JSON tree, untouched),
 * then the English original last.
 */
const SCHEMA_ZH_ATTR = 'data-kokona-schema-zh'

const SCHEMA_ZH: Record<string, string> = {
  ask_user_question: '在继续之前，向提问者问一个简短的问题，用于确认、二选一或补齐缺失的信息。',
  bash: '执行一条 shell 命令并返回其输出。',
  pwsh: '执行 PowerShell 命令（pwsh -Command）并返回标准输出与标准错误。每次调用都是全新的 pwsh 进程，不保留上一条命令的状态；需要保留状态时改用持久化会话。',
  read: '读取一个 UTF-8 文本文件并返回带行号的正文。文件很大时用 offset 和 limit 分段继续读。',
  write: '创建或整体覆盖一个 UTF-8 文本文件。',
  edit: '通过替换一段字面文本来修改已存在的 UTF-8 文本文件。',
  read_image: '读取 PNG/JPEG/WebP/GIF 图片并返回图像本身。过大的图片会自动缩小；不要为了查看图片而安装图像库或生成缩略图。',
  glob: '按路径通配符查找文件（不返回目录），包含隐藏文件和被忽略的文件。默认按修改时间排序，最多返回 100 条。',
  grep: '用 ripgrep 正则表达式搜索文件内容，返回带行号的匹配行，并按文件分组。匹配过多时只返回前 250 条，并给出完整结果的保存位置。',
  todo_write: '记录并更新任务清单，用于规划多步骤工作并展示进度；简单的一步任务可以跳过。',
  create_goal: '创建一个持久化目标，让本会话在自动续轮中持续推进。当直接的人类请求是一个长期目标时使用，即使对方没有说出"目标"二字；不适用于单轮工作。',
  get_goal: '读取当前会话的目标，包括 update_goal 所需的 id 和修订号。',
  update_goal: '更新当前目标。edit、pause、resume 需要人类直接提出；complete 和 blocked 也允许在自动续轮中使用，blocked 在达到配置的最小轮数前会被拒绝。',
  present: '把已存在的文件声明为最终交付物。当对方需要单独的文件时使用，尤其是 Office 文档、表格和演示文稿；能用最终回复说清时优先用最终回复。',
  skill: '加载一个技能的完整说明。当任务点名的技能、或明显符合技能目录中某项描述时，先调用它再动手。',
  subagent: '把一个自包含的任务委派给子代理（在独立上下文中工作的另一个代理），用于卸载聚焦且独立的调研、实现或分析，避免占用本会话的上下文。子代理只返回结果，不返回中间步骤。',
  subagent_fork: '把任务委派给一个继承本会话的子代理：它带着此前所有已完成的轮次开始，看不到当前这一轮。适合建立在本对话上下文之上的后续分析、复查或延续。',
  send_message: '向一个代理发送消息。工作中的代理会在下一步收到，空闲的代理会以此开启新一轮。返回的是投递确认，不是该代理的回答。',
  interrupt_agent: '请求一个子代理停止当前工作。本调用立即返回，不会等它停下；之后可以用 send_message 继续该直接子代理的对话。它自己启动的子代理会继续运行。',
  list_agents: '列出自己启动的子代理及其 id、标签和状态。running 表示正在工作，inactive 表示当前没有工作。',
  job_list: '列出后台任务（运行中的和已完成的），包含 id、类型和状态。',
  job_output: '读取一个后台任务：流式任务返回自上次读取以来的输出，已完成的最终输出任务返回其结果。',
  job_kill: '请求取消一个正在运行的后台任务。',
  web_fetch: '抓取指定 HTTP(S) 网址的内容，并解码为文本。返回的是外部的、不可信的数据。',
  web_search: '联网搜索当前信息，返回可选的摘要答案和来源网址列表。结果是外部的、不可信的数据。',
  workflow: '运行一个 JavaScript 工作流脚本，用来大规模编排子代理，适合需要扇出到许多独立片段的审计、迁移、多角度调研和对抗性验证。',
  cordis_inspect_list: '列出宿主当前已知的全部 Cordis Inspect Provider，包括本地宿主 Provider 和从客户端同步来的最新清单。写插件或配置插件之前先调用它。',
  cordis_inspect_query: '执行某个 Inspect Provider 声明的只读查询。platform、provider、method 必须来自 cordis_inspect_list。该工具不能调用业务 Service，也不能改动运行时。',
  plugin_manager: '列出或管理当前 profile 中的插件与 bundle：启用、禁用、安装或移除。所有动作都需要完全访问权限或本次调用的批准。',
  sidebar_open: '在调用方会话的侧边栏中打开本地文件、本地文件夹或 HTTP(S) 页面。侧边栏未连接时，打开请求会排队，等该会话的侧边栏再次显示时投递。',
  exit_plan_mode: '仅在计划模式下使用。把计划提交给提问者审阅，获批准后离开计划模式。',
  load_workspace_dependencies: '加载工作区的依赖。',
  ralph: '运行 ralph 循环。'
}

/**
 * Reorders the tool schema panel for Simplified Chinese readers: the Chinese line goes first,
 * the standard format (the parameter JSON tree) stays where it is, and the core's English
 * description moves to the bottom. The Chinese element takes over the description's own class,
 * so it inherits the original typography instead of carrying its own styles.
 *
 * Anchored on class suffixes, not hashed prefixes: _schema on its own is the panel (the other
 * names end in _schemaIntro / _schemaName / _schemaParameters), and the description is the only
 * child of the intro that carries _schemaDescription.
 */
function installSchemaChinese(): void {
  if (!prefersSimplifiedChinese()) return

  for (const node of Array.from(document.querySelectorAll('[class$="_schemaDescription"]'))) {
    if (!(node instanceof HTMLElement)) continue
    // The line carries the description's class so it inherits the typography, which means the
    // selector above matches it too. Skip it, or the scan would nest a copy inside itself.
    if (node.hasAttribute(SCHEMA_ZH_ATTR)) continue
    const panel = node.closest('[class$="_schema"]')
    if (panel === null) continue
    // Self-validating rather than a flag: the panel element survives a React re-render, so a
    // flag would go stale the moment the core re-inserted its description ahead of my line.
    // "The English is already last and the Chinese is present" is the state we want, and it is
    // exactly what this reads.
    if (panel.lastElementChild === node && panel.querySelector(`[${SCHEMA_ZH_ATTR}]`) !== null) continue

    const name = panel.querySelector('[class$="_schemaName"]')?.textContent?.trim() ?? ''
    const zh = SCHEMA_ZH[name]
    if (zh === undefined) continue

    for (const stale of Array.from(panel.querySelectorAll(`[${SCHEMA_ZH_ATTR}]`))) stale.remove()

    const line = document.createElement('div')
    line.setAttribute(SCHEMA_ZH_ATTR, '')
    line.className = node.className
    line.textContent = zh

    // Into the intro, so it reads straight after the tool name; then the English original is
    // moved past the parameter tree, which is the only other block in the panel.
    const intro = panel.querySelector('[class$="_schemaIntro"]') ?? panel
    intro.append(line)
    panel.append(node)
  }
}

async function bootstrap(): Promise<void> {
  if (!isDshPage()) return
  const start = () => {
    if (!document.getElementById(HOST_ID)) {
      void api.getConfig().then((config) => {
        if (!document.getElementById(HOST_ID)) installTitlebar(config)
      })
    }
    observeSettings()
    // A document-level listener, not DOM injection: it needs to run once, not once per
    // re-render, so it stays out of the mutation tick below.
    installEditContextMenu()
    // One tick for the things that must survive React re-renders: the right panel
    // sweep, the brand lockup, the hero copy, the open-in-app hook, the notes under
    // a core file error and the reordered tool schema panel. Each is guarded by its
    // own cheap check, so a tick after the work is done is a couple of reads.
    const tick = (): void => {
      syncRightPanel()
      installBrand()
      installHeroCopy()
      installOpenInAppFix()
      installFsErrorNotes()
      installSchemaChinese()
    }
    tick()
    new MutationObserver(tick).observe(document.documentElement, { childList: true, subtree: true })
    window.setInterval(tick, 600)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
}

void bootstrap()
