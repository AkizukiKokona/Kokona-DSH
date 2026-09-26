import type { AppConfig, RuntimeSnapshot, ShellUpdateInfo, WindowState } from './types'

export interface UpdateInfo {
  current: string | null
  latest: string | null
  channel: string
}

/**
 * What a right-click landed on, as far as the edit menu cares.
 *
 * The renderer reports the state; the main process decides what to enable, because only
 * the main process can read the clipboard.
 */
export interface EditContextState {
  /** A writable text field or rich-text surface: cut and paste apply. */
  editable: boolean
  /** Something is selected, so cut and copy have a subject. */
  hasSelection: boolean
  /** The field holds text, so select-all has a subject. */
  hasContent: boolean
}

export type EditAction = 'cut' | 'copy' | 'paste' | 'selectAll'

/**
 * One row of the edit menu, decided by the main process and only drawn by the renderer.
 *
 * A native menu cannot be styled at all — the OS paints it — so the menu is drawn in the
 * page to get the same frosted material as the dock and the right panel. The actions are
 * still Electron's own (`webContents.cut()` and friends), so behaviour, undo history and
 * the platform conventions are unchanged.
 */
export interface EditMenuEntry {
  action: EditAction
  label: string
  /** Display-only key hint, e.g. "Ctrl+X". */
  accelerator: string
  enabled: boolean
  /** Draw a separator above this entry. */
  separated: boolean
}

export interface KokonaApi {
  snapshot(): Promise<RuntimeSnapshot>
  getConfig(): Promise<AppConfig>
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>
  checkUpdates(): Promise<UpdateInfo>
  installCore(version: string): Promise<string[]>
  switchCore(version: string): Promise<void>
  restartCore(): Promise<void>
  restartSafe(): Promise<void>
  relaunchApp(safe: boolean): Promise<void>
  reloadUi(): void
  openTerminal(): Promise<void>
  revealData(): Promise<string>
  revealPath(path: string): Promise<void>
  getLogs(): Promise<string[]>
  reportTheme(theme: 'dark' | 'light'): void
  checkShellUpdate(): Promise<ShellUpdateInfo>
  openExternal(url: string): Promise<void>
  editContext(state: EditContextState): Promise<EditMenuEntry[]>
  editAction(action: EditAction): void
  window: {
    minimize(): void
    maximize(): void
    unmaximize(): void
    toggleMaximize(): void
    close(): void
  }
  onSnapshot(callback: (snapshot: RuntimeSnapshot) => void): () => void
  onWindowState(callback: (state: WindowState) => void): () => void
}
