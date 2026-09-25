import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '../shared/constants'
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
`
  document.head.appendChild(style)
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

    const reserve = 3 * 46 + 12
    const shiftTargets = new Set<HTMLElement>()
    for (const element of appElements) {
      if (!element.matches('button, a[href], [role="button"]')) continue
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue
      if (rect.top >= height || rect.bottom <= 0) continue
      if (rect.left < width * 0.5) continue
      if (rect.left >= width) continue
      const cluster = element.closest('[class*="_headerUtilities"], [class*="_headerCorner"]')
      shiftTargets.add(cluster instanceof HTMLElement ? cluster : (element as HTMLElement))
    }
    const targets = Array.from(shiftTargets).filter(
      (target) => !Array.from(shiftTargets).some((other) => other !== target && other.contains(target))
    )
    for (const target of targets) target.style.marginRight = `${reserve}px`

    controls.style.paddingRight = `${config.titlebar.insetRight}px`

    const blocked: Rect[] = []
    const controlsRect = controls.getBoundingClientRect()
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

  layout()
  window.addEventListener('resize', schedule)
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true })
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
    [zh ? '重启' : 'Restart', false, () => void api.restartCore()],
    [zh ? '重启进安全模式（屏蔽全部插件）' : 'Restart in safe mode (all plugins off)', true, () => void api.restartSafe()]
  ]
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
  restart.title = zh ? '重新加载界面 / 重启 / 重启进安全模式' : 'Reload / restart / restart in safe mode'
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

function settingsRoot(): HTMLElement | null {
  const close = document.querySelector('button[class*="_close"]')
  const panel = close?.closest('[class*="_panel"]')
  return panel instanceof HTMLElement ? panel : null
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
    'position:absolute;inset:0;overflow:auto;padding:8px 24px 24px;background:var(--dsw-alias-bg-layer-2,#17171d);color:var(--dsw-alias-label-primary,#e8e8ee);'
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
    'display:none;margin:12px 0 0;max-height:220px;overflow:auto;background:#0b0b10;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));border-radius:8px;padding:10px;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word;'
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

function closeUpdateTab(): void {
  updatePanel?.remove()
  updatePanel = null
}

function openUpdateTab(): void {
  if (updatePanel && !document.contains(updatePanel)) updatePanel = null
  if (updatePanel) return
  const root = settingsRoot()
  if (!root) return
  const options = root.querySelector('[class*="_options"]')
  if (!(options instanceof HTMLElement)) return
  options.style.position = 'relative'
  updatePanel = buildUpdatePanel()
  options.appendChild(updatePanel)
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
  let scheduled = 0
  const run = () => {
    if (scheduled) return
    scheduled = window.setTimeout(() => {
      scheduled = 0
      injectSettingsActions()
      injectSettingsTabs()
    }, 250)
  }
  injectSettingsActions()
  injectSettingsTabs()
  new MutationObserver(run).observe(document.body, { childList: true, subtree: true })
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
    window.setInterval(syncRightPanel, 600)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
}

void bootstrap()
