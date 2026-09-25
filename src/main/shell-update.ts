import { app } from 'electron'
import type { ShellUpdateInfo } from '../shared/types'
import { loadConfig } from './config'
import { createLogger } from './logger'

const log = createLogger('update')
const REPO = 'AkizukiKokona/Kokona-DSH'
const GITHUB_API = `https://api.github.com/repos/${REPO}/releases/latest`
const CODEBERG_API = `https://codeberg.org/api/v1/repos/${REPO}/releases?limit=1`

function normalize(version: string): string {
  return version.trim().replace(/^v/i, '')
}

function compare(a: string, b: string): number {
  const parse = (value: string) =>
    normalize(value)
      .split(/[.\-+]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10))
  const left = parse(a)
  const right = parse(b)
  for (let index = 0; index < 3; index += 1) {
    const x = Number.isFinite(left[index]) ? left[index] : 0
    const y = Number.isFinite(right[index]) ? right[index] : 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'KokonaDSH' },
    signal: AbortSignal.timeout(8000)
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return (await response.json()) as T
}

interface Release {
  version: string
  url: string
  notes: string | null
}

async function fromGithub(): Promise<Release | null> {
  const data = await fetchJson<{ tag_name?: string; html_url?: string; body?: string }>(GITHUB_API)
  if (!data.tag_name) return null
  return {
    version: normalize(data.tag_name),
    url: data.html_url ?? `https://github.com/${REPO}/releases`,
    notes: data.body ?? null
  }
}

async function fromCodeberg(): Promise<Release | null> {
  const data = await fetchJson<Array<{ tag_name?: string; html_url?: string; body?: string }>>(CODEBERG_API)
  const release = Array.isArray(data) ? data[0] : null
  if (!release?.tag_name) return null
  return {
    version: normalize(release.tag_name),
    url: release.html_url ?? `https://codeberg.org/${REPO}/releases`,
    notes: release.body ?? null
  }
}

function preferCodeberg(): boolean {
  const config = loadConfig()
  if (config.updateSource === 'codeberg') return true
  if (config.updateSource === 'github') return false
  const locale = app.getLocale() ?? ''
  if (locale.toLowerCase().startsWith('zh')) return true
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
    if (/Shanghai|Chongqing|Urumqi|Beijing/i.test(timeZone)) return true
  } catch {
    // ignore timezone detection failures
  }
  return false
}

export async function checkShellUpdate(): Promise<ShellUpdateInfo> {
  const current = app.getVersion()
  const order: Array<'codeberg' | 'github'> = preferCodeberg()
    ? ['codeberg', 'github']
    : ['github', 'codeberg']
  let lastError: string | null = null
  for (const source of order) {
    try {
      const release = source === 'codeberg' ? await fromCodeberg() : await fromGithub()
      if (!release) {
        lastError = '没有已发布的发行版'
        continue
      }
      const hasUpdate = compare(release.version, current) > 0
      log.info(`shell update via ${source}: current=${current} latest=${release.version} hasUpdate=${hasUpdate}`)
      return {
        current,
        latest: release.version,
        hasUpdate,
        url: release.url,
        source,
        notes: release.notes,
        error: null
      }
    } catch (error) {
      lastError = `${source}: ${(error as Error).message}`
      log.warn(`shell update check failed via ${source}: ${(error as Error).message}`)
    }
  }
  return { current, latest: null, hasUpdate: false, url: null, source: null, notes: null, error: lastError }
}
