import { app } from 'electron'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { loadConfig } from './config'

/** A Node runtime the shell can spawn the core with. */
export interface NodeRuntime {
  /** Executable to spawn. */
  exe: string
}

const WINDOWS_CANDIDATES = [
  'C:\\Program Files\\nodejs\\node.exe',
  'C:\\Program Files (x86)\\nodejs\\node.exe'
]

function fromPath(name: string): string | null {
  const pathValue = process.env.PATH ?? process.env.Path ?? ''
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * The Node that ships inside the installer.
 *
 * Deliberately a real node.exe rather than the app's own Electron binary. Electron *can* behave as
 * Node via ELECTRON_RUN_AS_NODE, and that was the first attempt here - it does not work: the core
 * loads a native addon (node-addon-require-builtin) that fingerprints the runtime and refuses
 * anything but Electron 43+, while this app is on Electron 38. The failure only shows up at boot
 * on a real machine, which is exactly where it must not.
 *
 * A real Node also gives the core what it actually expects, and decouples the bundled runtime from
 * whatever Electron version the shell happens to use.
 */
function bundledNodePath(): string | null {
  const root = app.isPackaged
    ? join(process.resourcesPath, 'node')
    : join(app.getAppPath(), 'resources', 'node')
  const exe = process.platform === 'win32' ? join(root, 'node.exe') : join(root, 'bin', 'node')
  return existsSync(exe) ? exe : null
}

export function resolveNodeRuntime(): NodeRuntime | null {
  const configured = loadConfig().nodePath
  if (configured && existsSync(configured)) return { exe: configured }

  // Present by construction in an installed copy, so a machine with nothing installed still boots.
  const bundled = bundledNodePath()
  if (bundled !== null) return { exe: bundled }

  const onPath = fromPath(process.platform === 'win32' ? 'node.exe' : 'node')
  if (onPath) return { exe: onPath }

  if (process.platform === 'win32') {
    for (const candidate of WINDOWS_CANDIDATES) {
      if (existsSync(candidate)) return { exe: candidate }
    }
  }
  return null
}

/** The directory the bundled Node lives in, for PATH purposes. */
export function bundledNodeDir(): string | null {
  const bundled = bundledNodePath()
  return bundled === null ? null : join(bundled, '..')
}

/** The executable only. Callers that spawn should use resolveNodeRuntime. */
export function resolveNodeExecutable(): string | null {
  return resolveNodeRuntime()?.exe ?? null
}

export function resolvePnpmExecutable(): string | null {
  return fromPath(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
}
