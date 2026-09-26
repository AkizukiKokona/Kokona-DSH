import { statSync } from 'node:fs'
import { app, BrowserWindow, clipboard, ipcMain, Menu, shell as electronShell, type MenuItemConstructorOptions } from 'electron'
import { IPC, type WindowAction } from '../shared/constants'
import type { EditContextState } from '../shared/api'
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

/**
 * Show one path in the OS file manager.
 *
 * The core's open-in-app route hands a file to `explorer.exe` as a launch target,
 * which does nothing at all for a file — Explorer opens a target, it does not
 * "open with" one, so the click lands nowhere. Selecting the file in its folder is
 * what an entry called File Explorer actually promises, and Explorer additionally
 * needs `/select,` and its target joined into a single argument; handing them over
 * as two argv entries makes Explorer ignore the selection. `showItemInFolder` is
 * Electron's own reveal and gets both right. A directory is opened instead, because
 * selecting a folder inside its parent is not what the entry promises.
 */
async function revealPath(target: string): Promise<void> {
  try {
    if (statSync(target).isDirectory()) {
      await electronShell.openPath(target)
      return
    }
    electronShell.showItemInFolder(target)
  } catch {
    // A vanished path must not reject the gesture; the renderer ignores the result.
  }
}

const EDIT_LABELS = {
  zh: { cut: '剪切', copy: '复制', paste: '粘贴', selectAll: '全选' },
  en: { cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All' }
} as const

function editLabel(key: keyof (typeof EDIT_LABELS)['en']): string {
  const locale = (app.getLocale() ?? '').toLowerCase()
  return locale.startsWith('zh') ? EDIT_LABELS.zh[key] : EDIT_LABELS.en[key]
}

/**
 * A Menu that is collected while it is still open can take the window down with it, so
 * the live popup is held here until the next one replaces it.
 */
let openEditMenu: Menu | null = null

function normalizeEditContext(value: unknown): EditContextState {
  const source = (value ?? {}) as Record<string, unknown>
  return {
    editable: source.editable === true,
    hasSelection: source.hasSelection === true,
    hasContent: source.hasContent === true
  }
}

/**
 * The menu for one right-click, as a pure function of what the click landed on and what
 * is on the clipboard. Kept separate from the popup so the enablement rules can be
 * checked without a window.
 *
 * Enablement follows what the click actually landed on. Cut and copy need a selection,
 * paste needs a writable field and a clipboard that is not empty, and select-all needs
 * something to select. An empty field with an empty clipboard therefore shows the menu
 * with every entry greyed rather than offering operations that would do nothing.
 *
 * Accelerators are spelled out rather than left to the role: a role does not bring its
 * own, so without them the popup shows no key hints at all. On a popup menu they are
 * display-only — they do not register anything application-wide.
 */
export function editMenuTemplate(
  state: EditContextState,
  clipboardText: string
): MenuItemConstructorOptions[] {
  const canPaste = state.editable && clipboardText !== ''
  if (!state.editable) {
    // Read-only, or not writable at all: offer only what still means something.
    return [
      { role: 'copy', label: editLabel('copy'), accelerator: 'CommandOrControl+C', enabled: state.hasSelection },
      { type: 'separator' },
      {
        role: 'selectAll',
        label: editLabel('selectAll'),
        accelerator: 'CommandOrControl+A',
        enabled: state.hasContent || state.hasSelection
      }
    ]
  }
  return [
    { role: 'cut', label: editLabel('cut'), accelerator: 'CommandOrControl+X', enabled: state.hasSelection },
    { role: 'copy', label: editLabel('copy'), accelerator: 'CommandOrControl+C', enabled: state.hasSelection },
    { role: 'paste', label: editLabel('paste'), accelerator: 'CommandOrControl+V', enabled: canPaste },
    { type: 'separator' },
    {
      role: 'selectAll',
      label: editLabel('selectAll'),
      accelerator: 'CommandOrControl+A',
      enabled: state.hasContent
    }
  ]
}

/**
 * The composer has no context menu because Electron ships no default one: a right-click
 * on a text field lands on nothing at all. Build a native menu and let Electron's own
 * roles perform the edit — they act on the focused webContents, so they stay correct for
 * plain fields and rich-text surfaces alike, and they go through the field's own undo
 * history instead of rewriting its value behind its back.
 */
function showEditContextMenu(window: BrowserWindow, state: EditContextState): void {
  openEditMenu = Menu.buildFromTemplate(editMenuTemplate(state, clipboard.readText()))
  openEditMenu.popup({ window })
}

export function registerIpc(shell: Shell): void {
  ipcMain.on(IPC.contextMenu, (event, state: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window) showEditContextMenu(window, normalizeEditContext(state))
  })
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
  ipcMain.handle(IPC.revealPath, (_event, target: unknown) => {
    if (typeof target !== 'string' || target === '') return undefined
    return revealPath(target)
  })
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
