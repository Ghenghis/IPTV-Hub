import type { ChannelGroup, MediaItem } from '@/types'

type ProviderId = 'apollo' | 'xtremehd'
type ContentKind = 'live' | 'movie' | 'series'

type VaultItem = {
  id?: string | number
  stream_id?: string | number
  series_id?: string | number
  name?: string
  title?: string
  stream_display_name?: string
  url?: string
  logo?: string
  stream_icon?: string
  cover?: string
  container_extension?: string
  extension?: string
  group?: { title?: string }
  tvg?: { id?: string; name?: string; logo?: string }
  category?: string
  category_name?: string
  genre?: string
  year?: string | number
  rating?: string | number
  duration?: string | number
}

type VaultCatalog = {
  live?: VaultItem[]
  movies?: VaultItem[]
  series?: VaultItem[]
}

type Provider = {
  id: ProviderId
  name: string
}

const PROVIDERS: Provider[] = [
  { id: 'apollo', name: 'Apollo Group TV' },
  { id: 'xtremehd', name: 'XtremeHD' },
]

const LIMITS = {
  liveLimit: 1200,
  movieLimit: 700,
  seriesLimit: 700,
}

const catalogCache = new Map<ProviderId, Promise<VaultCatalog>>()
let configuredProvidersCache: Promise<Provider[]> | null = null

function text(value: unknown, fallback = ''): string {
  const out = String(value ?? '').trim()
  return out || fallback
}

function sameOriginPath(path: string): string {
  if (typeof window === 'undefined') return path
  return new URL(path, window.location.origin).toString()
}

function artworkUrl(value: unknown): string {
  const raw = text(value)
  if (!raw) return ''
  if (raw.startsWith('/api/provider-vault/image?')) return sameOriginPath(raw)
  if (raw.startsWith('/api/provider-vault/')) {
    return sameOriginPath(`/api/provider-vault/image?src=${encodeURIComponent(raw)}`)
  }
  if (/^https?:\/\//i.test(raw)) {
    return sameOriginPath(`/api/provider-vault/image?src=${encodeURIComponent(raw)}`)
  }
  if (raw.startsWith('/')) return sameOriginPath(raw)
  return raw
}

function safeId(value: unknown, fallback = 'item'): string {
  const out = text(value, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)
  return out || fallback
}

function catalogUrl(providerId: ProviderId): string {
  const params = new URLSearchParams({
    provider: providerId,
    profile: 'english',
    liveLimit: String(LIMITS.liveLimit),
    movieLimit: String(LIMITS.movieLimit),
    seriesLimit: String(LIMITS.seriesLimit),
  })
  return `/api/provider-vault/catalog?${params.toString()}`
}

function streamUrl(provider: ProviderId, kind: ContentKind, item: VaultItem): string {
  const id = text(item.id ?? item.stream_id ?? item.series_id, '')
  if (!id) return text(item.url, '')
  const ext = text(item.extension ?? item.container_extension, kind === 'live' ? 'm3u8' : 'mp4')
  const params = new URLSearchParams({ provider, kind, id, ext })
  return `/api/provider-vault/stream?${params.toString()}`
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json() as Promise<T>
}

async function configuredProviders(): Promise<Provider[]> {
  if (configuredProvidersCache) return configuredProvidersCache
  configuredProvidersCache = (async () => {
    try {
      if (window.localStorage.getItem('stalker_provider_vault_demo') === '1') return PROVIDERS
    } catch {
      // Ignore storage failures.
    }

    const data = await fetchJson<{ providers?: Array<{ id?: string; configured?: boolean }> }>(
      '/api/provider-vault/providers',
    )
    const configured = new Set(
      (Array.isArray(data.providers) ? data.providers : [])
        .filter((provider) => provider && provider.configured)
        .map((provider) => provider.id),
    )
    return PROVIDERS.filter((provider) => configured.has(provider.id))
  })()
  return configuredProvidersCache
}

async function catalogFor(provider: Provider): Promise<VaultCatalog> {
  const cached = catalogCache.get(provider.id)
  if (cached) return cached
  const promise = fetchJson<VaultCatalog>(catalogUrl(provider.id))
  catalogCache.set(provider.id, promise)
  return promise
}

function groupTitle(provider: Provider, kind: ContentKind, item: VaultItem): string {
  const fallback = kind === 'live' ? 'Live TV' : kind === 'movie' ? 'Movies' : 'Series'
  return `${provider.name} / ${text(
    item.group?.title ?? item.category_name ?? item.category ?? item.genre,
    fallback,
  )}`
}

function isMarkerTitle(value: unknown): boolean {
  return /^#{2,}.*#{2,}$/.test(text(value))
}

function normalizeItem(provider: Provider, item: VaultItem, kind: ContentKind, index: number): MediaItem {
  const title = text(
    item.name ?? item.title ?? item.stream_display_name ?? item.tvg?.name,
    `${provider.name} ${kind} ${index + 1}`,
  )
  const url = text(item.url, '') || streamUrl(provider.id, kind, item)
  const id = `${provider.id}-${kind}-${safeId(item.id ?? item.stream_id ?? item.series_id ?? index)}`
  const category = groupTitle(provider, kind, item)
  const art = artworkUrl(item.logo ?? item.stream_icon ?? item.cover ?? item.tvg?.logo)
  const base: MediaItem = {
    id,
    title,
    name: title,
    screenshot_uri: art,
    stream_icon: art,
    cmd: url,
    tv_genre_id: safeId(category),
    duration: Number(item.duration) || undefined,
  }

  if (kind === 'movie') {
    return { ...base, is_playable_movie: true, has_files: 1, stream_id: id }
  }
  if (kind === 'series') {
    return { ...base, is_series: 1, series_id: id, stream_id: id }
  }
  return { ...base, number: index + 1, stream_id: id }
}

async function catalogsByProvider(): Promise<Array<{ provider: Provider; catalog: VaultCatalog }>> {
  const providers = await configuredProviders()
  if (!providers.length) throw new Error('No configured DaveAI provider-vault providers')
  const catalogs = await Promise.all(
    providers.map(async (provider) => ({ provider, catalog: await catalogFor(provider) })),
  )
  return catalogs
}

function filterSearch(items: MediaItem[], search?: string): MediaItem[] {
  const needle = text(search).toLowerCase()
  if (!needle) return items
  return items.filter((item) => text(item.title ?? item.name).toLowerCase().includes(needle))
}

function interleaveItems<T>(lists: T[][]): T[] {
  const maxLength = lists.reduce((max, list) => Math.max(max, list.length), 0)
  const out: T[] = []
  for (let index = 0; index < maxLength; index += 1) {
    for (const list of lists) {
      if (list[index]) out.push(list[index])
    }
  }
  return out
}

export function isProviderVaultUrl(url: string | null | undefined): boolean {
  return text(url).startsWith('/api/provider-vault/')
}

export function passthroughStreamUrl(url: string): { raw: string; proxied: string } {
  return { raw: url, proxied: url }
}

export async function getVaultMovies(params: Record<string, unknown>): Promise<{
  data: MediaItem[]
  page: number
  total_items: number
  isPortal?: boolean
}> {
  const catalogs = await catalogsByProvider()
  if (params.movieId) {
    const movieId = String(params.movieId)
    const allMovies = interleaveItems(
      catalogs.map(({ provider, catalog }) =>
        (catalog.movies || []).map((item, index) => normalizeItem(provider, item, 'movie', index)),
      ),
    )
    const match = allMovies.find((item) => item.id === movieId) || allMovies[0]
    return { data: match ? [match] : [], page: 1, total_items: match ? 1 : 0, isPortal: false }
  }

  if (!params.category || params.category === '*') {
    const categories = catalogs.map(({ provider }) => ({
      id: `${provider.id}:movie`,
      title: `${provider.name} Movies`,
      name: `${provider.name} Movies`,
      screenshot_uri: '',
    }))
    return { data: filterSearch(categories, String(params.search || '')), page: 1, total_items: categories.length, isPortal: false }
  }

  const providerId = String(params.category).split(':')[0] as ProviderId
  const selected = catalogs.filter(({ provider }) => provider.id === providerId)
  const movies = selected.flatMap(({ provider, catalog }) =>
    (catalog.movies || [])
      .filter((item) => !isMarkerTitle(item.name ?? item.title ?? item.stream_display_name ?? item.tvg?.name))
      .map((item, index) => normalizeItem(provider, item, 'movie', index)),
  )
  const data = filterSearch(movies, String(params.search || ''))
  return { data, page: 1, total_items: data.length, isPortal: false }
}

export async function getVaultSeries(params: Record<string, unknown>): Promise<{
  data: MediaItem[]
  page: number
  total_items: number
}> {
  const catalogs = await catalogsByProvider()
  const allSeries = interleaveItems(
    catalogs.map(({ provider, catalog }) =>
      (catalog.series || [])
        .filter((item) => !isMarkerTitle(item.name ?? item.title ?? item.stream_display_name ?? item.tvg?.name))
        .map((item, index) => normalizeItem(provider, item, 'series', index)),
    ),
  )

  if (params.movieId || params.seasonId) {
    const id = String(params.movieId || params.seasonId)
    const item = allSeries.find((series) => series.id === id) || allSeries[0]
    const episode = item
      ? [{ ...item, id: `${item.id}-episode-1`, is_series: 0, is_episode: 1, series_number: 1 }]
      : []
    return { data: episode, page: 1, total_items: episode.length }
  }

  const data = filterSearch(allSeries, String(params.search || ''))
  return { data, page: 1, total_items: data.length }
}

export async function getVaultChannels(): Promise<{ data: MediaItem[]; page: number; total_items: number }> {
  const catalogs = await catalogsByProvider()
  const channels = interleaveItems(
    catalogs.map(({ provider, catalog }) =>
      (catalog.live || [])
        .filter((item) => !isMarkerTitle(item.name ?? item.title ?? item.stream_display_name ?? item.tvg?.name))
        .map((item, index) => normalizeItem(provider, item, 'live', index)),
    ),
  )
  return { data: channels, page: 1, total_items: channels.length }
}

export async function getVaultGroups(): Promise<{ data: ChannelGroup[]; page: number; total_items: number }> {
  const catalogs = await catalogsByProvider()
  const groups = new Map<string, ChannelGroup>()
  for (const { provider, catalog } of catalogs) {
    for (const item of catalog.live || []) {
      if (isMarkerTitle(item.name ?? item.title ?? item.stream_display_name ?? item.tvg?.name)) continue
      const title = groupTitle(provider, 'live', item)
      groups.set(safeId(title), { id: safeId(title), title })
    }
  }
  const data = Array.from(groups.values())
  return { data, page: 1, total_items: data.length }
}
