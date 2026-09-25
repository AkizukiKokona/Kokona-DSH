import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { logsDir } from './paths'

let stream: WriteStream | null = null

function ensureStream(): WriteStream | null {
  if (stream) return stream
  try {
    mkdirSync(logsDir(), { recursive: true })
    const name = `kokona-${new Date().toISOString().slice(0, 10)}.log`
    stream = createWriteStream(join(logsDir(), name), { flags: 'a' })
  } catch {
    stream = null
  }
  return stream
}

function line(level: string, scope: string, message: string): string {
  return `${new Date().toISOString()} [${level}] [${scope}] ${message}`
}

export function createLogger(scope: string) {
  const write = (level: string, message: string) => {
    const text = line(level, scope, message)
    if (level === 'ERROR') console.error(text)
    else console.log(text)
    ensureStream()?.write(`${text}\n`)
  }
  return {
    info: (message: string) => write('INFO', message),
    warn: (message: string) => write('WARN', message),
    error: (message: string) => write('ERROR', message)
  }
}
