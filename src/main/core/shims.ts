import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../logger'
import type { NodeRuntime } from '../node'
import { userDataDir } from '../paths'

const log = createLogger('shims')

/** Where the app keeps the PATH shims it hands to child processes. */
export function shimDir(): string {
  return join(userDataDir(), 'bin')
}

function pnpmRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'pnpm')
    : join(app.getAppPath(), 'resources', 'pnpm')
}

/**
 * The pnpm entry, and whether it is a JS script or a standalone binary.
 *
 * Read from the package's own `bin` field rather than hard-coded: the entry moved between majors -
 * a `.cjs` in some releases, a platform `.exe` in others - and a path that is wrong here fails
 * only when a profile install runs on a machine that has no pnpm of its own, which is the one case
 * the shim exists for.
 */
function pnpmEntry(): { path: string; standalone: boolean } | null {
  try {
    const root = pnpmRoot()
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      bin?: string | Record<string, string>
    }
    const relative = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.pnpm
    if (relative === undefined) return null
    const entry = join(root, relative)
    if (!existsSync(entry)) return null
    // A .js/.cjs has to go through Node; anything else is a standalone platform binary that runs
    // itself. Matched on the script extensions rather than on .exe, because the binary on macOS
    // and Linux carries no extension at all.
    const standalone = !/\.(c|m)?js$/i.test(entry)
    return { path: entry, standalone }
  } catch {
    return null
  }
}

function writeShim(file: string, lines: string[]): void {
  writeFileSync(file, `${lines.join('\r\n')}\r\n`, 'utf8')
}

/**
 * The core shells out to `pnpm` by bare name when it installs a profile's dependencies, and a
 * machine that installed nothing has no pnpm to resolve that name to. This writes a `pnpm` - and a
 * `node`, for the tools that look for one - backed by the Node the app ships with.
 *
 * Appended to PATH rather than prepended: a user who has their own Node and pnpm keeps them. These
 * are the fallback that makes a bare machine work, not a replacement for a working install.
 */
export function ensureRuntimeShims(node: NodeRuntime): string | null {
  if (process.platform !== 'win32') return null
  try {
    const dir = shimDir()
    mkdirSync(dir, { recursive: true })
    writeShim(join(dir, 'node.cmd'), ['@echo off', `"${node.exe}" %*`])
    const pnpm = pnpmEntry()
    if (pnpm === null) {
      log.warn('no usable bundled pnpm found; a profile install will need one on PATH')
    } else {
      // A platform binary runs itself; a .cjs has to go through Node.
      const invocation = pnpm.standalone ? `"${pnpm.path}"` : `"${node.exe}" "${pnpm.path}"`
      writeShim(join(dir, 'pnpm.cmd'), ['@echo off', `${invocation} %*`])
    }
    return dir
  } catch (error) {
    log.warn(`could not write runtime shims: ${(error as Error).message}`)
    return null
  }
}
