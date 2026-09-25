import type { RuntimeSnapshot } from '../../shared/types'
import type { UpdateInfo } from '../../shared/api'
import { DISPLAY_NAME } from '../../shared/constants'
import iconUrl from './assets/kokona.png'

const api = window.kokona
const mountEl = document.getElementById('app')
if (!mountEl) throw new Error('missing #app')
const root: HTMLElement = mountEl

const isPanel = location.hash.startsWith('#panel')
const isMac = navigator.userAgent.includes('Mac')
document.body.dataset.mac = String(isMac)

void api
  .getConfig()
  .then((config) => {
    if (config.lastTheme) document.documentElement.dataset.theme = config.lastTheme
  })
  .catch(() => undefined)

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const ICONS: Record<string, string> = {
  minimize: 'M0.5 5 H9.5',
  maximize: 'M1 1 H9 V9 H1 Z',
  restore: 'M1 3 H7 V9 H1 Z M3 3 V1 H9 V7 H7',
  close: 'M1 1 L9 9 M9 1 L1 9'
}

function iconSvg(name: string): string {
  return `<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="${ICONS[name]}" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>`
}

function buildTitlebar(title: string): HTMLElement {
  const bar = el('div', 'titlebar')
  bar.append(el('div', 'titlebar__label', title))
  const controls = el('div', 'titlebar__controls')
  const minimize = el('button')
  minimize.dataset.action = 'minimize'
  minimize.title = 'Minimize'
  minimize.setAttribute('aria-label', 'Minimize')
  minimize.innerHTML = iconSvg('minimize')
  minimize.addEventListener('click', () => api.window.minimize())
  const maximize = el('button')
  maximize.dataset.action = 'maximize'
  maximize.title = 'Maximize'
  maximize.setAttribute('aria-label', 'Maximize')
  maximize.innerHTML = iconSvg('maximize')
  maximize.addEventListener('click', () => api.window.toggleMaximize())
  const close = el('button')
  close.dataset.action = 'close'
  close.title = 'Close'
  close.setAttribute('aria-label', 'Close')
  close.innerHTML = iconSvg('close')
  close.addEventListener('click', () => api.window.close())
  controls.append(minimize, maximize, close)
  bar.append(controls)
  api.onWindowState((state) => {
    maximize.innerHTML = iconSvg(state.maximized ? 'restore' : 'maximize')
  })
  return bar
}

const PHASE_LABEL: Record<RuntimeSnapshot['phase'], string> = {
  idle: '空闲',
  'resolving-runtime': '解析内核运行时',
  'installing-core': '安装 DSH 内核',
  'bootstrapping-profile': '准备配置与插件',
  'starting-core': '启动内核服务',
  'waiting-server': '等待内核就绪',
  ready: '就绪',
  error: '出错'
}

function spinner(): HTMLElement {
  const wrap = el('div', 'spinner')
  for (let index = 0; index < 5; index += 1) wrap.append(el('span'))
  return wrap
}

function renderBoot(): void {
  root.replaceChildren()
  root.append(buildTitlebar(DISPLAY_NAME))

  const main = el('main', 'splash')
  const center = el('div', 'splash__center')
  const logo = el('img', 'splash__logo')
  logo.src = iconUrl
  logo.alt = ''
  const name = el('div', 'splash__name', DISPLAY_NAME)
  const phaseText = el('div', 'splash__phase', '正在启动…')
  const noticeBox = el('div', 'splash__notice')
  noticeBox.hidden = true
  const errorBox = el('div', 'error splash__error')
  errorBox.hidden = true
  const actions = el('div', 'row splash__actions')
  const retry = el('button', 'action primary', '重试')
  retry.hidden = true
  retry.addEventListener('click', () => void api.restartCore())
  const detailsToggle = el('button', 'action', '详情')
  actions.append(retry, detailsToggle)
  center.append(logo, name, spinner(), phaseText, noticeBox, errorBox, actions)

  const details = el('div', 'card splash__details')
  details.hidden = true
  const kv = el('dl', 'kv')
  const logs = el('pre', 'logs', '')
  details.append(kv, el('h2', undefined, '内核日志'), logs)

  const blessing = el('div', 'splash__blessing', '“沐浴晨光方得救赎”')

  main.append(center, details, blessing)
  root.append(main)

  const refreshLogs = async (): Promise<void> => {
    try {
      logs.textContent = (await api.getLogs()).slice(-80).join('\n')
      logs.scrollTop = logs.scrollHeight
    } catch {
      // logging is best-effort
    }
  }
  detailsToggle.addEventListener('click', () => {
    details.hidden = !details.hidden
    detailsToggle.textContent = details.hidden ? '详情' : '收起详情'
    if (!details.hidden) void refreshLogs()
  })

  const paint = (snapshot: RuntimeSnapshot): void => {
    phaseText.textContent = PHASE_LABEL[snapshot.phase]
    noticeBox.textContent = snapshot.notice ?? ''
    noticeBox.hidden = !snapshot.notice
    errorBox.textContent = snapshot.error ?? ''
    errorBox.hidden = !snapshot.error
    retry.hidden = snapshot.phase !== 'error'
    if (snapshot.error) details.hidden = false
    kv.replaceChildren()
    const rows: Array<[string, string]> = [
      ['阶段', PHASE_LABEL[snapshot.phase]],
      ['外壳', snapshot.shellVersion],
      ['内核', snapshot.coreVersion ?? '无'],
      ['频道', snapshot.channel],
      ['配置', snapshot.activeProfile],
      ['安全模式', snapshot.safeMode ? '开' : '关'],
      ['DSH_HOME', snapshot.dshHome],
      ['服务', snapshot.serverUrl ?? '未运行']
    ]
    for (const [key, value] of rows) {
      kv.append(el('dt', undefined, key), el('dd', undefined, value))
    }
    if (!details.hidden) void refreshLogs()
  }

  void api.snapshot().then(paint)
  api.onSnapshot(paint)
}

function renderPanel(): void {
  root.replaceChildren()
  root.append(buildTitlebar(`${DISPLAY_NAME} · Core`))

  const main = el('main')
  main.append(el('h1', undefined, 'Core runtime'))
  main.append(el('p', 'sub', 'The app and the DSH core update separately. Install any version, then switch to it.'))

  const statusCard = el('div', 'card')
  const kv = el('dl', 'kv')
  statusCard.append(kv)

  const actionsCard = el('div', 'card')
  actionsCard.append(el('h2', undefined, 'Actions'))
  const row = el('div', 'row')
  const check = el('button', 'action', 'Check for updates')
  const restart = el('button', 'action', 'Restart core')
  const safe = el('button', 'action', 'Restart in safe mode')
  const reload = el('button', 'action', 'Reload interface')
  const terminal = el('button', 'action', 'DSH terminal')
  const data = el('button', 'action', 'Open data folder')
  restart.addEventListener('click', () => void api.restartCore())
  safe.addEventListener('click', () => void api.restartSafe())
  reload.addEventListener('click', () => api.reloadUi())
  terminal.addEventListener('click', () => void api.openTerminal())
  data.addEventListener('click', () => void api.revealData())
  row.append(check, restart, safe, reload, terminal, data)
  const updateLine = el('p', 'sub', '')
  actionsCard.append(row, updateLine)

  const versionsCard = el('div', 'card')
  versionsCard.append(el('h2', undefined, 'Installed versions'))
  const versions = el('div', 'versions')
  versionsCard.append(versions)

  main.append(statusCard, actionsCard, versionsCard)
  root.append(main)

  const paint = (next: RuntimeSnapshot): void => {
    kv.replaceChildren()
    const rows: Array<[string, string]> = [
      ['Phase', PHASE_LABEL[next.phase]],
      ['Shell', next.shellVersion],
      ['Active core', next.coreVersion ?? 'none'],
      ['Channel', next.channel],
      ['Profile', next.profile],
      ['Active profile', next.activeProfile],
      ['Safe mode', next.safeMode ? 'on' : 'off'],
      ['DSH_HOME', next.dshHome],
      ['Server', next.serverUrl ?? 'not running']
    ]
    for (const [key, value] of rows) kv.append(el('dt', undefined, key), el('dd', undefined, value))

    versions.replaceChildren()
    const list = [...next.installedVersions]
    if (next.coreVersion && !list.includes(next.coreVersion)) list.push(next.coreVersion)
    if (!list.length) {
      versions.append(el('p', 'sub', 'No core installed yet.'))
    }
    for (const version of list) {
      const item = el('div', 'version')
      const left = el('div', 'row')
      left.append(el('code', undefined, version))
      if (version === next.coreVersion) left.append(el('span', 'badge active', 'active'))
      const use = el('button', 'action', 'Use')
      use.disabled = version === next.coreVersion
      use.addEventListener('click', async () => {
        use.disabled = true
        use.textContent = 'Switching…'
        await api.switchCore(version)
      })
      item.append(left, use)
      versions.append(item)
    }
  }

  check.addEventListener('click', async () => {
    check.disabled = true
    updateLine.textContent = 'Checking…'
    try {
      const info: UpdateInfo = await api.checkUpdates()
      if (!info.latest) {
        updateLine.textContent = 'No published version found for this channel.'
      } else if (info.latest === info.current) {
        updateLine.textContent = `Up to date on ${info.channel} (${info.latest}).`
      } else {
        updateLine.textContent = `Update available: ${info.latest} (current ${info.current ?? 'none'}).`
        const install = el('button', 'action primary', `Install ${info.latest}`)
        install.addEventListener('click', async () => {
          install.disabled = true
          install.textContent = 'Installing…'
          try {
            await api.installCore(info.latest as string)
            updateLine.textContent = `Installed ${info.latest}. Use it from the list below.`
          } catch (error) {
            updateLine.textContent = `Install failed: ${(error as Error).message}`
            install.disabled = false
            install.textContent = `Install ${info.latest}`
          }
        })
        row.append(install)
      }
    } catch (error) {
      updateLine.textContent = `Check failed: ${(error as Error).message}`
    } finally {
      check.disabled = false
    }
  })

  void api.snapshot().then(paint)
  api.onSnapshot(paint)
}

if (isPanel) renderPanel()
else renderBoot()
