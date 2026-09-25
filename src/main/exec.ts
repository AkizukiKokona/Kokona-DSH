import { spawn, type SpawnOptions } from 'node:child_process'

export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
}

export type LineHandler = (chunk: string, stream: 'out' | 'err') => void

export function exec(
  command: string,
  args: string[],
  options: SpawnOptions & { onLine?: LineHandler } = {}
): Promise<ExecResult> {
  const { onLine, ...spawnOptions } = options
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, spawnOptions)
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (data) => {
      const text = String(data)
      stdout += text
      onLine?.(text, 'out')
    })
    child.stderr?.on('data', (data) => {
      const text = String(data)
      stderr += text
      onLine?.(text, 'err')
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}
