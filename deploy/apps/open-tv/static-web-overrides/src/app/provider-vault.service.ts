import { Injectable } from "@angular/core";
import { Subject } from "rxjs";
import { Channel } from "./models/channel";
import { MediaType } from "./models/mediaType";
import { Filters } from "./models/filters";
import { ViewMode } from "./models/viewMode";

type ProviderId = "apollo" | "xtremehd";
type VaultKind = "live" | "movie";

type Provider = {
  id: ProviderId;
  name: string;
  sourceId: number;
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
  url?: string;
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

export type ProviderPlayback = {
  title: string;
  url: string;
  kind: VaultKind;
  providerName: string;
};

const PROVIDERS: Provider[] = [
  { id: "apollo", name: "Apollo Group TV", sourceId: 9001 },
  { id: "xtremehd", name: "XtremeHD", sourceId: 9002 },
];

const LIVE_LIMIT = 1200;
const MOVIE_LIMIT = 500;
const VAULT_PROFILE = "english";

@Injectable({ providedIn: "root" })
export class ProviderVaultService {
  public playback = new Subject<ProviderPlayback>();

  isBrowserProviderVaultMode(): boolean {
    return typeof window !== "undefined" && !(window as any).__TAURI_INTERNALS__;
  }

  isProviderVaultChannel(channel?: Channel): boolean {
    return Boolean(
      channel?.provider_vault || channel?.url?.startsWith("/api/provider-vault/"),
    );
  }

  play(channel: Channel) {
    if (!this.isProviderVaultChannel(channel) || !channel.url) return;
    this.playback.next({
      title: channel.name || "Provider-vault stream",
      url: channel.url,
      kind: channel.provider_kind === "movie" ? "movie" : "live",
      providerName: PROVIDERS.find((provider) => provider.id === channel.provider_id)?.name || "DaveTV",
    });
  }

  async loadChannels(): Promise<Channel[]> {
    const providers = await this.configuredProviders();
    const catalogs = await Promise.all(
      providers.map(async (provider) => ({
        provider,
        catalog: await this.fetchJson<VaultCatalog>(this.catalogUrl(provider)),
      })),
    );

    const providerChannels = catalogs.map(({ provider, catalog }) => {
      const live = (catalog.live || [])
        .filter((item) => this.isUsableProviderRow(provider, item, "live"))
        .map((item, index) => this.toChannel(provider, item, index, "live"));
      const movies = (catalog.movies || catalog.movie || [])
        .filter((item) => this.isUsableProviderRow(provider, item, "movie"))
        .map((item, index) => this.toChannel(provider, item, index, "movie"));
      return live.concat(movies);
    });
    return this.interleave(providerChannels);
  }

  filterChannels(channels: Channel[], filters: Filters, pageSize: number): Channel[] {
    let result = channels.filter((channel) => {
      if (filters.source_ids?.length && !filters.source_ids.includes(channel.source_id!)) {
        return false;
      }
      if (filters.media_types?.length && !filters.media_types.includes(channel.media_type!)) {
        return false;
      }
      if (filters.group_id && channel.group_id !== filters.group_id) {
        return false;
      }
      if (filters.query?.trim()) {
        const query = filters.query.trim().toLowerCase();
        return `${channel.name || ""} ${channel.provider_group || ""}`.toLowerCase().includes(query);
      }
      return true;
    });

    if (filters.view_type === ViewMode.Categories && !filters.group_id) {
      result = this.toGroups(result);
    } else if (
      filters.view_type === ViewMode.Favorites ||
      filters.view_type === ViewMode.History ||
      filters.view_type === ViewMode.Hidden
    ) {
      result = [];
    }

    const page = Math.max(filters.page || 1, 1);
    return result.slice(0, page * pageSize);
  }

  providerSources() {
    return PROVIDERS;
  }

  private interleave(lists: Channel[][]): Channel[] {
    const result: Channel[] = [];
    const max = Math.max(0, ...lists.map((list) => list.length));
    for (let index = 0; index < max; index += 1) {
      for (const list of lists) {
        const item = list[index];
        if (item) result.push(item);
      }
    }
    return result;
  }

  private async configuredProviders(): Promise<Provider[]> {
    const data = await this.fetchJson<{ providers?: Array<{ id?: string; configured?: boolean }> }>(
      "/api/provider-vault/providers",
    );
    const configured = new Set(
      (Array.isArray(data.providers) ? data.providers : [])
        .filter((provider) => provider?.configured)
        .map((provider) => provider.id),
    );
    return PROVIDERS.filter((provider) => configured.has(provider.id));
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json() as Promise<T>;
  }

  private catalogUrl(provider: Provider): string {
    const params = new URLSearchParams({
      provider: provider.id,
      profile: VAULT_PROFILE,
      liveLimit: String(LIVE_LIMIT),
      movieLimit: String(MOVIE_LIMIT),
      seriesLimit: "0",
    });
    return `/api/provider-vault/catalog?${params.toString()}`;
  }

  private streamUrl(provider: Provider, item: VaultItem, kind: VaultKind): string {
    const vaultUrl = this.normalizeVaultUrl(this.text(item.url, ""));
    if (vaultUrl.startsWith("/api/provider-vault/")) {
      return vaultUrl;
    }

    const id = this.text(item.id ?? item.stream_id, "");
    const ext = this.text(item.extension ?? item.container_extension, kind === "movie" ? "mp4" : "m3u8");
    const params = new URLSearchParams({ provider: provider.id, kind, id, ext });
    return `/api/provider-vault/stream?${params.toString()}`;
  }

  private normalizeVaultUrl(url: string): string {
    if (!url.includes("/api/provider-vault/aac-hls?")) return url;
    try {
      const parsed = new URL(url, window.location.origin);
      const sourceExt = parsed.searchParams.get("sourceExt") || parsed.searchParams.get("ext") || "ts";
      parsed.searchParams.set("ext", "m3u8");
      parsed.searchParams.set("sourceExt", sourceExt);
      parsed.searchParams.set("video", "h264");
      parsed.searchParams.set("segment", "ts");
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      const joiner = url.includes("?") ? "&" : "?";
      return `${url}${joiner}ext=m3u8&sourceExt=ts&video=h264&segment=ts`;
    }
  }

  private isUsableProviderRow(provider: Provider, item: VaultItem, kind: VaultKind): boolean {
    const title = this.text(item.name ?? item.title ?? item.stream_display_name ?? item.tvg?.name, "");
    if (!title || /^#{2,}/.test(title)) return false;
    if (kind === "live" && provider.id === "apollo") {
      const upper = title.toUpperCase();
      return upper.includes("|US|") || upper.startsWith("USA ");
    }
    return true;
  }

  private toChannel(provider: Provider, item: VaultItem, index: number, kind: VaultKind): Channel {
    const offset = provider.id === "apollo" ? 0 : 100000;
    const kindOffset = kind === "live" ? 0 : 50000;
    const title = this.text(
      item.name ?? item.title ?? item.stream_display_name ?? item.tvg?.name,
      `${provider.name} ${kind === "movie" ? "Movie" : "Channel"} ${index + 1}`,
    );
    const group = `${provider.name} / ${this.text(
      item.group?.title ?? item.category_name ?? item.category ?? item.genre,
      kind === "movie" ? "Movies" : "Live TV",
    )}`;
    return {
      id: 1000000 + offset + kindOffset + index,
      name: title,
      group_id: this.groupId(group),
      image: this.text(item.logo ?? item.stream_icon ?? item.cover ?? item.tvg?.logo, ""),
      url: this.streamUrl(provider, item, kind),
      media_type: kind === "movie" ? MediaType.movie : MediaType.livestream,
      source_id: provider.sourceId,
      favorite: false,
      tv_archive: false,
      hidden: false,
      provider_vault: true,
      provider_id: provider.id,
      provider_kind: kind,
      provider_group: group,
    };
  }

  private toGroups(channels: Channel[]): Channel[] {
    const seen = new Map<number, Channel>();
    for (const channel of channels) {
      const id = channel.group_id!;
      if (seen.has(id)) continue;
      seen.set(id, {
        id,
        name: channel.provider_group || "Provider group",
        group_id: id,
        image: channel.image,
        media_type: MediaType.group,
        source_id: channel.source_id,
        favorite: false,
        hidden: false,
        provider_vault: true,
        provider_id: channel.provider_id,
        provider_group: channel.provider_group,
      });
    }
    return Array.from(seen.values()).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }

  private groupId(group: string): number {
    let hash = 0;
    for (const char of group) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return 2000000 + (hash % 700000);
  }

  private text(value: unknown, fallback = ""): string {
    const out = String(value ?? "").trim();
    return out || fallback;
  }
}
