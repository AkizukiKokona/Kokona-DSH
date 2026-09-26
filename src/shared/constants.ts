import type { AppConfig, Channel } from './types'

export const APP_NAME = 'KokonaHarness'
export const DISPLAY_NAME = 'KokonaHarness'
export const DSH_PACKAGE = '@deepseek-ai/dsh'
export const NPM_REGISTRY = 'https://registry.npmjs.org'
export const DEFAULT_PROFILE = 'kokona'
export const SAFE_PROFILE_SUFFIX = '-safe'
export const DEFAULT_PORT = 19387
export const DEFAULT_CHANNEL: Channel = 'beta'
export const PRESET_PLUGINS = ['dsh-better-sidebar', 'dshmarket']
export const TITLEBAR_HEIGHT_FALLBACK = 48
export const SERVER_READY_TIMEOUT_MS = 120_000
export const SERVER_POLL_INTERVAL_MS = 350

export const DEFAULT_CONFIG: AppConfig = {
  channel: DEFAULT_CHANNEL,
  profile: DEFAULT_PROFILE,
  port: DEFAULT_PORT,
  dshHome: null,
  nodePath: null,
  presetPlugins: [...PRESET_PLUGINS],
  titlebar: {
    height: TITLEBAR_HEIGHT_FALLBACK,
    theme: 'auto',
    controls: 'custom',
    insetRight: 0
  },
  autoUpdateCore: false,
  safeMode: false,
  lastTheme: null,
  updateSource: 'auto',
  fixWorkspaceAcl: true
}

export const IPC = {
  snapshot: 'kokona:snapshot',
  phase: 'kokona:phase',
  windowControl: 'kokona:window-control',
  windowState: 'kokona:window-state',
  checkUpdates: 'kokona:check-updates',
  installCore: 'kokona:install-core',
  switchCore: 'kokona:switch-core',
  restartCore: 'kokona:restart-core',
  restartSafe: 'kokona:restart-safe',
  relaunchApp: 'kokona:relaunch-app',
  reloadUi: 'kokona:reload-ui',
  openTerminal: 'kokona:open-terminal',
  getConfig: 'kokona:get-config',
  setConfig: 'kokona:set-config',
  revealData: 'kokona:reveal-data',
  revealPath: 'kokona:reveal-path',
  editContext: 'kokona:edit-context',
  editAction: 'kokona:edit-action',
  logs: 'kokona:logs',
  reportTheme: 'kokona:report-theme',
  checkShellUpdate: 'kokona:check-shell-update',
  openExternal: 'kokona:open-external'
} as const

export type WindowAction = 'minimize' | 'maximize' | 'unmaximize' | 'toggle-maximize' | 'close'
