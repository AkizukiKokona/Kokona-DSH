import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '../shared/constants'
import { diagLine, installDiagnostics } from './diagnostics'
import type { KokonaApi, UpdateInfo } from '../shared/api'
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
  getLogs: () => ipcRenderer.invoke(IPC.logs) as Promise<string[]>,
  reportTheme: (theme) => ipcRenderer.send(IPC.reportTheme, theme),
  checkShellUpdate: () => ipcRenderer.invoke(IPC.checkShellUpdate) as Promise<ShellUpdateInfo>,
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url) as Promise<void>,
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
html:not([data-theme="dark"]):not(:has(body[data-ds-dark-theme])) { --kokona-surface-soft: rgba(245, 246, 247, 0.72); --kokona-surface-glass: rgba(255, 255, 255, 0.72); --kokona-surface-chip: rgba(250, 250, 250, 0.72); --kokona-surface-selected: rgba(255, 255, 255, 0.95); --kokona-selected-ring: rgba(0, 0, 0, 0.35); }
html[data-theme="dark"], body[data-ds-dark-theme] { --kokona-surface-soft: rgba(255, 255, 255, 0.07); --kokona-surface-glass: rgba(255, 255, 255, 0.07); --kokona-surface-chip: rgba(255, 255, 255, 0.07); --kokona-surface-selected: rgba(255, 255, 255, 0.16); --kokona-selected-ring: rgba(255, 255, 255, 0.9); }
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
[class*="_tools"] [class*="_add"]:not([class*="_add"] *) { background-color: var(--kokona-surface-soft) !important; }
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
   plugin only re-tints that token inside the settings dialog — and the plugin tints
   the surfaces inside it (terminalWrap, browserBar, paneCard) with the 侧栏 sliders,
   so the bar reads as a solid sheet rather than as the composer's glass. Give the
   dock the same treatment as the right panel: the composer's veil as its own fill,
   and the composer's values in the sidebar variables its children consume. */
body[data-we-sidebar-glass] [class*="_bottomPanel"] {
  background-color: var(--kokona-surface-glass) !important;
  --we-sidebar-blur: var(--we-blur, 16px);
  --we-sidebar-tint: calc(var(--we-glass-alpha, 0.2) * 80%);
  --we-sidebar-saturate: var(--we-saturate, 1.8);
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
  diagLine(`shift ${element.getAttribute('class') ?? element.tagName} -> ${shift}px`)
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
          diagLine(
            `layout pending ${wanted}px (was ${applied}px) on ` +
              `${entry.element.getAttribute('class') ?? entry.element.tagName} ` +
              `rect=${Math.round(entry.rect.left)},${Math.round(entry.rect.right)} boundary=${Math.round(boundary)}`
          )
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

async function bootstrap(): Promise<void> {
  if (!isDshPage()) return
  const start = () => {
    if (!document.getElementById(HOST_ID)) {
      void api.getConfig().then((config) => {
        if (!document.getElementById(HOST_ID)) installTitlebar(config)
      })
    }
    observeSettings()
    syncRightPanel()
    new MutationObserver(syncRightPanel).observe(document.documentElement, { childList: true, subtree: true })
    window.setInterval(syncRightPanel, 600)
    installDiagnostics()
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
}

void bootstrap()
