import type { AppConfig, RuntimeSnapshot, ShellUpdateInfo, WindowState } from './types'

export interface UpdateInfo {
  current: string | null
  latest: string | null
  channel: string
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
  reloadUi(): void
  openTerminal(): Promise<void>
  revealData(): Promise<string>
  getLogs(): Promise<string[]>
  reportTheme(theme: 'dark' | 'light'): void
  checkShellUpdate(): Promise<ShellUpdateInfo>
  openExternal(url: string): Promise<void>
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
