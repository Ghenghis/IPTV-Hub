import type { StreamSource } from '@/types/stream'
import type { StorableMediaItem } from '@/types/indexeddb'
import { getDB } from '@/services/indexedDb/indexedDbService'
import { MediaItemsStorageV2 } from '@/services/indexedDb/mediaItemsStorageV2'

const BUILD_ID = '20260529-wizju-provider-vault-v2'
const SEED_MARKER = 'wizju_daveai_provider_vault_seeded'
const VAULT_PROFILE = 'english'

const LIMITS = {
  liveLimit: 1200,
  movieLimit: 700,
  seriesLimit: 700,
}

type ProviderId = 'apollo' | 'xtremehd'

type ProviderConfig = {
  id: ProviderId
  name: string
  sourceId: string
}

type VaultCatalogItem = {
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
  duration?: string
}

type VaultCatalog = {
  live?: VaultCatalogItem[]
  movies?: VaultCatalogItem[]
  series?: VaultCatalogItem[]
}

const PROVIDERS: ProviderConfig[] = [
  { id: 'apollo', name: 'Apollo Group TV', sourceId: 'daveai-vault-apollo' },
  { id: 'xtremehd', name: 'XtremeHD', sourceId: 'daveai-vault-xtremehd' },
]

const mediaItemsStorage = new MediaItemsStorageV2()
let ensureInFlight: Promise<number> | null = null

function text(value: unknown, fallback = ''): string {
  const out = String(value ?? '').trim()
  return out || fallback
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
    profile: VAULT_PROFILE,
    liveLimit: String(LIMITS.liveLimit),
    movieLimit: String(LIMITS.movieLimit),
    seriesLimit: String(LIMITS.seriesLimit),
  })
  return `/api/provider-vault/catalog?${params.toString()}`
}

function providersUrl(): string {
  return '/api/provider-vault/providers'
}

function streamUrl(providerId: ProviderId, kind: 'live' | 'movie' | 'series', item: VaultCatalogItem): string {
  const id = text(item.id ?? item.stream_id ?? item.series_id, '')
  if (!id) return text(item.url, '')

  const ext = text(
    item.extension ?? item.container_extension,
    kind === 'live' ? 'm3u8' : 'mp4',
  )
  const params = new URLSearchParams({
    provider: providerId,
    kind,
    id,
    ext,
  })
  return `/api/provider-vault/stream?${params.toString()}`
}

function normalizeVaultUrl(url: string): string {
  if (!url.includes('/api/provider-vault/aac-hls?')) return url
  try {
    const parsed = new URL(url, window.location.origin)
    const sourceExt = parsed.searchParams.get('sourceExt') || parsed.searchParams.get('ext') || 'ts'
    parsed.searchParams.set('ext', 'm3u8')
    parsed.searchParams.set('sourceExt', sourceExt)
    parsed.searchParams.set('video', 'h264')
    parsed.searchParams.set('segment', 'ts')
    return `${parsed.pathname}${parsed.search}`
  } catch {
    const joiner = url.includes('?') ? '&' : '?'
    return `${url}${joiner}ext=m3u8&sourceExt=ts&video=h264&segment=ts`
  }
}

function isMarkerName(value: string): boolean {
  return /^#{2,}/.test(value.trim())
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  return response.json() as Promise<T>
}

async function configuredProviders(): Promise<ProviderConfig[]> {
  try {
    if (window.localStorage.getItem('wizju_provider_vault_demo') === '1') {
      return PROVIDERS
    }
  } catch {
    // Ignore storage failures and use the secure provider endpoint below.
  }

  try {
    const data = await fetchJson<{ providers?: Array<{ id?: string; configured?: boolean }> }>(
      providersUrl(),
    )
    const configured = new Set(
      (Array.isArray(data.providers) ? data.providers : [])
        .filter((provider) => provider && provider.configured)
        .map((provider) => provider.id),
    )
    return PROVIDERS.filter((provider) => configured.has(provider.id))
  } catch (error) {
    console.warn('[DaveAI Provider Vault] Provider list unavailable:', error)
    return []
  }
}

function categoryFor(type: 'live' | 'movie' | 'series', item: VaultCatalogItem, provider: ProviderConfig): string {
  const fallback = type === 'live' ? 'Live TV' : type === 'movie' ? 'Movies' : 'Series'
  return `${provider.name} / ${text(
    item.group?.title ?? item.category_name ?? item.category ?? item.genre,
    fallback,
  )}`
}

function normalizeItem(
  provider: ProviderConfig,
  item: VaultCatalogItem,
  kind: 'live' | 'movie' | 'series',
  index: number,
): Omit<StorableMediaItem, 'sourceId' | 'dateAdded'> | null {
  const type = kind === 'movie' ? 'vod' : kind
  const title = text(
    item.name ?? item.title ?? item.stream_display_name ?? item.tvg?.name,
    `${provider.name} ${kind} ${index + 1}`,
  )
  if (isMarkerName(title)) return null
  const url = normalizeVaultUrl(text(item.url, '') || streamUrl(provider.id, kind, item))
  if (!url || !url.startsWith('/api/provider-vault/')) return null

  const category = categoryFor(kind, item, provider)
  const logo = text(item.logo ?? item.stream_icon ?? item.cover ?? item.tvg?.logo, '')
  const idSeed = [
    provider.sourceId,
    kind,
    item.id ?? item.stream_id ?? item.series_id ?? index,
    safeId(title),
  ].join('-')

  return {
    id: safeId(idSeed),
    title,
    description: category,
    thumbnail: logo,
    category,
    category_num: 0,
    url,
    type,
    genre: text(item.genre ?? item.group?.title ?? item.category_name, category),
    year: item.year ? Number(item.year) || undefined : undefined,
    rating: item.rating ? Number(item.rating) || undefined : undefined,
    duration: text(item.duration, ''),
    timeRemaining: '',
    tvgName: text(item.tvg?.name, title),
    groupTitle: category,
  }
}

function catalogToMediaItems(
  provider: ProviderConfig,
  catalog: VaultCatalog,
): Omit<StorableMediaItem, 'sourceId' | 'dateAdded'>[] {
  const live = Array.isArray(catalog.live) ? catalog.live : []
  const movies = Array.isArray(catalog.movies) ? catalog.movies : []
  const series = Array.isArray(catalog.series) ? catalog.series : []

  return [
    ...live.map((item, index) => normalizeItem(provider, item, 'live', index)),
    ...movies.map((item, index) => normalizeItem(provider, item, 'movie', index)),
    ...series.map((item, index) => normalizeItem(provider, item, 'series', index)),
  ].filter((item): item is Omit<StorableMediaItem, 'sourceId' | 'dateAdded'> => Boolean(item))
}

function categoryMapFor(items: Array<{ category: string }>): Map<string, number> {
  const map = new Map<string, number>()
  items.forEach((item) => {
    if (!map.has(item.category)) {
      map.set(item.category, map.size)
    }
  })
  return map
}

async function upsertSource(provider: ProviderConfig, categories: string[]): Promise<void> {
  const db = await getDB()
  const now = new Date().toISOString()
  const existing = await db.get('streamSources', provider.sourceId)
  const source: StreamSource = {
    id: provider.sourceId,
    name: provider.name,
    url: catalogUrl(provider.id),
    type: 'm3u',
    password: '',
    dateAdded: existing?.dateAdded || now,
    isActive: true,
    categories,
  }
  await db.put('streamSources', source)
}

async function importProvider(provider: ProviderConfig, force = false): Promise<number> {
  const markerKey = `${SEED_MARKER}_${provider.id}`
  const db = await getDB()
  const existingSource = await db.get('streamSources', provider.sourceId)
  const existingCount = existingSource
    ? await mediaItemsStorage.countItemsBySourceId(provider.sourceId)
    : 0
  const currentMarker = (() => {
    try {
      return window.localStorage.getItem(markerKey)
    } catch {
      return null
    }
  })()

  if (!force && existingSource && existingCount > 0 && currentMarker === BUILD_ID) {
    return 0
  }

  const catalog = await fetchJson<VaultCatalog>(catalogUrl(provider.id))
  const mediaItems = catalogToMediaItems(provider, catalog)
  if (!mediaItems.length) {
    throw new Error(`${provider.name} returned no playable rows`)
  }

  const categoryMap = categoryMapFor(mediaItems)
  await upsertSource(provider, Array.from(categoryMap.keys()).sort())
  await mediaItemsStorage.replaceItemsForSource(
    provider.sourceId,
    mediaItems.map((item) => ({ ...item, sourceId: provider.sourceId })),
    categoryMap,
  )

  try {
    window.localStorage.setItem(markerKey, BUILD_ID)
  } catch {
    // Non-fatal. The DB rows are the source of truth.
  }

  return mediaItems.length
}

export async function ensureDaveAiProviderVaultSources(force = false): Promise<number> {
  if (!force && ensureInFlight) return ensureInFlight

  ensureInFlight = runDaveAiProviderVaultImport(force).finally(() => {
    ensureInFlight = null
  })

  return ensureInFlight
}

async function runDaveAiProviderVaultImport(force = false): Promise<number> {
  const providers = await configuredProviders()
  let imported = 0

  for (const provider of providers) {
    try {
      imported += await importProvider(provider, force)
    } catch (error) {
      console.warn(`[DaveAI Provider Vault] Could not import ${provider.name}:`, error)
    }
  }

  window.dispatchEvent(
    new CustomEvent('daveai-provider-vault-ready', {
      detail: { imported, providers: providers.map((provider) => provider.id), buildId: BUILD_ID },
    }),
  )

  return imported
}

export async function parseProviderVaultCatalogUrl(
  url: string,
): Promise<Omit<StorableMediaItem, 'sourceId' | 'id' | 'dateAdded'>[] | null> {
  let parsed: URL
  try {
    parsed = new URL(url, window.location.origin)
  } catch {
    return null
  }

  if (parsed.pathname !== '/api/provider-vault/catalog') return null

  const providerId = parsed.searchParams.get('provider') as ProviderId | null
  const provider = PROVIDERS.find((item) => item.id === providerId)
  if (!provider) return null

  const catalog = await fetchJson<VaultCatalog>(`${parsed.pathname}${parsed.search}`)
  return catalogToMediaItems(provider, catalog).map(({ id: _id, ...item }) => item)
}

export const daveAiProviderVaultBuildId = BUILD_ID
