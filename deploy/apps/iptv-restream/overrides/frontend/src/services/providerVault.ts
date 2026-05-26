import { Channel } from '../types';

type ProviderId = 'apollo' | 'xtremehd';

type Provider = {
  id: ProviderId;
  name: string;
  configured?: boolean;
};

type VaultItem = {
  id?: string | number;
  stream_id?: string | number;
  name?: string;
  title?: string;
  stream_display_name?: string;
  logo?: string;
  stream_icon?: string;
  tvg?: { name?: string; logo?: string };
  group?: { title?: string };
  category?: string;
  category_name?: string;
  genre?: string;
  extension?: string;
  container_extension?: string;
};

type VaultCatalog = {
  live?: VaultItem[];
};

const PROVIDERS: Provider[] = [
  { id: 'apollo', name: 'Apollo Group TV' },
  { id: 'xtremehd', name: 'XtremeHD' },
];

const LIVE_LIMIT = 1200;

function text(value: unknown, fallback = ''): string {
  const out = String(value ?? '').trim();
  return out || fallback;
}

function safeId(value: unknown, fallback = 'item'): string {
  const out = text(value, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return out || fallback;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

async function configuredProviders(): Promise<Provider[]> {
  const data = await fetchJson<{ providers?: Array<{ id?: string; configured?: boolean }> }>(
    '/api/provider-vault/providers',
  );
  const configured = new Set(
    (Array.isArray(data.providers) ? data.providers : [])
      .filter((provider) => provider && provider.configured)
      .map((provider) => provider.id),
  );
  return PROVIDERS.filter((provider) => configured.has(provider.id));
}

function catalogUrl(provider: Provider): string {
  const params = new URLSearchParams({
    provider: provider.id,
    liveLimit: String(LIVE_LIMIT),
    movieLimit: '0',
    seriesLimit: '0',
  });
  return `/api/provider-vault/catalog?${params.toString()}`;
}

function streamUrl(provider: Provider, item: VaultItem): string {
  const id = text(item.id ?? item.stream_id, '');
  const ext = text(item.extension ?? item.container_extension, 'm3u8');
  const params = new URLSearchParams({ provider: provider.id, kind: 'live', id, ext });
  return `/api/provider-vault/stream?${params.toString()}`;
}

function toChannel(provider: Provider, item: VaultItem, index: number): Channel {
  const title = text(
    item.name ?? item.title ?? item.stream_display_name ?? item.tvg?.name,
    `${provider.name} Channel ${index + 1}`,
  );
  const group = `${provider.name} / ${text(
    item.group?.title ?? item.category_name ?? item.category ?? item.genre,
    'Live TV',
  )}`;
  return {
    id: 100000 + (provider.id === 'apollo' ? 0 : 50000) + index,
    name: title,
    url: streamUrl(provider, item),
    avatar: text(item.logo ?? item.stream_icon ?? item.tvg?.logo, ''),
    mode: 'direct',
    headers: [],
    group,
    playlist: catalogUrl(provider),
    playlistName: `${provider.name} - DaveAI Vault`,
    playlistUpdate: false,
    source: 'daveai-provider-vault',
    providerId: provider.id,
  };
}

export function isProviderVaultChannel(channel: Channel | null | undefined): boolean {
  return Boolean(
    channel?.source === 'daveai-provider-vault' ||
      channel?.url?.startsWith('/api/provider-vault/stream'),
  );
}

export async function getProviderVaultChannels(): Promise<Channel[]> {
  const providers = await configuredProviders();
  if (!providers.length) return [];

  const catalogs = await Promise.all(
    providers.map(async (provider) => ({
      provider,
      catalog: await fetchJson<VaultCatalog>(catalogUrl(provider)),
    })),
  );

  return catalogs.flatMap(({ provider, catalog }) =>
    (catalog.live || []).map((item, index) => toChannel(provider, item, index)),
  );
}
