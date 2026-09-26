import { statSync } from 'node:fs'
import { app, BrowserWindow, clipboard, ipcMain, shell as electronShell } from 'electron'
import { IPC, type WindowAction } from '../shared/constants'
import type { EditAction, EditContextState, EditMenuEntry } from '../shared/api'
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

function normalizeEditContext(value: unknown): EditContextState {
  const source = (value ?? {}) as Record<string, unknown>
  return {
    editable: source.editable === true,
    hasSelection: source.hasSelection === true,
    hasContent: source.hasContent === true
  }
}

/**
 * The menu for one right-click, as a pure function of what the click landed on, what is on
 * the clipboard, and the locale. Pure so the enablement rules can be checked without a
 * window and without a page.
 *
 * Enablement follows what the click actually landed on. Cut and copy need a selection,
 * paste needs a writable field and a clipboard that is not empty, and select-all needs
 * something to select. An empty field with an empty clipboard therefore shows the menu
 * with every entry greyed rather than offering operations that would do nothing.
 *
 * The key hints are spelled out because nothing supplies them for free, and they are
 * display-only: this menu registers no shortcuts.
 */
export function editMenuEntries(
  state: EditContextState,
  hasClipboardText: boolean,
  locale: string,
  platform: NodeJS.Platform
): EditMenuEntry[] {
  const zh = locale.toLowerCase().startsWith('zh')
  const label = (key: keyof (typeof EDIT_LABELS)['en']): string =>
    zh ? EDIT_LABELS.zh[key] : EDIT_LABELS.en[key]
  const mod = platform === 'darwin' ? '⌘' : 'Ctrl+'
  const canPaste = state.editable && hasClipboardText

  if (!state.editable) {
    // Read-only, or not writable at all: offer only what still means something.
    return [
      {
        action: 'copy',
        label: label('copy'),
        accelerator: `${mod}C`,
        enabled: state.hasSelection,
        separated: false
      },
      {
        action: 'selectAll',
        label: label('selectAll'),
        accelerator: `${mod}A`,
        enabled: state.hasContent || state.hasSelection,
        separated: true
      }
    ]
  }

  return [
    { action: 'cut', label: label('cut'), accelerator: `${mod}X`, enabled: state.hasSelection, separated: false },
    { action: 'copy', label: label('copy'), accelerator: `${mod}C`, enabled: state.hasSelection, separated: false },
    { action: 'paste', label: label('paste'), accelerator: `${mod}V`, enabled: canPaste, separated: false },
    { action: 'selectAll', label: label('selectAll'), accelerator: `${mod}A`, enabled: state.hasContent, separated: true }
  ]
}

export function registerIpc(shell: Shell): void {
  ipcMain.handle(IPC.editContext, (_event, state: unknown) =>
    editMenuEntries(
      normalizeEditContext(state),
      clipboard.readText() !== '',
      app.getLocale() ?? '',
      process.platform
    )
  )
  // The actions are Electron's own rather than reimplemented: they run on whatever the
  // focused element is, go through that element's own undo history, and keep the
  // platform's conventions. The page keeps focus in the field, so they land where the
  // click did.
  ipcMain.on(IPC.editAction, (event, action: unknown) => {
    const contents = event.sender
    switch (action as EditAction) {
      case 'cut':
        contents.cut()
        break
      case 'copy':
        contents.copy()
        break
      case 'paste':
        contents.paste()
        break
      case 'selectAll':
        contents.selectAll()
        break
      default:
        break
    }
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
