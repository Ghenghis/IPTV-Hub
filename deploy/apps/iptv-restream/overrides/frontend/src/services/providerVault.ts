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
  num?: string | number;
  epg_channel_id?: string | number;
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
  url?: string;
  extension?: string;
  container_extension?: string;
  raw?: {
    id?: string | number;
    stream_id?: string | number;
    num?: string | number;
  };
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

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const out = text(value, '');
    if (out) return out;
  }
  return '';
}

function streamIdFromUrl(value: unknown): string {
  const url = text(value, '');
  if (!url) return '';

  try {
    const parsed = new URL(url, 'https://daveai.local');
    if (!parsed.pathname.includes('/api/provider-vault/')) return '';
    return text(parsed.searchParams.get('id'), '');
  } catch {
    return '';
  }
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
    profile: 'english',
    liveLimit: String(LIVE_LIMIT),
    movieLimit: '0',
    seriesLimit: '0',
  });
  return `/api/provider-vault/catalog?${params.toString()}`;
}

function streamUrl(provider: Provider, id: string, item: VaultItem): string {
  const suppliedUrl = text(item.url, '');
  if (suppliedUrl.startsWith('/api/provider-vault/') && streamIdFromUrl(suppliedUrl)) {
    return suppliedUrl;
  }

  const ext = text(item.extension ?? item.container_extension, 'm3u8');
  const params = new URLSearchParams({ provider: provider.id, kind: 'live', id, ext });
  return `/api/provider-vault/stream?${params.toString()}`;
}

function toChannel(provider: Provider, item: VaultItem, index: number): Channel | null {
  const providerItemId = firstText(
    item.id,
    item.stream_id,
    item.num,
    item.epg_channel_id,
    item.raw?.id,
    item.raw?.stream_id,
    item.raw?.num,
    streamIdFromUrl(item.url),
  );
  if (!providerItemId) return null;

  const title = text(
    item.name ?? item.title ?? item.stream_display_name ?? item.tvg?.name,
    `${provider.name} Channel ${index + 1}`,
  );
  if (/^#{2,}.*#{2,}$/.test(title)) return null;
  const group = `${provider.name} / ${text(
    item.group?.title ?? item.category_name ?? item.category ?? item.genre,
    'Live TV',
  )}`;
  const avatar = firstText(item.logo, item.stream_icon, item.tvg?.logo);
  return {
    id: `${provider.id}-${safeId(providerItemId || title, String(index))}`,
    name: title,
    url: streamUrl(provider, providerItemId, item),
    avatar,
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
      channel?.url?.startsWith('/api/provider-vault/'),
  );
}

export async function getProviderVaultChannels(): Promise<Channel[]> {
  const providers = await configuredProviders();
  if (!providers.length) return [];

  const settled = await Promise.allSettled(
    providers.map(async (provider) => ({
      provider,
      catalog: await fetchJson<VaultCatalog>(catalogUrl(provider)),
    })),
  );

  return settled.flatMap((result) => {
    if (result.status !== 'fulfilled') return [];
    const { provider, catalog } = result.value;
    return (
      (catalog.live || [])
      .map((item, index) => toChannel(provider, item, index))
      .filter((channel): channel is Channel => Boolean(channel))
    );
  });
}
