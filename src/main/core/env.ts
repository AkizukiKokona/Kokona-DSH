import { join } from 'node:path'

export function buildCoreEnv(dshHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: dshHome, FORCE_COLOR: '0', NO_COLOR: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  if (process.platform === 'win32' && process.env.APPDATA) {
    const npmGlobal = join(process.env.APPDATA, 'npm')
    const current = env.PATH ?? env.Path ?? ''
    const merged = `${npmGlobal};${current}`
    env.PATH = merged
    env.Path = merged
  }
  return env
}
