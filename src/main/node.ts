import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { loadConfig } from './config'

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

export function resolveNodeExecutable(): string | null {
  const configured = loadConfig().nodePath
  if (configured && existsSync(configured)) return configured
  const onPath = fromPath(process.platform === 'win32' ? 'node.exe' : 'node')
  if (onPath) return onPath
  if (process.platform === 'win32') {
    for (const candidate of WINDOWS_CANDIDATES) {
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

export function resolvePnpmExecutable(): string | null {
  return fromPath(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
}
