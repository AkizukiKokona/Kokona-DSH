import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_CONFIG } from '../shared/constants'
import type { AppConfig } from '../shared/types'
import { configFile } from './paths'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function mergeConfig(raw: unknown): AppConfig {
  const base: AppConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG))
  if (!isRecord(raw)) return base
  if (raw.channel === 'stable' || raw.channel === 'beta') base.channel = raw.channel
  if (typeof raw.profile === 'string' && raw.profile.trim()) base.profile = raw.profile.trim()
  if (typeof raw.port === 'number' && raw.port > 0) base.port = raw.port
  if (typeof raw.dshHome === 'string' && raw.dshHome.trim()) base.dshHome = raw.dshHome.trim()
  if (typeof raw.nodePath === 'string' && raw.nodePath.trim()) base.nodePath = raw.nodePath.trim()
  if (Array.isArray(raw.presetPlugins)) {
    base.presetPlugins = raw.presetPlugins.filter((item): item is string => typeof item === 'string')
  }
  if (typeof raw.autoUpdateCore === 'boolean') base.autoUpdateCore = raw.autoUpdateCore
  if (typeof raw.safeMode === 'boolean') base.safeMode = raw.safeMode
  if (raw.lastTheme === 'dark' || raw.lastTheme === 'light') base.lastTheme = raw.lastTheme
  if (raw.updateSource === 'auto' || raw.updateSource === 'github' || raw.updateSource === 'codeberg') {
    base.updateSource = raw.updateSource
  }
  if (typeof raw.fixWorkspaceAcl === 'boolean') base.fixWorkspaceAcl = raw.fixWorkspaceAcl
  if (isRecord(raw.titlebar)) {
    const tb = raw.titlebar
    if (typeof tb.height === 'number' && tb.height > 0) base.titlebar.height = tb.height
    if (tb.theme === 'auto' || tb.theme === 'dark' || tb.theme === 'light') base.titlebar.theme = tb.theme
    if (tb.controls === 'custom' || tb.controls === 'native') base.titlebar.controls = tb.controls
    if (typeof tb.insetRight === 'number' && tb.insetRight >= 0) base.titlebar.insetRight = tb.insetRight
  }
  return base
}

let cached: AppConfig | null = null

export function loadConfig(): AppConfig {
  if (cached) return cached
  try {
    if (existsSync(configFile())) {
      cached = mergeConfig(JSON.parse(readFileSync(configFile(), 'utf8')))
      return cached
    }
  } catch {
    // fall through to defaults on a corrupt file
  }
  cached = mergeConfig(null)
  return cached
}

export function saveConfig(next: AppConfig): AppConfig {
  cached = mergeConfig(next)
  mkdirSync(dirname(configFile()), { recursive: true })
  writeFileSync(configFile(), `${JSON.stringify(cached, null, 2)}\n`, 'utf8')
  return cached
}

export function patchConfig(patch: Partial<AppConfig>): AppConfig {
  return saveConfig({ ...loadConfig(), ...patch })
}
