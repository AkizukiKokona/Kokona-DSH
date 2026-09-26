import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Channel, ChannelInfo } from '../../shared/types'
import { PACKED_MODULES_DIR, activeFile, baselineDir, dshBinPath, runtimeRoot, versionDir } from '../paths'
import { createLogger } from '../logger'
import { loadConfig } from '../config'
import { installCore } from './installer'
import { fetchChannels, resolveChannelVersion } from './registry'
import { resolveNodeRuntime } from '../node'

const log = createLogger('runtime')

export type CoreSource = 'baseline' | 'registry'

interface ActiveRecord {
  version: string
  source: CoreSource
  channel: Channel
}

function readActive(): ActiveRecord | null {
  try {
    if (!existsSync(activeFile())) return null
    const raw = JSON.parse(readFileSync(activeFile(), 'utf8')) as Partial<ActiveRecord>
    if (typeof raw.version !== 'string') return null
    return {
      version: raw.version,
      source: raw.source === 'baseline' ? 'baseline' : 'registry',
      channel: raw.channel === 'beta' ? 'beta' : 'stable'
    }
  } catch {
    return null
  }
}

function writeActive(record: ActiveRecord): void {
  mkdirSync(runtimeRoot(), { recursive: true })
  writeFileSync(activeFile(), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
}

export function listInstalledVersions(): string[] {
  try {
    if (!existsSync(runtimeRoot())) return []
    return readdirSync(runtimeRoot(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(dshBinPath(entry.name)))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

export function getActiveVersion(): string | null {
  const active = readActive()
  if (active && existsSync(dshBinPath(active.version))) return active.version
  const installed = listInstalledVersions()
  return installed.length ? installed[installed.length - 1] : null
}

export function getActiveSource(): CoreSource | null {
  return readActive()?.source ?? null
}

export function readBaselineVersion(): string | null {
  try {
    const manifest = join(baselineDir(), 'manifest.json')
    if (!existsSync(manifest)) return null
    const raw = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }
    return typeof raw.version === 'string' ? raw.version : null
  } catch {
    return null
  }
}

function installFromBaseline(version: string): boolean {
  const source = baselineDir()
  if (!existsSync(join(source, PACKED_MODULES_DIR))) return false
  const target = versionDir(version)
  log.info(`seeding core ${version} from bundled baseline`)
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  cpSync(source, target, { recursive: true })
  // The bundle stores the tree under PACKED_MODULES_DIR because electron-builder silently drops
  // any directory named node_modules from extraResources.
  renameSync(join(target, PACKED_MODULES_DIR), join(target, 'node_modules'))
  return existsSync(dshBinPath(version))
}

export interface EnsureResult {
  version: string
  source: CoreSource
  channel: Channel
}

export type PhaseReporter = (phase: 'installing-core') => void

export async function ensureCore(
  onLine?: (line: string) => void,
  onPhase?: PhaseReporter
): Promise<EnsureResult> {
  const config = loadConfig()
  const active = readActive()
  if (active && existsSync(dshBinPath(active.version))) {
    return { version: active.version, source: active.source, channel: active.channel }
  }

  const node = resolveNodeRuntime()
  if (!node) {
    throw new Error('No Node runtime available. Set nodePath in config.json.')
  }

  if (active) {
    log.info(`active core ${active.version} is incomplete; reinstalling it without a registry lookup`)
    onPhase?.('installing-core')
    await installCore({ version: active.version, node, onLine })
    writeActive({ version: active.version, source: active.source, channel: active.channel })
    return { version: active.version, source: active.source, channel: active.channel }
  }

  const baselineVersion = readBaselineVersion()
  if (baselineVersion && installFromBaseline(baselineVersion)) {
    writeActive({ version: baselineVersion, source: 'baseline', channel: config.channel })
    return { version: baselineVersion, source: 'baseline', channel: config.channel }
  }

  let channels: ChannelInfo
  try {
    channels = await fetchChannels()
  } catch (error) {
    throw new Error(`No bundled core and the registry is unreachable: ${(error as Error).message}`)
  }
  const version = resolveChannelVersion(channels, config.channel)
  if (!version) throw new Error(`No published version found for channel "${config.channel}".`)

  onPhase?.('installing-core')
  await installCore({ version, node, onLine })
  writeActive({ version, source: 'registry', channel: config.channel })
  return { version, source: 'registry', channel: config.channel }
}

export async function installVersion(version: string, onLine?: (line: string) => void): Promise<void> {
  const node = resolveNodeRuntime()
  if (!node) throw new Error('No Node runtime available. Set nodePath in config.json.')
  await installCore({ version, node, onLine })
}

export function switchTo(version: string, channel: Channel): void {
  if (!existsSync(dshBinPath(version))) throw new Error(`core ${version} is not installed`)
  writeActive({ version, source: 'registry', channel })
}

export async function checkForUpdate(): Promise<{ current: string | null; latest: string | null; channel: Channel }> {
  const config = loadConfig()
  const channels = await fetchChannels()
  return {
    current: getActiveVersion(),
    latest: resolveChannelVersion(channels, config.channel),
    channel: config.channel
  }
}
