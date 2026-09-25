import { join } from 'node:path'
import { app, BrowserWindow, globalShortcut, Menu } from 'electron'
import { APP_NAME } from '../shared/constants'
import { registerIpc } from './ipc'
import { isQuitting, setQuitting } from './lifecycle'
import { Shell } from './shell'
import { createTray, destroyTray } from './tray'
import { createMainWindow, getMainWindow, togglePanelWindow } from './windows'

const preloadPath = join(__dirname, '../preload/index.js')
const shell = new Shell()

app.setName(APP_NAME)
if (process.platform === 'win32') app.setAppUserModelId('com.kokona.dsh')

function showMainWindow(): void {
  const window = getMainWindow()
  if (!window) {
    createMainWindow(preloadPath)
    void shell.boot()
    return
  }
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function quitApp(): void {
  setQuitting(true)
  app.quit()
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    registerIpc(shell)
    createMainWindow(preloadPath)
    createTray({ show: showMainWindow, quit: quitApp })
    globalShortcut.register('CommandOrControl+Shift+K', () => togglePanelWindow(preloadPath))
    await shell.boot()

    app.on('activate', () => showMainWindow())
  })

  app.on('window-all-closed', () => {
    // Stay resident: closing the window hides it. Quitting is explicit via the tray.
    if (isQuitting()) app.quit()
  })

  let shuttingDown = false
  app.on('before-quit', (event) => {
    if (shuttingDown) return
    event.preventDefault()
    shuttingDown = true
    setQuitting(true)
    globalShortcut.unregisterAll()
    void shell.stop().finally(() => {
      destroyTray()
      for (const window of BrowserWindow.getAllWindows()) window.destroy()
      app.quit()
    })
  })
}
