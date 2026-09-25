import { app } from 'electron'
import { join } from 'node:path'
import { IPC, SAFE_PROFILE_SUFFIX } from '../shared/constants'
import type { BootPhase, RuntimeSnapshot } from '../shared/types'
import { loadConfig, patchConfig } from './config'
import { buildCoreEnv } from './core/env'
import { ensureProfile } from './core/profile'
import { CoreProcess, findFreePort } from './core/process'
import { createLogger } from './logger'
import { resolveNodeExecutable } from './node'
import { defaultDshHome, dshBinPath, versionDir } from './paths'
import { checkForUpdate, ensureCore, getActiveVersion, installVersion, listInstalledVersions, switchTo } from './runtime/manager'
import { openTerminal } from './terminal'
import { getMainWindow, getPanelWindow, showBootScreen } from './windows'

const log = createLogger('shell')
const MAX_LOG_LINES = 400

export class Shell {
  private core = new CoreProcess()
  private phase: BootPhase = 'idle'
  private error: string | null = null
  private serverUrl: string | null = null
  private coreVersion: string | null = null
  private coreSource: 'baseline' | 'registry' | 'none' = 'none'
  private safeMode = false
  private notice: string | null = null
  private readonly logLines: string[] = []
  private starting = false

  snapshot(): RuntimeSnapshot {
    const config = loadConfig()
    return {
      shellVersion: app.getVersion(),
      coreVersion: this.coreVersion ?? getActiveVersion(),
      channel: config.channel,
      profile: config.profile,
      activeProfile: this.activeProfile(),
      safeMode: this.safeMode,
      dshHome: config.dshHome ?? defaultDshHome(),
      serverUrl: this.serverUrl,
      phase: this.phase,
      error: this.error,
      notice: this.notice,
      installedVersions: listInstalledVersions()
    }
  }

  private activeProfile(): string {
    const config = loadConfig()
    return this.safeMode ? `${config.profile}${SAFE_PROFILE_SUFFIX}` : config.profile
  }

  logs(): string[] {
    return [...this.logLines]
  }

  broadcast(): void {
    const payload = this.snapshot()
    for (const window of [getMainWindow(), getPanelWindow()]) {
      window?.webContents.send(IPC.snapshot, payload)
    }
  }

  private setPhase(phase: BootPhase, error: string | null = null): void {
    this.phase = phase
    this.error = error
    this.broadcast()
  }

  private logLine(chunk: string): void {
    for (const raw of chunk.split(/\r?\n/)) {
      const text = raw.trimEnd()
      if (!text) continue
      this.logLines.push(text)
      if (this.logLines.length > MAX_LOG_LINES) this.logLines.shift()
      log.info(text)
    }
  }

  async boot(): Promise<boolean> {
    if (this.starting) return false
    this.starting = true
    this.error = null
    this.safeMode = loadConfig().safeMode === true
    try {
      const config = loadConfig()
      const dshHome = config.dshHome ?? defaultDshHome()

      this.setPhase('resolving-runtime')
      const nodeExe = resolveNodeExecutable()
      if (!nodeExe) {
        throw new Error('Node.js not found. Install Node 22.19+ (winget install OpenJS.NodeJS.LTS) or set "nodePath" in config.json.')
      }

      const ensured = await ensureCore(
        (line) => this.logLine(line),
        (phase) => this.setPhase(phase)
      )
      this.coreVersion = ensured.version
      this.coreSource = ensured.source
      log.info(`core ${ensured.version} (${ensured.source})`)

      this.setPhase('bootstrapping-profile')
      const profile = this.activeProfile()
      await ensureProfile({
        nodeExe,
        binPath: dshBinPath(ensured.version),
        cwd: versionDir(ensured.version),
        dshHome,
        profile,
        coreVersion: ensured.version,
        presetPlugins: this.safeMode ? [] : config.presetPlugins,
        onLine: (line) => this.logLine(line)
      })

      this.setPhase('starting-core')
      const port = await findFreePort(config.port)
      const url = await this.core.start({
        nodeExe,
        binPath: dshBinPath(ensured.version),
        cwd: versionDir(ensured.version),
        profile,
        port,
        dshHome,
        onLog: (line) => this.logLine(line),
        onExit: (code) => {
          if (this.phase === 'ready' || this.phase === 'starting-core') {
            this.serverUrl = null
            this.setPhase('error', `core process exited (code ${code ?? 'null'})`)
          }
        }
      })

      this.serverUrl = url
      this.setPhase('ready')
      const window = getMainWindow()
      if (window) await window.loadURL(url)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error(message)
      this.setPhase('error', message)
      showBootScreen()
      return false
    } finally {
      this.starting = false
    }
  }

  async restart(options: { safe?: boolean } = {}): Promise<boolean> {
    if (typeof options.safe === 'boolean') patchConfig({ safeMode: options.safe })
    this.notice = null
    await this.core.stop()
    this.serverUrl = null
    this.phase = 'idle'
    return this.boot()
  }

  async relaunch(options: { safe?: boolean } = {}): Promise<void> {
    if (typeof options.safe === 'boolean') patchConfig({ safeMode: options.safe })
    this.notice = null
    this.broadcast()
    app.relaunch()
    app.quit()
  }

  async stop(): Promise<void> {
    await this.core.stop()
  }

  reloadUi(): void {
    getMainWindow()?.webContents.reload()
  }

  openTerminal(): void {
    const config = loadConfig()
    const dshHome = config.dshHome ?? defaultDshHome()
    const version = this.coreVersion ?? getActiveVersion()
    const binDir = version ? join(versionDir(version), 'node_modules', '.bin') : null
    openTerminal({ dshHome, env: buildCoreEnv(dshHome), binDir })
  }

  async checkUpdate(): Promise<{ current: string | null; latest: string | null; channel: string }> {
    return checkForUpdate()
  }

  async install(version: string): Promise<string[]> {
    await installVersion(version, (line) => this.logLine(line))
    this.broadcast()
    return listInstalledVersions()
  }

  async switch(version: string): Promise<void> {
    const config = loadConfig()
    const previous = getActiveVersion()
    this.notice = null
    switchTo(version, config.channel)
    this.coreVersion = version
    const ok = await this.restart()
    if (ok) return
    if (previous && previous !== version) {
      this.logLine(`switch to ${version} failed; rolling back to ${previous}`)
      switchTo(previous, config.channel)
      this.coreVersion = previous
      const recovered = await this.restart()
      this.notice = recovered
        ? `切换到 ${version} 失败（插件可能不兼容），已回滚到 ${previous}`
        : `切换到 ${version} 失败，回滚到 ${previous} 也未成功`
      this.broadcast()
    }
  }

  get source(): string {
    return this.coreSource
  }
}
