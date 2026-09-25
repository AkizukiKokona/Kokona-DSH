export type Channel = 'stable' | 'beta'

export type UpdateSource = 'auto' | 'github' | 'codeberg'

export interface ShellUpdateInfo {
  current: string
  latest: string | null
  hasUpdate: boolean
  url: string | null
  source: 'github' | 'codeberg' | null
  notes: string | null
  error: string | null
}

export type BootPhase =
  | 'idle'
  | 'resolving-runtime'
  | 'installing-core'
  | 'bootstrapping-profile'
  | 'starting-core'
  | 'waiting-server'
  | 'ready'
  | 'error'

export interface TitlebarConfig {
  height: number
  theme: 'auto' | 'dark' | 'light'
  controls: 'custom' | 'native'
  insetRight: number
}

export interface AppConfig {
  channel: Channel
  profile: string
  port: number
  dshHome: string | null
  nodePath: string | null
  presetPlugins: string[]
  titlebar: TitlebarConfig
  autoUpdateCore: boolean
  lastTheme: 'dark' | 'light' | null
  updateSource: UpdateSource
}

export interface RuntimeSnapshot {
  shellVersion: string
  coreVersion: string | null
  channel: Channel
  profile: string
  activeProfile: string
  safeMode: boolean
  dshHome: string
  serverUrl: string | null
  phase: BootPhase
  error: string | null
  notice: string | null
  installedVersions: string[]
}

export interface ChannelInfo {
  stable: string | null
  beta: string | null
}

export interface WindowState {
  maximized: boolean
  fullscreen: boolean
  platform: string
}
