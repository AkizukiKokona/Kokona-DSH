import { app } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../logger'
import type { NodeRuntime } from '../node'
import { userDataDir } from '../paths'

const log = createLogger('shims')

/** Where the app keeps the PATH shims it hands to child processes. */
export function shimDir(): string {
  return join(userDataDir(), 'bin')
}

function pnpmEntry(): string | null {
  const root = app.isPackaged
    ? join(process.resourcesPath, 'pnpm')
    : join(app.getAppPath(), 'resources', 'pnpm')
  const entry = join(root, 'bin', 'pnpm.cjs')
  return existsSync(entry) ? entry : null
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
      log.warn('no bundled pnpm found; a profile install will need one on PATH')
    } else {
      writeShim(join(dir, 'pnpm.cmd'), ['@echo off', `"${node.exe}" "${pnpm}" %*`])
    }
    return dir
  } catch (error) {
    log.warn(`could not write runtime shims: ${(error as Error).message}`)
    return null
  }
}
