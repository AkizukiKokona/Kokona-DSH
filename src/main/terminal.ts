import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter } from 'node:path'

export interface TerminalOptions {
  dshHome: string
  env: NodeJS.ProcessEnv
  binDir?: string | null
}

export function openTerminal({ dshHome, env, binDir }: TerminalOptions): void {
  const childEnv: NodeJS.ProcessEnv = { ...env }
  if (binDir && existsSync(binDir)) {
    const current = childEnv.PATH ?? childEnv.Path ?? ''
    const merged = `${binDir}${delimiter}${current}`
    childEnv.PATH = merged
    childEnv.Path = merged
  }
  const base = { detached: true, stdio: 'ignore' as const, env: childEnv, cwd: dshHome }
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/K', `title KokonaDSH Terminal && cd /d "${dshHome}"`], base).unref()
    return
  }
  if (process.platform === 'darwin') {
    spawn('open', ['-a', 'Terminal', dshHome], base).unref()
    return
  }
  const term = process.env.TERMINAL ?? 'x-terminal-emulator'
  spawn(term, [], base).unref()
}
