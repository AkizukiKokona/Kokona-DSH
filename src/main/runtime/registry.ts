import { DSH_PACKAGE, NPM_REGISTRY } from '../../shared/constants'
import type { Channel, ChannelInfo } from '../../shared/types'

const encoded = encodeURIComponent(DSH_PACKAGE).replace('%40', '@')

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'KokonaHarness' },
    signal: AbortSignal.timeout(8000)
  })
  if (!response.ok) throw new Error(`registry ${response.status} for ${url}`)
  return (await response.json()) as T
}

export async function fetchDistTags(): Promise<Record<string, string>> {
  return fetchJson<Record<string, string>>(`${NPM_REGISTRY}/-/package/${encoded}/dist-tags`)
}

export async function fetchChannels(): Promise<ChannelInfo> {
  const tags = await fetchDistTags()
  return {
    stable: tags.latest ?? null,
    beta: tags.next ?? tags.beta ?? tags.dev ?? tags.latest ?? null
  }
}

export function resolveChannelVersion(channels: ChannelInfo, channel: Channel): string | null {
  return channel === 'beta' ? channels.beta : channels.stable
}
