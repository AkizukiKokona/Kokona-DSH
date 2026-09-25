import { Menu, Tray, nativeImage } from 'electron'
import { DISPLAY_NAME } from '../shared/constants'
import { createLogger } from './logger'
import { iconPath } from './paths'

const log = createLogger('tray')

let tray: Tray | null = null

export interface TrayHandlers {
  show: () => void
  quit: () => void
}

export function createTray(handlers: TrayHandlers): void {
  if (tray) return
  try {
    const source = iconPath()
    let image = source ? nativeImage.createFromPath(source) : nativeImage.createEmpty()
    if (!image.isEmpty()) image = image.resize({ width: 16, height: 16 })
    tray = new Tray(image)
    tray.setToolTip(DISPLAY_NAME)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示主界面', click: () => handlers.show() },
        { type: 'separator' },
        { label: '退出', click: () => handlers.quit() }
      ])
    )
    tray.on('click', () => handlers.show())
    tray.on('double-click', () => handlers.show())
    log.info('tray created')
  } catch (error) {
    log.warn(`tray unavailable: ${(error as Error).message}`)
  }
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
