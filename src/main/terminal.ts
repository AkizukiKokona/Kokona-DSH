import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter } from 'node:path'
import { DISPLAY_NAME } from '../shared/constants'
import { createLogger } from './logger'

const log = createLogger('terminal')

export interface TerminalOptions {
  dshHome: string
  env: NodeJS.ProcessEnv
  binDirs?: Array<string | null>
  /** The profile this shell boots. `dsh` refuses to run without one. */
  profile?: string
  /** Absolute path to the real dsh launcher, so the wrapper can call it by path. */
  dshBin?: string | null
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function launch(command: string, args: string[], options: Parameters<typeof spawn>[2]): void {
  const child = spawn(command, args, options)
  child.on('error', (error) => log.warn(`spawn ${command} failed: ${error.message}`))
  child.on('spawn', () => log.info(`spawned ${command} pid=${child.pid ?? '?'}`))
  child.unref()
}

export function openTerminal({ dshHome, env, binDirs = [], profile, dshBin = null }: TerminalOptions): void {
  const childEnv: NodeJS.ProcessEnv = { ...env }
  const current = childEnv.PATH ?? childEnv.Path ?? ''
  const extra = binDirs.filter((dir): dir is string => typeof dir === 'string' && existsSync(dir))
  if (extra.length) {
    const merged = [...extra, current].join(delimiter)
    childEnv.PATH = merged
    childEnv.Path = merged
  }
  if (process.platform === 'win32') {
    // stdio:'ignore' gives powershell a NUL stdin, so -NoExit still exits at
    // once and the window never shows. `start` opens a fresh console owned by
    // the new process, which survives on its own.
    const title = `${DISPLAY_NAME} Terminal`
    // `dsh` requires an explicit --profile for every command except -h, and this shell always
    // boots the configured profile, so a bare `dsh` in this window was a dead end even though
    // the button promises "dsh 可直接使用". Wrap it in a function that supplies the profile
    // unless one is already given. A function rather than an alias, so the remaining arguments
    // are forwarded positionally; -h/--help is left alone so it still prints usage.
    const wrapper =
      profile && dshBin !== null && existsSync(dshBin)
        ? `function dsh { $a = @($args); if ($a -notcontains '--profile' -and $a -notcontains '-h' -and $a -notcontains '--help') { $a = @('--profile', ${psQuote(profile)}) + $a }; & ${psQuote(dshBin)} @a }`
        : null
    const command = [
      `$host.UI.RawUI.WindowTitle = ${psQuote(title)}`,
      `Set-Location -LiteralPath ${psQuote(dshHome)}`,
      wrapper
    ]
      .filter((part): part is string => part !== null)
      .join('; ')
    launch('cmd.exe', ['/c', 'start', title, 'powershell.exe', '-NoLogo', '-NoExit', '-Command', command], {
      cwd: dshHome,
      env: childEnv,
      stdio: 'ignore',
      windowsHide: false
    })
    return
  }
  const base = { detached: true, stdio: 'ignore' as const, env: childEnv, cwd: dshHome }
  if (process.platform === 'darwin') {
    launch('open', ['-a', 'Terminal', dshHome], base)
    return
  }
  launch(process.env.TERMINAL ?? 'x-terminal-emulator', [], base)
}
