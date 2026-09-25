import { BrowserWindow, ipcMain, shell as electronShell } from 'electron'
import { IPC, type WindowAction } from '../shared/constants'
import type { AppConfig } from '../shared/types'
import { loadConfig, saveConfig } from './config'
import { userDataDir } from './paths'
import type { Shell } from './shell'
import { checkShellUpdate } from './shell-update'

function applyWindowAction(window: BrowserWindow, action: WindowAction): void {
  switch (action) {
    case 'minimize':
      window.minimize()
      break
    case 'maximize':
      window.maximize()
      break
    case 'unmaximize':
      window.unmaximize()
      break
    case 'toggle-maximize':
      if (window.isMaximized()) window.unmaximize()
      else window.maximize()
      break
    case 'close':
      window.close()
      break
  }
}

export function registerIpc(shell: Shell): void {
  ipcMain.handle(IPC.snapshot, () => shell.snapshot())
  ipcMain.handle(IPC.getConfig, () => loadConfig())
  ipcMain.handle(IPC.setConfig, (_event, patch: Partial<AppConfig>) => {
    const next = saveConfig({ ...loadConfig(), ...patch })
    shell.broadcast()
    return next
  })
  ipcMain.handle(IPC.checkUpdates, () => shell.checkUpdate())
  ipcMain.handle(IPC.installCore, (_event, version: string) => shell.install(version))
  ipcMain.handle(IPC.switchCore, (_event, version: string) => shell.switch(version))
  ipcMain.handle(IPC.restartCore, () => shell.restart())
  ipcMain.handle(IPC.restartSafe, () => shell.restart({ safe: true }))
  ipcMain.handle(IPC.relaunchApp, (_event, safe: unknown) => shell.relaunch({ safe: safe === true }))
  ipcMain.handle(IPC.reloadUi, () => shell.reloadUi())
  ipcMain.handle(IPC.openTerminal, () => shell.openTerminal())
  ipcMain.handle(IPC.revealData, () => electronShell.openPath(userDataDir()))
  ipcMain.handle(IPC.logs, () => shell.logs())
  ipcMain.handle(IPC.checkShellUpdate, () => checkShellUpdate())
  ipcMain.handle(IPC.openExternal, (_event, url: unknown) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) return electronShell.openExternal(url)
    return undefined
  })
  ipcMain.on(IPC.reportTheme, (_event, theme: unknown) => {
    if (theme === 'dark' || theme === 'light') saveConfig({ ...loadConfig(), lastTheme: theme })
  })
  ipcMain.on(IPC.windowControl, (event, action: WindowAction) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window) applyWindowAction(window, action)
  })
}
