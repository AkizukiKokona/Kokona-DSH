import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { bundledNodeDir } from '../node'
import { shimDir } from './shims'

/**
 * Environment for any child that runs the core's JavaScript.
 *
 * ELECTRON_RUN_AS_NODE is always removed. The core runs on a real Node (see node.ts), and a stray
 * value inherited from the parent would only confuse the addons that fingerprint their runtime.
 */
export function buildCoreEnv(dshHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: dshHome, FORCE_COLOR: '0', NO_COLOR: '1' }
  delete env.ELECTRON_RUN_AS_NODE

  const parts: string[] = []
  // First, so the core and everything it spawns use the same Node the app shipped with.
  const nodeDir = bundledNodeDir()
  if (nodeDir !== null) parts.push(nodeDir)
  if (process.platform === 'win32' && process.env.APPDATA) {
    parts.push(join(process.env.APPDATA, 'npm'))
  }
  parts.push(env.PATH ?? env.Path ?? '')
  // Last: the core installs a profile's dependencies by shelling out to `pnpm` by bare name, and
  // on a machine with nothing installed that name only resolves because of the shim written here.
  const shim = shimDir()
  if (existsSync(shim)) parts.push(shim)

  const merged = parts.filter((part) => part !== '').join(delimiter)
  env.PATH = merged
  env.Path = merged
  return env
}
