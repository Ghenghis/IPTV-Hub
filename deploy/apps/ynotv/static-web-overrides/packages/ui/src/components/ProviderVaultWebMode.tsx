import { useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import './ProviderVaultWebMode.css';

type ProviderId = 'apollo' | 'xtremehd';
type StreamKind = 'live' | 'movie';

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
  cover?: string;
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
  movies?: VaultItem[];
  movie?: VaultItem[];
};

type Channel = {
  id: string;
  name: string;
  providerId: ProviderId;
  providerName: string;
  category: string;
  kind: StreamKind;
  logo: string;
  url: string;
};

const PROVIDERS: Provider[] = [
  { id: 'apollo', name: 'Apollo Group TV' },
  { id: 'xtremehd', name: 'XtremeHD' },
];

function text(value: unknown, fallback = '') {
  const out = String(value ?? '').trim();
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

function streamUrl(provider: Provider, item: VaultItem, kind: StreamKind) {
  const id = text(item.id ?? item.stream_id);
  const ext = text(item.extension ?? item.container_extension, kind === 'movie' ? 'mp4' : 'm3u8');
  const params = new URLSearchParams({ provider: provider.id, kind, id, ext });
  return `/api/provider-vault/stream?${params.toString()}`;
}

function toChannel(provider: Provider, item: VaultItem, index: number, kind: StreamKind): Channel {
  const name = text(
    item.name ?? item.title ?? item.stream_display_name ?? item.tvg?.name,
    `${provider.name} ${kind === 'movie' ? 'Movie' : 'Channel'} ${index + 1}`,
  );
  const category = text(
    item.group?.title ?? item.category_name ?? item.category ?? item.genre,
    kind === 'movie' ? 'Movies' : 'Live TV',
  );
  return {
    id: `${provider.id}-${kind}-${text(item.id ?? item.stream_id, String(index))}`,
    name,
    providerId: provider.id,
    providerName: provider.name,
    category,
    kind,
    logo: text(item.logo ?? item.stream_icon ?? item.cover ?? item.tvg?.logo),
    url: streamUrl(provider, item, kind),
  };
}

export function ProviderVaultWebMode() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [active, setActive] = useState<Channel | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'all' | StreamKind>('all');
  const [category, setCategory] = useState('All');
  const [status, setStatus] = useState('Loading DaveTV provider vault...');
  const [error, setError] = useState('');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const providerPayload = await fetchJson<{ providers?: Provider[] }>('/api/provider-vault/providers');
        const configured = new Set(
          (providerPayload.providers || [])
            .filter((provider) => provider.configured)
            .map((provider) => provider.id),
        );
        const providers = PROVIDERS.filter((provider) => configured.has(provider.id));
        const catalogs = await Promise.all(
          providers.map(async (provider) => {
            const params = new URLSearchParams({
              provider: provider.id,
              liveLimit: '1400',
              movieLimit: '700',
              seriesLimit: '0',
            });
            return { provider, catalog: await fetchJson<VaultCatalog>(`/api/provider-vault/catalog?${params}`) };
          }),
        );
        const loaded = catalogs.flatMap(({ provider, catalog }) => [
          ...(catalog.live || []).map((item, index) => toChannel(provider, item, index, 'live')),
          ...(catalog.movies || catalog.movie || []).map((item, index) => toChannel(provider, item, index, 'movie')),
        ]);
        if (cancelled) return;
        setChannels(loaded);
        setActive(loaded[0] || null);
        setStatus(
          loaded.length
            ? `Loaded ${loaded.length.toLocaleString()} Apollo/XtremeHD streams from DaveTV vault`
            : 'No configured DaveTV providers found',
        );
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus('Provider-vault loading failed');
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !active) return;
    hlsRef.current?.destroy();
    hlsRef.current = null;
    video.pause();
    video.removeAttribute('src');
    video.load();

    if (active.url.includes('ext=m3u8') && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        maxBufferLength: 180,
        maxMaxBufferLength: 600,
        backBufferLength: 90,
        liveDurationInfinity: true,
        liveSyncDurationCount: 6,
        liveMaxLatencyDurationCount: 20,
      });
      hlsRef.current = hls;
      hls.loadSource(active.url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => undefined));
      return () => hls.destroy();
    }

    video.src = active.url;
    video.play().catch(() => undefined);
  }, [active]);

  const categories = useMemo(
    () => ['All', ...Array.from(new Set(channels.map((channel) => channel.category))).sort()],
    [channels],
  );

  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return channels.filter((channel) => {
      if (kind !== 'all' && channel.kind !== kind) return false;
      if (category !== 'All' && channel.category !== category) return false;
      if (!normalized) return true;
      return `${channel.name} ${channel.providerName} ${channel.category}`.toLowerCase().includes(normalized);
    });
  }, [category, channels, kind, query]);

  return (
    <main className="vault-shell">
      <section className="vault-hero">
        <div>
          <span className="vault-kicker">DaveTV Provider Vault</span>
          <h1>ynotv</h1>
          <p>{status}</p>
          {error && <p className="vault-error">{error}</p>}
        </div>
        <div className="vault-counts">
          <span>{channels.filter((channel) => channel.providerId === 'apollo').length} Apollo</span>
          <span>{channels.filter((channel) => channel.providerId === 'xtremehd').length} XtremeHD</span>
        </div>
      </section>

      <section className="vault-player-panel">
        <video ref={videoRef} controls playsInline />
        <div className="vault-now-playing">
          <span>{active?.providerName || 'DaveTV'}</span>
          <strong>{active?.name || 'Select a stream'}</strong>
          <em>Safe same-origin stream with larger HLS buffers enabled.</em>
        </div>
      </section>

      <section className="vault-controls">
        <input
          aria-label="Search streams"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search channels and movies..."
        />
        <div className="vault-segments" aria-label="Content type">
          <button className={kind === 'all' ? 'active' : ''} onClick={() => setKind('all')}>All</button>
          <button className={kind === 'live' ? 'active' : ''} onClick={() => setKind('live')}>Live</button>
          <button className={kind === 'movie' ? 'active' : ''} onClick={() => setKind('movie')}>Movies</button>
        </div>
      </section>

      <nav className="vault-categories" aria-label="Categories">
        {categories.slice(0, 28).map((item) => (
          <button key={item} className={category === item ? 'active' : ''} onClick={() => setCategory(item)}>
            {item}
          </button>
        ))}
      </nav>

      <section className="vault-grid" aria-label="Provider streams">
        {visible.slice(0, 240).map((channel) => (
          <button
            key={channel.id}
            className={`vault-card${active?.id === channel.id ? ' active' : ''}`}
            onClick={() => setActive(channel)}
          >
            <span>{channel.providerName}</span>
            <strong>{channel.name}</strong>
            <em>{channel.kind === 'movie' ? 'Movie' : channel.category}</em>
          </button>
        ))}
      </section>
    </main>
  );
}
