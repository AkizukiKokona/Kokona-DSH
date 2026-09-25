import { BrowserWindow, shell } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DISPLAY_NAME, IPC } from '../shared/constants'
import type { WindowState } from '../shared/types'
import { isQuitting } from './lifecycle'
import { createLogger } from './logger'
import { iconPath } from './paths'

const log = createLogger('window')

let mainWindow: BrowserWindow | null = null
let panelWindow: BrowserWindow | null = null

function maybeCapture(window: BrowserWindow): void {
  const target = process.env.KOKONA_CAPTURE
  if (!target) return
  window.webContents.on('did-finish-load', () => {
    if (!window.webContents.getURL().startsWith('http')) return
    setTimeout(() => {
      void window.webContents
        .capturePage()
        .then((image) => {
          writeFileSync(target, image.toPNG())
          log.info(`captured page to ${target}`)
        })
        .catch((error: Error) => log.warn(`capture failed: ${error.message}`))
    }, 5000)
  })
}

const DIAGNOSTIC = `(() => {
  const host = document.getElementById('kokona-titlebar')
  const controls = host ? host.querySelector('.kokona-controls') : null
  const brand = document.querySelector('[data-slot="sidebar.brand.name"]') || document.querySelector('[data-slot="sidebar.brand.mark"]')
  const root = document.getElementById('root')
  const rect = (node) => { if (!node) return null; const b = node.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } }
  const clearance = getComputedStyle(document.documentElement).getPropertyValue('--dsh-frame-top-clearance').trim()
  const rootPadTop = root ? getComputedStyle(root).paddingTop : null
  const centerTop = document.elementFromPoint(Math.round(window.innerWidth / 2), 24)
  const buttons = controls ? Array.from(controls.querySelectorAll('button')) : []
  const buttonRects = buttons.map((b) => ({ label: b.dataset.kokonaControl, rect: rect(b) }))
  const under = {}
  for (const b of buttons) {
    const r = b.getBoundingClientRect()
    const cx = Math.round(r.left + r.width / 2)
    const cy = Math.round(r.top + r.height / 2)
    under[b.dataset.kokonaControl] = document
      .elementsFromPoint(cx, cy)
      .filter((el) => !host.contains(el))
      .slice(0, 3)
      .map((el) => el.tagName + '.' + String(el.className).slice(0, 60))
  }
  const topControls = []
  for (const el of document.querySelectorAll('button, a[href], [role="button"]')) {
    if (host.contains(el)) continue
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    if (r.top >= 48 || r.bottom <= 0) continue
    if (r.left < window.innerWidth * 0.5) continue
    topControls.push(Math.round(r.left) + '..' + Math.round(r.right) + ' ' + el.tagName + '.' + String(el.className).slice(0, 40))
  }
  const chains = []
  for (const el of document.querySelectorAll('button, a[href], [role="button"]')) {
    if (host.contains(el)) continue
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) continue
    if (r.top >= 48 || r.bottom <= 0) continue
    if (r.left < window.innerWidth * 0.5) continue
    const parts = []
    let node = el
    for (let i = 0; i < 5 && node; i += 1) {
      const nr = node.getBoundingClientRect()
      parts.push(node.tagName + '.' + String(node.className).slice(0, 40) + '[' + Math.round(nr.left) + '..' + Math.round(nr.right) + ']')
      node = node.parentElement
    }
    chains.push(parts.join(' < '))
  }
  return JSON.stringify({
    title: document.title,
    clearance,
    rootPadTop,
    dark: document.body.dataset.dsDarkTheme !== undefined,
    host: rect(host),
    controls: rect(controls),
    brand: rect(brand),
    root: rect(root),
    centerTopTag: centerTop ? centerTop.tagName + '.' + String(centerTop.className).slice(0, 40) : null,
    dragSegments: host ? host.querySelectorAll('.kokona-drag').length : 0,
    buttonRects,
    under,
    topControls,
    chains,
    hasApi: typeof window.kokona === 'object' && typeof window.kokona.window.minimize === 'function'
  })
})()`

async function runSelfTest(window: BrowserWindow): Promise<void> {
  if (!process.env.KOKONA_SELFTEST) return
  try {
    await window.webContents.executeJavaScript('window.kokona.window.toggleMaximize()')
    await new Promise((resolve) => setTimeout(resolve, 700))
    const maximized = window.isMaximized()
    await window.webContents.executeJavaScript('window.kokona.window.toggleMaximize()')
    await new Promise((resolve) => setTimeout(resolve, 700))
    const restored = !window.isMaximized()
    log.info(`selftest: maximize=${maximized} restore=${restored}`)
    await window.webContents.executeJavaScript('window.kokona.window.close()')
    await new Promise((resolve) => setTimeout(resolve, 600))
    log.info(`selftest: hiddenOnClose=${!window.isVisible()} stillRunning=${!window.isDestroyed()}`)
    window.show()
  } catch (error) {
    log.warn(`selftest failed: ${(error as Error).message}`)
  }
}

async function testSettingsActions(window: BrowserWindow): Promise<void> {
  if (!process.env.KOKONA_SETTINGS_TEST) return
  try {
    const clicked = (await window.webContents.executeJavaScript(`(() => {
      const trigger = document.querySelector('button[class*="_trigger"]') || document.querySelector('[class*="triggerRow"] button')
      if (!trigger) return 'no-trigger'
      trigger.click()
      return 'clicked'
    })()`)) as string
    await new Promise((resolve) => setTimeout(resolve, 1800))
    const result = (await window.webContents.executeJavaScript(`(() => {
      const actions = document.querySelector('[data-kokona-actions]')
      const closeButton = document.querySelector('button[class*="_close"]')
      return JSON.stringify({
        injected: Boolean(actions),
        buttons: actions ? Array.from(actions.querySelectorAll('button')).map((b) => b.textContent) : [],
        settingsOpen: Boolean(closeButton)
      })
    })()`)) as string
    log.info(`settings test: ${clicked} -> ${result}`)
    const structure = (await window.webContents.executeJavaScript(`(() => {
      const close = document.querySelector('button[class*="_close"]')
      const panel = close ? close.closest('[class*="_panel"]') : null
      const navList = panel ? panel.querySelector('[class*="_navList"]') : null
      const navCell = navList ? navList.querySelector('[class*="_navCell"]') : null
      const options = panel ? panel.querySelector('[class*="_options"]') : null
      return JSON.stringify({
        close: Boolean(close),
        panel: Boolean(panel),
        navList: Boolean(navList),
        navCell: Boolean(navCell),
        options: Boolean(options),
        navChildren: navList ? navList.children.length : -1,
        updateNav: Boolean(document.querySelector('[data-kokona-update-nav]'))
      })
    })()`)) as string
    log.info(`settings structure: ${structure}`)
    const menuClick = (await window.webContents.executeJavaScript(`(() => {
      const actions = document.querySelector('[data-kokona-actions]')
      const buttons = actions ? Array.from(actions.querySelectorAll('button')) : []
      const restart = buttons.find((b) => /重启菜单|Restart menu/.test(b.textContent || ''))
      if (!restart) return 'no-restart-button'
      restart.click()
      return 'menu-clicked'
    })()`)) as string
    await new Promise((resolve) => setTimeout(resolve, 500))
    const menuResult = (await window.webContents.executeJavaScript(`(() => {
      const menu = document.querySelector('.kokona-menu')
      return JSON.stringify({ open: Boolean(menu), items: menu ? Array.from(menu.querySelectorAll('button')).map((b) => b.textContent) : [] })
    })()`)) as string
    log.info(`settings menu: ${menuClick} -> ${menuResult}`)
    const navResult = (await window.webContents.executeJavaScript(`(() => {
      const nav = document.querySelector('[data-kokona-update-nav]')
      if (!nav) return 'no-nav'
      nav.click()
      return 'nav-clicked'
    })()`)) as string
    await new Promise((resolve) => setTimeout(resolve, 600))
    const panelResult = (await window.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('[data-kokona-update-panel]')
      if (!panel) return JSON.stringify({ open: false })
      const sections = Array.from(panel.querySelectorAll('div'))
        .map((node) => node.textContent)
        .filter((text) => text === '内核更新' || text === '外壳更新')
      return JSON.stringify({ open: true, sections })
    })()`)) as string
    log.info(`settings update tab: ${navResult} -> ${panelResult}`)
    await window.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('[data-kokona-update-panel]')
      if (!panel) return
      const button = Array.from(panel.querySelectorAll('button')).find((b) => b.textContent === '检查外壳更新')
      if (button) button.click()
    })()`)
    await new Promise((resolve) => setTimeout(resolve, 4500))
    const shellStatus = (await window.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('[data-kokona-update-panel]')
      if (!panel) return null
      const paragraphs = Array.from(panel.querySelectorAll('p'))
      return paragraphs.length ? paragraphs[paragraphs.length - 1].textContent : null
    })()`)) as string | null
    log.info(`settings shell update status: ${shellStatus}`)
  } catch (error) {
    log.warn(`settings test failed: ${(error as Error).message}`)
  }
}

async function testSidebar(window: BrowserWindow): Promise<void> {
  if (!process.env.KOKONA_SIDEBAR_TEST) return
  try {
    const dump = () => window.webContents.executeJavaScript(DIAGNOSTIC) as Promise<string>
    const toggle = `(() => {
      const candidates = ['button[class*="_toggleButton"]', 'button[class*="_sidebar"]', 'button[aria-label*="sidebar" i]', 'button[aria-label*="侧" i]']
      for (const selector of candidates) {
        const node = document.querySelector(selector)
        if (node) { node.click(); return selector }
      }
      return 'no-toggle'
    })()`
    log.info(`sidebar closed: ${await dump()}`)
    const clicked = (await window.webContents.executeJavaScript(toggle)) as string
    log.info(`sidebar toggle: ${clicked}`)
    await new Promise((resolve) => setTimeout(resolve, 1400))
    log.info(`sidebar open: ${await dump()}`)
    await window.webContents.executeJavaScript(toggle)
  } catch (error) {
    log.warn(`sidebar test failed: ${(error as Error).message}`)
  }
}

async function verifyPage(window: BrowserWindow): Promise<void> {
  try {
    const url = window.webContents.getURL()
    const injected = (await window.webContents.executeJavaScript(
      "Boolean(document.getElementById('kokona-titlebar'))"
    )) as boolean
    log.info(`page loaded: ${url} titlebar=${injected}`)
    log.info(`window title: ${window.getTitle()}`)
    if (!injected && url.startsWith('file:')) {
      await new Promise((resolve) => setTimeout(resolve, 400))
      const splash = (await window.webContents.executeJavaScript(`(() => {
        const logo = document.querySelector('.splash__logo')
        const spinner = document.querySelector('.spinner')
        const dot = spinner ? spinner.querySelector('span') : null
        return JSON.stringify({
          splash: Boolean(spinner),
          dots: spinner ? spinner.children.length : 0,
          logoLoaded: logo ? Boolean(logo.complete && logo.naturalWidth > 0) : false,
          theme: document.documentElement.dataset.theme || null,
          dotAnimation: dot ? getComputedStyle(dot).animationName : null,
          bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
        })
      })()`)) as string
      log.info(`splash check: ${splash}`)
    }
    if (injected) {
      await new Promise((resolve) => setTimeout(resolve, 2500))
      const diagnostic = (await window.webContents.executeJavaScript(DIAGNOSTIC)) as string
      log.info(`titlebar geometry: ${diagnostic}`)
      await runSelfTest(window)
      await testSettingsActions(window)
      await testSidebar(window)
    }
  } catch (error) {
    log.warn(`page check failed: ${(error as Error).message}`)
  }
}

function emitWindowState(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  const state: WindowState = {
    maximized: window.isMaximized(),
    fullscreen: window.isFullScreen(),
    platform: process.platform
  }
  window.webContents.send(IPC.windowState, state)
}

function attachWindowState(window: BrowserWindow): void {
  const handler = () => emitWindowState(window)
  window.on('maximize', handler)
  window.on('unmaximize', handler)
  window.on('enter-full-screen', handler)
  window.on('leave-full-screen', handler)
  window.on('restore', handler)
  window.webContents.on('did-finish-load', () => emitWindowState(window))
}

function rendererEntry(): { kind: 'url'; value: string } | { kind: 'file'; value: string } {
  if (process.env.ELECTRON_RENDERER_URL) return { kind: 'url', value: process.env.ELECTRON_RENDERER_URL }
  return { kind: 'file', value: join(__dirname, '../renderer/index.html') }
}

function loadRenderer(window: BrowserWindow, hash: string): void {
  const entry = rendererEntry()
  if (entry.kind === 'url') {
    void window.loadURL(`${entry.value}${hash}`)
  } else {
    void window.loadFile(entry.value, { hash })
  }
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

export function getPanelWindow(): BrowserWindow | null {
  return panelWindow && !panelWindow.isDestroyed() ? panelWindow : null
}

export function createMainWindow(preloadPath: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#101014',
    autoHideMenuBar: true,
    icon: iconPath(),
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 14, y: 15 } }
      : { frame: false }),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })
  mainWindow = window
  attachWindowState(window)
  maybeCapture(window)
  window.setTitle(DISPLAY_NAME)
  window.on('page-title-updated', (event) => {
    event.preventDefault()
    window.setTitle(DISPLAY_NAME)
  })
  window.on('close', (event) => {
    if (!isQuitting()) {
      event.preventDefault()
      window.hide()
    }
  })
  window.webContents.on('did-finish-load', () => void verifyPage(window))
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    log.warn(`load failed (${code} ${description}) ${url}`)
  })
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    mainWindow = null
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  loadRenderer(window, '#boot')
  return window
}

export function openPanelWindow(preloadPath: string): void {
  const existing = getPanelWindow()
  if (existing) {
    existing.show()
    existing.focus()
    return
  }
  const window = new BrowserWindow({
    width: 560,
    height: 640,
    minWidth: 460,
    minHeight: 520,
    show: false,
    resizable: true,
    parent: getMainWindow() ?? undefined,
    backgroundColor: '#101014',
    autoHideMenuBar: true,
    icon: iconPath(),
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 14, y: 15 } }
      : { frame: false }),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  panelWindow = window
  attachWindowState(window)
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    panelWindow = null
  })
  loadRenderer(window, '#panel')
}

export function togglePanelWindow(preloadPath: string): void {
  const existing = getPanelWindow()
  if (existing) {
    existing.close()
    return
  }
  openPanelWindow(preloadPath)
}

export function showBootScreen(): void {
  const window = getMainWindow()
  if (window) loadRenderer(window, '#boot')
}
