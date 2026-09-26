import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { exec } from '../exec'
import { createLogger } from '../logger'
import type { NodeRuntime } from '../node'
import { buildCoreEnv } from './env'
import { waitForServer } from './readiness'

const log = createLogger('core')
const URL_PATTERN = /https?:\/\/127\.0\.0\.1:\d+[^\s'"]*/g

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function findFreePort(preferred: number): Promise<number> {
  const tryPort = (port: number) =>
    new Promise<boolean>((resolve) => {
      const server = createServer()
      server.unref()
      server.on('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
    })
  if (await tryPort(preferred)) return preferred
  return new Promise((resolve) => {
    const server = createServer()
    server.unref()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : preferred
      server.close(() => resolve(port))
    })
  })
}

export interface CoreStartOptions {
  /** The Node to run the core with. Carries whether it is the app's own Electron binary. */
  node: NodeRuntime
  binPath: string
  cwd: string
  profile: string
  port: number
  dshHome: string
  onLog?: (line: string) => void
  onExit?: (code: number | null) => void
}

export class CoreProcess {
  private child: ChildProcess | null = null
  private discoveredUrl: string | null = null
  private tokenUrl: string | null = null
  private exited = false
  url: string | null = null

  get running(): boolean {
    return this.child !== null && !this.exited
  }

  async start(options: CoreStartOptions): Promise<string> {
    await this.stop()
    this.exited = false
    this.discoveredUrl = null
    this.tokenUrl = null
    this.url = null

    const args = [
      options.binPath,
      '--profile',
      options.profile,
      '--no-open',
      '--port',
      String(options.port)
    ]
    log.info(`spawning core: ${options.node.exe} ${args.join(' ')}`)
    const child = spawn(options.node.exe, args, {
      cwd: options.cwd,
      env: buildCoreEnv(options.dshHome),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child

    const consume = (chunk: Buffer) => {
      const text = chunk.toString()
      options.onLog?.(text)
      for (const match of text.matchAll(URL_PATTERN)) {
        const url = match[0]
        if (url.includes('token=')) this.tokenUrl = url
        else if (!this.discoveredUrl) this.discoveredUrl = url
      }
    }
    child.stdout?.on('data', consume)
    child.stderr?.on('data', consume)
    // A superseded child keeps emitting; ignore it so a restart cannot abort
    // the new attempt through the shared `exited` flag.
    child.on('exit', (code) => {
      if (this.child !== child) return
      this.exited = true
      log.warn(`core exited with code ${code}`)
      options.onExit?.(code)
    })
    child.on('error', (error) => {
      if (this.child !== child) return
      this.exited = true
      log.error(`core spawn error: ${error.message}`)
    })

    const fallback = `http://127.0.0.1:${options.port}/`
    const ready = await waitForServer(fallback, {
      isAborted: () => this.exited,
      getOverride: () => this.tokenUrl ?? this.discoveredUrl
    })
    if (!ready) {
      const detail = this.exited ? 'core process exited before the server came up' : 'timed out waiting for the core server'
      throw new Error(detail)
    }

    const deadline = Date.now() + 5000
    while (!this.tokenUrl && !this.discoveredUrl && Date.now() < deadline) await sleep(100)

    this.url = this.tokenUrl ?? this.discoveredUrl ?? fallback
    if (!this.tokenUrl) log.warn('core did not print a tokenized URL; loading the plain loopback URL')
    log.info(`core ready at ${this.url}`)
    return this.url
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    if (!child || child.exitCode !== null) return
    const pid = child.pid
    if (!pid) return
    // Wait for the process to actually go away so its port and profile locks
    // are released before the next start.
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve()
      child.once('exit', () => resolve())
      setTimeout(resolve, 5000)
    })
    if (process.platform === 'win32') {
      await exec('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined)
    } else {
      child.kill('SIGTERM')
    }
    await exited
    if (child.exitCode === null) {
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
      await exited
    }
  }
}
