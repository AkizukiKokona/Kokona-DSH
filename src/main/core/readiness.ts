import { get } from 'node:http'
import { SERVER_POLL_INTERVAL_MS, SERVER_READY_TIMEOUT_MS } from '../../shared/constants'

export function probeOnce(url: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const request = get(url, (response) => {
      response.resume()
      resolve(true)
    })
    request.on('error', () => resolve(false))
    request.setTimeout(timeoutMs, () => {
      request.destroy()
      resolve(false)
    })
  })
}

export interface WaitOptions {
  timeoutMs?: number
  intervalMs?: number
  isAborted?: () => boolean
  getOverride?: () => string | null
}

export async function waitForServer(url: string, options: WaitOptions = {}): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? SERVER_READY_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? SERVER_POLL_INTERVAL_MS
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (options.isAborted?.()) return false
    const override = options.getOverride?.()
    const target = override ?? url
    if (await probeOnce(target)) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return false
}
