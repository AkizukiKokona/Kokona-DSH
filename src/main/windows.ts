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
    const cubes = (await window.webContents.executeJavaScript(`(() => {
      const list = Array.from(document.querySelectorAll('[class*="_themeCube"]'))
      return JSON.stringify(list.map((cube) => {
        const style = getComputedStyle(cube)
        return {
          text: (cube.textContent || '').slice(0, 8),
          pressed: cube.getAttribute('aria-pressed'),
          borderWidth: style.borderWidth,
          borderColor: style.borderColor,
          bg: style.backgroundColor
        }
      }))
    })()`)) as string
    log.info(`theme cubes: ${cubes}`)
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

async function scanSettingsBackgrounds(window: BrowserWindow): Promise<void> {
  if (!process.env.KOKONA_SETTINGS_SCAN) return
  try {
    await window.webContents.executeJavaScript(`(() => {
      const trigger = document.querySelector('button[class*="_trigger"]') || document.querySelector('[class*="triggerRow"] button')
      if (trigger) trigger.click()
    })()`)
    await new Promise((resolve) => setTimeout(resolve, 1800))
    const navCount = (await window.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('button[class*="_close"]')?.closest('[class*="_panel"]')
      const list = panel?.querySelector('[class*="_navList"]')
      return list ? list.children.length : 0
    })()`)) as number
    log.info(`settings scan: nav cells=${navCount}`)
    for (let index = 0; index < navCount; index += 1) {
      await window.webContents.executeJavaScript(`(() => {
        const panel = document.querySelector('button[class*="_close"]')?.closest('[class*="_panel"]')
        const list = panel?.querySelector('[class*="_navList"]')
        const cell = list?.children[${index}]
        if (cell) cell.click()
      })()`)
      await new Promise((resolve) => setTimeout(resolve, 900))
      const result = (await window.webContents.executeJavaScript(`(() => {
          const root = document.querySelector('button[class*="_close"]')?.closest('[class*="_panel"]') || document.body
          const buckets = new Map()
          for (const el of root.querySelectorAll('*')) {
            const r = el.getBoundingClientRect()
            if (r.width < 24 || r.height < 16) continue
            const cs = getComputedStyle(el)
            const bg = cs.backgroundColor
            if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') continue
            let bucket = buckets.get(bg)
            if (!bucket) {
              bucket = { bg, count: 0, area: 0, opaque: 0, sample: [] }
              buckets.set(bg, bucket)
            }
            bucket.count += 1
            bucket.area += r.width * r.height
            const m = /,\\s*([\\d.]+)\\)$/.exec(bg)
            const alpha = m ? Number(m[1]) : 1
            if (alpha >= 0.99) bucket.opaque += 1
            if (bucket.sample.length < 3) {
              bucket.sample.push({
                tag: el.tagName,
                cls: String(el.className).slice(0, 46),
                parent: el.parentElement ? String(el.parentElement.className).slice(0, 34) : null,
                w: Math.round(r.width), h: Math.round(r.height)
              })
            }
          }
          return JSON.stringify([...buckets.values()].sort((a, b) => b.area - a.area).slice(0, 8))
        })()`)) as string
      log.info(`settings palette ${index}: ${result}`)
    }
  } catch (error) {
    log.warn(`settings scan failed: ${(error as Error).message}`)
  }
}

async function scanChatSurfaces(window: BrowserWindow): Promise<void> {
  if (!process.env.KOKONA_CHAT_SCAN) return
  for (let round = 1; round <= 10 && !window.isDestroyed(); round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10000))
    try {
      const result = (await window.webContents.executeJavaScript(`(() => {
      const alphaOf = (value) => {
        const slash = /\\/\\s*([\\d.]+)\\s*\\)$/.exec(value)
        if (slash) return Number(slash[1])
        const comma = /,\\s*([\\d.]+)\\s*\\)$/.exec(value)
        if (comma) return Number(comma[1])
        return 1
      }
      const buckets = new Map()
      for (const el of document.body.querySelectorAll('*')) {
        if (el.closest('#kokona-titlebar') || el.closest('[class*="_panel"]')) continue
        const r = el.getBoundingClientRect()
        if (r.width < 8 || r.height < 8) continue
        if (r.bottom < 0 || r.top > window.innerHeight) continue
        const cs = getComputedStyle(el)
        const bg = cs.backgroundColor
        if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') continue
        if (alphaOf(bg) < 0.99) continue
        let bucket = buckets.get(bg)
        if (!bucket) {
          bucket = { bg, count: 0, area: 0, sample: [] }
          buckets.set(bg, bucket)
        }
        bucket.count += 1
        bucket.area += r.width * r.height
        if (bucket.sample.length < 6) {
          bucket.sample.push({
            tag: el.tagName,
            cls: String(el.className).slice(0, 50),
            parent: el.parentElement ? String(el.parentElement.className).slice(0, 38) : null,
            text: (el.textContent || '').trim().slice(0, 16),
            x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)
          })
        }
      }
      return JSON.stringify([...buckets.values()].sort((a, b) => b.area - a.area).slice(0, 8))
    })()`)) as string
      log.info(`chat palette ${round}: ${result}`)
      for (const selector of ['[class*="_newSession"]', '[class*="_file"]']) {
        const subtree = (await window.webContents.executeJavaScript(
          `(() => {
            const root = document.querySelector(${JSON.stringify(selector)})
            if (!root) return 'absent'
            const rows = []
            const walk = (el, depth) => {
              const cs = getComputedStyle(el)
              const before = getComputedStyle(el, '::before')
              const after = getComputedStyle(el, '::after')
              const r = el.getBoundingClientRect()
              rows.push({
                depth,
                tag: el.tagName,
                cls: String(el.className).slice(0, 40),
                bg: cs.backgroundColor,
                bgi: cs.backgroundImage === 'none' ? null : cs.backgroundImage.slice(0, 60),
                bf: cs.backdropFilter === 'none' ? null : cs.backdropFilter.slice(0, 30),
                bBefore: before.content === 'none' ? null : before.background.slice(0, 60),
                bAfter: after.content === 'none' ? null : after.background.slice(0, 60),
                w: Math.round(r.width), h: Math.round(r.height)
              })
              for (const child of el.children) walk(child, depth + 1)
            }
            walk(root, 0)
            return JSON.stringify(rows)
          })()`
        )) as string
        log.info(`subtree ${selector} ${round}: ${subtree}`)
      }
    } catch (error) {
      log.warn(`chat scan failed: ${(error as Error).message}`)
    }
  }
}

function startAnalyze(window: BrowserWindow): void {
  if (!process.env.KOKONA_ANALYZE) return
  let count = 0
  const timer = setInterval(() => {
    count += 1
    if (count > 18 || window.isDestroyed()) {
      clearInterval(timer)
      return
    }
    void window.webContents
      .capturePage()
      .then((image) => {
        const size = image.getSize()
        if (!size.width || !size.height) return
        const buffer = image.toBitmap()
        const lum = (x: number, y: number): number => {
          const i = (y * size.width + x) * 4
          return 0.114 * buffer[i] + 0.587 * buffer[i + 1] + 0.299 * buffer[i + 2]
        }
        const sharp = (x0: number, y0: number, x1: number, y1: number): number => {
          let sum = 0
          let n = 0
          for (let y = y0 + 1; y < y1; y += 3) {
            for (let x = x0 + 1; x < x1; x += 3) {
              sum += Math.abs(lum(x, y) - lum(x - 1, y)) + Math.abs(lum(x, y) - lum(x, y - 1))
              n += 1
            }
          }
          return n ? Math.round((sum / n) * 10) / 10 : 0
        }
        const w = size.width
        const h = size.height
        const half = Math.floor(w / 2)
        const mid = Math.floor(h / 2)
        log.info(
          `analyze ${count}: L=${sharp(0, 0, half, h)} R=${sharp(half, 0, w, h)} T=${sharp(0, 0, w, mid)} B=${sharp(0, mid, w, h)}`
        )
      })
      .catch(() => undefined)
  }, 8000)
}

async function dumpOverlays(window: BrowserWindow): Promise<void> {
  if (!process.env.KOKONA_DOM) return
  await new Promise((resolve) => setTimeout(resolve, 12000))
  try {
    const result = (await window.webContents.executeJavaScript(`(() => {
      const vw = window.innerWidth
      const vh = window.innerHeight
      const body = {}
      for (const a of ['data-dsh-sidebar-collapsed', 'data-we-wallpaper', 'data-we-appwindow', 'data-ds-dark-theme']) {
        body[a] = document.body.getAttribute(a)
      }
      const large = []
      for (const el of document.querySelectorAll('*')) {
        const r = el.getBoundingClientRect()
        const area = r.width * r.height
        if (area < vw * vh * 0.06 || r.width < 60 || r.height < 60) continue
        const cs = getComputedStyle(el)
        const bf = cs.backdropFilter || cs.webkitBackdropFilter
        const hasBlur = bf && bf !== 'none'
        if (!hasBlur) continue
        large.push({
          tag: el.tagName,
          cls: String(el.className).slice(0, 80),
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          bf: bf.slice(0, 50), bg: cs.backgroundColor, op: cs.opacity
        })
      }
      return JSON.stringify({ vw, vh, body, large: large.slice(0, 25) })
    })()`)) as string
    log.info(`overlays: ${result}`)
  } catch (error) {
    log.warn(`overlay dump failed: ${(error as Error).message}`)
  }
}

async function inspectRightPanel(window: BrowserWindow): Promise<void> {
  if (!process.env.KOKONA_RIGHTPANEL) return
  try {
    const data = (await window.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('[data-sidebar-right-panel]')
      const panelInfo = panel
        ? (() => {
            const r = panel.getBoundingClientRect()
            return {
              mode: panel.getAttribute('data-sidebar-right-panel'),
              inlineTransform: panel.style.transform || null,
              computedTransform: getComputedStyle(panel).transform,
              x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height)
            }
          })()
        : null
      const chain = []
      let node = panel
      while (node && node !== document.body && chain.length < 8) {
        const r = node.getBoundingClientRect()
        const cs = getComputedStyle(node)
        chain.push({
          tag: node.tagName,
          cls: String(node.className).slice(0, 40),
          x: Math.round(r.x), w: Math.round(r.width),
          inline: node.style.transform || null,
          computed: cs.transform === 'none' ? null : cs.transform.slice(0, 50),
          pos: cs.position
        })
        node = node.parentElement
      }
      const transforms = []
      for (const el of document.querySelectorAll('*')) {
        const cs = getComputedStyle(el)
        if (cs.transform === 'none') continue
        const r = el.getBoundingClientRect()
        if (r.width < 120 || r.height < 120) continue
        transforms.push({
          cls: String(el.className).slice(0, 46),
          inline: el.style.transform || null,
          computed: cs.transform.slice(0, 46),
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)
        })
        if (transforms.length >= 20) break
      }
      return JSON.stringify({ panelInfo, chain, transforms })
    })()`)) as string
    log.info(`panel debug: ${data}`)
    const styles = (await window.webContents.executeJavaScript(`(() => {
      const pick = (el, keys) => {
        if (!el) return null
        const cs = getComputedStyle(el)
        const r = el.getBoundingClientRect()
        const out = { x: Math.round(r.x), w: Math.round(r.width) }
        for (const k of keys) out[k] = cs[k]
        return out
      }
      const panel = document.querySelector('[data-sidebar-right-panel]')
      const col = document.querySelector('[class*="_rightbarCol"]')
      const frame = document.querySelector('[class*="_frame"]')
      return JSON.stringify({
        panel: pick(panel, ['display', 'visibility', 'opacity', 'overflow', 'pointerEvents', 'zIndex', 'clipPath']),
        col: pick(col, ['overflow', 'overflowX', 'overflowY', 'display', 'visibility', 'clipPath']),
        frame: pick(frame, ['overflow', 'display'])
      })
    })()`)) as string
    log.info(`panel styles: ${styles}`)
  } catch (error) {
    log.warn(`right panel inspect failed: ${(error as Error).message}`)
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
      await scanSettingsBackgrounds(window)
      void scanChatSurfaces(window)
      startAnalyze(window)
      await dumpOverlays(window)
      await inspectRightPanel(window)
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
