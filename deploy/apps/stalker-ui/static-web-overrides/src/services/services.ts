/* eslint-disable @typescript-eslint/no-explicit-any */
import type { EPG_List, MediaItem, ChannelGroup } from '@/types';
import { api, type ApiResponse } from '@/services/api';
import {
  getVaultChannels,
  getVaultGroups,
  getVaultMovies,
  getVaultSeries,
} from '@/services/providerVault';

export const API_PATHS = {
  MOVIES: '/v2/movies',
  SERIES: '/v2/series',
  MOVIE_LINK: '/v2/movie-link',
  CHANNELS: '/v2/channels',
  CHANNEL_LINK: '/v2/channel-link',
  EPG: '/v2/epg',
  CHANNEL_GROUPS: '/v2/groups',
  EXPIRY: '/v2/expiry',
};

export interface PaginatedResponse<T> {
  data: T[];
  page: number;
  total_items: number;
  isPortal?: boolean;
}

export const getMedia = async (
  params: Record<string, any>,
  signal?: AbortSignal
): Promise<PaginatedResponse<MediaItem>> => {
  let response: PaginatedResponse<MediaItem> | null = null;
  try {
    response = await getVaultMovies(params);
  } catch {
    response = (
      await api.get<PaginatedResponse<MediaItem>>(API_PATHS.MOVIES, {
        params,
        signal,
      })
    ).data;
  }

  return response;
};
export const getSeries = async (
  params: Record<string, any>,
  signal?: AbortSignal
): Promise<PaginatedResponse<MediaItem>> => {
  let response: PaginatedResponse<MediaItem> | null = null;
  try {
    response = await getVaultSeries(params);
  } catch {
    response = (
      await api.get<PaginatedResponse<MediaItem>>(API_PATHS.SERIES, {
        params,
        signal,
      })
    ).data;
  }

  return response;
};

export const getChannels = async (
  signal?: AbortSignal
): Promise<PaginatedResponse<MediaItem>> => {
  let response: MediaItem[] | null = null;
  try {
    return await getVaultChannels();
  } catch {
    response = (await api.get<MediaItem[]>(API_PATHS.CHANNELS, { signal }))
      .data;
  }

  return {
    data: response,
    page: 1,
    total_items: response.length,
  };
};

export const getChannelGroups = async (
  all: boolean = false,
  signal?: AbortSignal
): Promise<PaginatedResponse<ChannelGroup>> => {
  const params: Record<string, any> = {};
  if (all) {
    params.all = 'true';
  }

  let response: ChannelGroup[] | null = null;
  try {
    return await getVaultGroups();
  } catch {
    response = (
      await api.get<ChannelGroup[]>(API_PATHS.CHANNEL_GROUPS, { params, signal })
    ).data;
  }

  return {
    data: response,
    page: 1,
    total_items: response.length,
  };
};

export const getMovieUrl = async (params: Record<string, any> = {}) => {
  try {
    const fallback = await getVaultMovies({ movieId: params.id || params.movieId || params.episodeId });
    const item = fallback.data[0];
    if (item?.cmd) return { cmd: item.cmd, js: { cmd: item.cmd } };
  } catch {
    // Fall through to the legacy backend below.
  }

  try {
    return (await api.get(API_PATHS.MOVIE_LINK, { params })).data;
  } catch {
    const fallback = await getVaultSeries({ movieId: params.id || params.movieId || params.episodeId });
    const item = fallback.data[0];
    return { cmd: item?.cmd, js: { cmd: item?.cmd } };
  }
};
export const getChannelUrl = async (cmd: string) =>
  (await api.get(API_PATHS.CHANNEL_LINK, { params: { cmd } })).data;
export const getEPG = async (): Promise<
  ApiResponse<{
    timestamp: number;
    data: Record<string, EPG_List[]>;
  }>
> => {
  try {
    await getVaultChannels();
    return { data: { timestamp: Date.now(), data: {} } };
  } catch {
    return await api.get(API_PATHS.EPG);
  }
};

export const getExpiry = async (): Promise<{
  success: boolean;
  expiry: string | null;
}> =>
  (await api.get<{ success: boolean; expiry: string | null }>(API_PATHS.EXPIRY))
    .data;
