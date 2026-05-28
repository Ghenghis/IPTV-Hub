/* Copyright Alen Pepa */
'use client';

import React, { useState, useEffect, useRef } from 'react';
import Login from '@/components/auth/Login';
import Sidebar from '@/components/layout/Sidebar';
import Header from '@/components/dashboard/Header';
import ChannelGrid from '@/components/dashboard/ChannelGrid';
import VideoPlayer from '@/components/player/VideoPlayer';
import ChannelDetailsModal from '@/components/dashboard/ChannelDetailsModal';
import SettingsView from '@/components/dashboard/SettingsView';
import { Channel, fetchM3U, categorizeChannels, fetchEPG, EPGData } from '@/lib/iptv';
import { getValidImageUrl } from '@/lib/utils';
import { Loader2 } from 'lucide-react';
import axios from 'axios';

const VAULT_CATALOG_PARAMS = {
  profile: 'english',
  liveLimit: 1200,
  movieLimit: 800,
  seriesLimit: 800,
};

const COMBINED_PROVIDER_ID = 'combined';
const COMBINED_PROVIDER_NAME = 'Combined Tagged';
const DEFAULT_COMBINED_PROVIDERS = ['apollo', 'xtremehd'];

function tagVaultChannel(channel: Channel, provider: { id: string; name: string }): Channel {
  const groupTitle = channel.group?.title || 'Uncategorized';
  return {
    ...channel,
    group: {
      ...channel.group,
      title: `${provider.name} / ${groupTitle}`,
    },
    raw: channel.raw || `provider:${provider.id}`,
  };
}

export default function Home() {
  // Playlists
  const [liveChannels, setLiveChannels] = useState<Channel[]>([]);
  const [movieChannels, setMovieChannels] = useState<Channel[]>([]);
  const [seriesChannels, setSeriesChannels] = useState<Channel[]>([]);
  const [favorites, setFavorites] = useState<Channel[]>([]);

  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null);
  const [, setBadChannelUrls] = useState<Set<string>>(new Set());
  const badChannelUrlsRef = useRef<Set<string>>(new Set());
  const [detailsChannel, setDetailsChannel] = useState<Channel | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('live');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState('All');
  const [stalkerSession, setStalkerSession] = useState<{mac: string, url: string, token: string} | null>(null);
  const [userInfo, setUserInfo] = useState<any>(null);
  const [epgData, setEpgData] = useState<EPGData | null>(null);
  const [hasRestoredChannel, setHasRestoredChannel] = useState(false);
  const autoRestoreAttemptedRef = useRef(false);

  // Load favorites from local storage
  useEffect(() => {
    const savedFavs = localStorage.getItem('favorites');
    if (savedFavs) {
      try {
        setFavorites(JSON.parse(savedFavs));
      } catch (e) {
        console.error('Failed to load favorites', e);
      }
    }
  }, []);

  // Save last played channel
  useEffect(() => {
    if (selectedChannel) {
      localStorage.setItem('lastPlayedChannel', JSON.stringify(selectedChannel));
    }
  }, [selectedChannel]);

  // Restore last played channel
  useEffect(() => {
    if (isAuthenticated && !hasRestoredChannel && (liveChannels.length > 0 || movieChannels.length > 0 || seriesChannels.length > 0)) {
      const saved = localStorage.getItem('lastPlayedChannel');
      if (saved) {
        try {
          const channel = JSON.parse(saved);
          const exists = liveChannels.some(c => c.url === channel.url) || 
                         movieChannels.some(c => c.url === channel.url) || 
                         seriesChannels.some(c => c.url === channel.url);
          if (exists) {
            setSelectedChannel(channel);
          }
        } catch (e) {
          console.error('Failed to parse last played channel', e);
        }
      }
      setHasRestoredChannel(true);
    }
  }, [isAuthenticated, hasRestoredChannel, liveChannels, movieChannels, seriesChannels]);

  const toggleFavorite = (channel: Channel) => {
    const isFav = favorites.some(f => f.url === channel.url);
    let newFavs;
    if (isFav) {
      newFavs = favorites.filter(f => f.url !== channel.url);
    } else {
      newFavs = [...favorites, channel];
    }
    setFavorites(newFavs);
    localStorage.setItem('favorites', JSON.stringify(newFavs));
  };

  const processPlaylist = (items: Channel[]) => {
    const { live, movies, series } = categorizeChannels(items);
    setLiveChannels(live);
    setMovieChannels(movies);
    setSeriesChannels(series);
    // Default to home tab if not already set or if currently on login
    if (!isAuthenticated) setActiveTab('home');
  };

  const handleLogin = async (data: any, type: 'm3u' | 'xtream' | 'stalker' | 'vault') => {
    setLoading(true);
    try {
      if (type === 'vault') {
        const providerId = data.providerId;

        if (providerId === COMBINED_PROVIDER_ID) {
          const requestedProviders = Array.isArray(data.providers) && data.providers.length
            ? data.providers
            : DEFAULT_COMBINED_PROVIDERS;
          const responses = await Promise.all(
            requestedProviders.map((id: string) => axios.get('/api/provider-vault/catalog', {
              params: { ...VAULT_CATALOG_PARAMS, provider: id }
            }))
          );

          const providers = responses.map((response) => response.data.provider).filter(Boolean);
          setLiveChannels(responses.flatMap((response) => {
            const provider = response.data.provider;
            return (response.data.live || []).map((channel: Channel) => tagVaultChannel(channel, provider));
          }));
          setMovieChannels(responses.flatMap((response) => {
            const provider = response.data.provider;
            return (response.data.movies || []).map((channel: Channel) => tagVaultChannel(channel, provider));
          }));
          setSeriesChannels(responses.flatMap((response) => {
            const provider = response.data.provider;
            return (response.data.series || []).map((channel: Channel) => tagVaultChannel(channel, provider));
          }));
          setUserInfo({ providerName: COMBINED_PROVIDER_NAME, providers });
          if (!isAuthenticated) setActiveTab('home');
          setIsAuthenticated(true);
          try {
            localStorage.setItem('iptv_default_provider', COMBINED_PROVIDER_ID);
            localStorage.setItem('iptv_session', JSON.stringify({
              data: { providerId: COMBINED_PROVIDER_ID, providers: requestedProviders },
              type,
              userInfo: { providerName: COMBINED_PROVIDER_NAME, providers }
            }));
          } catch (e) {
            console.warn('Failed to save combined vault session to localStorage', e);
          }
          return;
        }

        const response = await axios.get('/api/provider-vault/catalog', {
          params: { ...VAULT_CATALOG_PARAMS, provider: providerId }
        });

        setLiveChannels(response.data.live || []);
        setMovieChannels(response.data.movies || []);
        setSeriesChannels(response.data.series || []);
        setUserInfo(response.data.userInfo || { providerName: response.data.provider?.name });
        if (!isAuthenticated) setActiveTab('home');
        setIsAuthenticated(true);
        try {
          localStorage.setItem('iptv_default_provider', providerId);
          localStorage.setItem('iptv_session', JSON.stringify({
            data: { providerId },
            type,
            userInfo: response.data.userInfo
          }));
        } catch (e) {
          console.warn('Failed to save vault session to localStorage', e);
        }
      } else if (type === 'm3u') {
        let items = data.playlist?.items;
        
        // If we only have the URL (e.g. from session restore), fetch it
        if (!items && data.url && !data.url.trim().startsWith('#EXTM3U')) {
          const fetchedPlaylist = await fetchM3U(data.url);
          items = fetchedPlaylist.items;
        } else if (!items && data.url && data.url.trim().startsWith('#EXTM3U')) {
          const { parseM3U } = await import('@/lib/iptv');
          items = parseM3U(data.url).items;
        }

        if (!items) throw new Error('No channels found');

        processPlaylist(items);
        setIsAuthenticated(true);
        
        try {
          // Don't store the massive playlist array in localStorage, just the URL/content
          localStorage.setItem('iptv_session', JSON.stringify({ 
            data: { url: data.url, epgUrl: data.epgUrl }, 
            type 
          }));
        } catch (e) {
          console.warn('Failed to save session to localStorage (might be too large)', e);
        }
        
        // Try to fetch EPG if URL is provided in data
        if (data.epgUrl) {
          fetchEPG(data.epgUrl).then(setEpgData).catch(e => console.error('Failed to load EPG', e));
        }
      } else if (type === 'xtream') {
        const { host, username, password } = data;
        const baseUrl = host.endsWith('/') ? host.slice(0, -1) : host;
        
        // Fetch user info first
        let xtreamUserInfo = null;
        try {
           const { xtreamLogin } = await import('@/lib/iptv');
           const loginData = await xtreamLogin(baseUrl, username, password);
           if (loginData && loginData.user_info) {
             // Combine user_info and server_info for a more complete profile
             xtreamUserInfo = { 
               ...loginData.user_info, 
               server_info: loginData.server_info 
             };
             setUserInfo(xtreamUserInfo);
           }
        } catch (e) {
           console.error('Failed to fetch Xtream user info', e);
        }

        const epgUrl = `${baseUrl}/xmltv.php?username=${username}&password=${password}`;
        
        const { fetchXtreamData } = await import('@/lib/iptv');
        const { live, movies, series } = await fetchXtreamData(baseUrl, username, password);
        
        setLiveChannels(live);
        setMovieChannels(movies);
        setSeriesChannels(series);
        if (!isAuthenticated) setActiveTab('home');
        
        setIsAuthenticated(true);
        const sessionData = { data, type, userInfo: xtreamUserInfo };
        localStorage.setItem('iptv_session', JSON.stringify(sessionData));
        
        // Fetch EPG in background
        fetchEPG(epgUrl).then(setEpgData).catch(e => console.error('Failed to load Xtream EPG', e));
      } else if (type === 'stalker') {
        const { mac, url, token } = data;
        setStalkerSession({ mac, url, token });
        
        const channelsRes = await axios.get('/api/stalker', {
          params: { action: 'get_channels', mac, url, token }
        });

        const rawChannels = channelsRes.data?.js?.data || [];
        
        const mappedChannels: Channel[] = rawChannels.map((ch: any) => ({
          name: ch.name,
          tvg: {
            id: ch.id,
            name: ch.name,
            logo: ch.logo,
            url: '',
            rec: ''
          },
          group: {
            title: 'All Channels' 
          },
          http: {
            referrer: '',
            'user-agent': ''
          },
          url: `STALKER_CMD:${ch.cmd}`, 
          raw: ''
        }));

        processPlaylist(mappedChannels);
        setIsAuthenticated(true);
        localStorage.setItem('iptv_session', JSON.stringify({ data, type }));
      }
    } catch (error: any) {
      console.error('Login failed', error);
      let message = 'Failed to load playlist. Please try again.';
      
      if (error.response?.data?.details) {
        message = `Login failed: ${error.response.data.details}`;
        if (error.response.data.upstreamStatus) {
           message += ` (Status: ${error.response.data.upstreamStatus})`;
        }
      } else if (error.message) {
        message = `Login failed: ${error.message}`;
      }
      
      alert(message);
      localStorage.removeItem('iptv_session');
    } finally {
      setLoading(false);
    }
  };

  // Custom player wrapper to handle Stalker URL resolution
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);

  useEffect(() => {
    const resolveUrl = async () => {
      if (!selectedChannel) return;
      setResolvedUrl(null);

      if (selectedChannel.url.startsWith('STALKER_CMD:')) {
        if (!stalkerSession) return;
        
        const cmd = selectedChannel.url.replace('STALKER_CMD:', '');
        try {
          const res = await axios.get('/api/stalker', {
            params: { 
              action: 'create_link', 
              mac: stalkerSession.mac, 
              url: stalkerSession.url, 
              token: stalkerSession.token,
              cmd 
            }
          });
          
          if (res.data.url) {
            setResolvedUrl(res.data.url);
          } else {
            console.error('Failed to resolve Stalker link');
          }
        } catch (e) {
          console.error('Error resolving Stalker link', e);
        }
      } else if (selectedChannel.url.startsWith('VAULT_SERIES:')) {
        const [, providerId, seriesId] = selectedChannel.url.split(':');
        try {
          const res = await axios.get('/api/provider-vault/series-first', {
            params: { provider: providerId, seriesId }
          });
          if (res.data.url) {
            setResolvedUrl(res.data.url);
          }
        } catch (e) {
          console.error('Error resolving vault series link', e);
        }
      } else if (selectedChannel.url.startsWith('XTREAM_SERIES:')) {
        const seriesId = selectedChannel.url.replace('XTREAM_SERIES:', '');
        const sessionData = localStorage.getItem('iptv_session');
        if (sessionData) {
          try {
            const { data } = JSON.parse(sessionData);
            if (data.host && data.username && data.password) {
              const baseUrl = data.host.endsWith('/') ? data.host.slice(0, -1) : data.host;
              const apiUrl = `${baseUrl}/player_api.php?username=${data.username}&password=${data.password}&action=get_series_info&series_id=${seriesId}`;
              
              const fetchApi = async () => {
                try {
                  const response = await axios.get(apiUrl);
                  return response.data;
                } catch (e) {
                  throw e;
                }
              };

              const seriesInfo = await fetchApi();
              if (seriesInfo && seriesInfo.episodes) {
                // Find the first episode of the first available season
                const seasons = Object.keys(seriesInfo.episodes);
                if (seasons.length > 0) {
                  const firstSeason = seasons[0];
                  const episodes = seriesInfo.episodes[firstSeason];
                  if (episodes && episodes.length > 0) {
                    const firstEpisode = episodes[0];
                    const streamUrl = `${baseUrl}/series/${data.username}/${data.password}/${firstEpisode.id}.${firstEpisode.container_extension || 'mp4'}`;
                    setResolvedUrl(streamUrl);
                    return;
                  }
                }
              }
              console.error('No episodes found for this series');
            }
          } catch (e) {
            console.error('Error resolving Xtream series link', e);
          }
        }
      } else {
        setResolvedUrl(selectedChannel.url);
      }
    };

    resolveUrl();
  }, [selectedChannel, stalkerSession]);

  useEffect(() => {
    if (autoRestoreAttemptedRef.current) return;
    autoRestoreAttemptedRef.current = true;

    const restoreSession = async () => {
      const savedSession = localStorage.getItem('iptv_session');
      if (savedSession) {
        try {
          const session = JSON.parse(savedSession);
          if (session.userInfo) {
            setUserInfo(session.userInfo);
          }
          await handleLogin(session.data, session.type);
          return;
        } catch (e) {
          console.error('Failed to restore saved session', e);
          localStorage.removeItem('iptv_session');
        }
      }

      try {
        const response = await axios.get('/api/provider-vault/providers');
        const providers = Array.isArray(response.data?.providers)
          ? response.data.providers.filter((provider: any) => provider.configured)
          : [];
        if (!providers.length) return;

        const preferredProvider = localStorage.getItem('iptv_default_provider');
        const provider =
          providers.find((item: any) => item.id === preferredProvider) ||
          providers.find((item: any) => item.id === 'apollo') ||
          providers[0];

        if (preferredProvider === COMBINED_PROVIDER_ID && providers.length > 1) {
          await handleLogin({ providerId: COMBINED_PROVIDER_ID, providers: providers.map((item: any) => item.id) }, 'vault');
        } else if (provider?.id) {
          await handleLogin({ providerId: provider.id }, 'vault');
        }
      } catch (e) {
        console.error('Failed to auto-launch provider from vault', e);
      }
    };

    restoreSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLogout = () => {
    setIsAuthenticated(false);
    setLiveChannels([]);
    setMovieChannels([]);
    setSeriesChannels([]);
    setFavorites([]);
    setSelectedChannel(null);
    setBadChannelUrls(new Set());
    badChannelUrlsRef.current = new Set();
    setHasRestoredChannel(false);
    localStorage.removeItem('iptv_session');
    localStorage.removeItem('lastPlayedChannel');
    localStorage.removeItem('favorites'); // Optional: keep favorites?
  };

  const getActiveChannels = () => {
    switch (activeTab) {
      case 'live': return liveChannels;
      case 'movies': return movieChannels;
      case 'series': return seriesChannels;
      case 'favorites': return favorites;
      default: return [];
    }
  };

  const handleSearch = (query: string) => {
    setSearchQuery(query);
    if (query.trim() !== '' && activeTab === 'home') {
      setActiveTab('live');
    }
  };

  const handleNextChannel = () => {
    const channels = getActiveChannels();
    if (!channels.length || !selectedChannel) return;
    const currentIndex = channels.findIndex(c => c.url === selectedChannel.url);
    if (currentIndex === -1) return;

    for (let offset = 1; offset <= channels.length; offset++) {
      const candidate = channels[(currentIndex + offset) % channels.length];
      if (!badChannelUrlsRef.current.has(candidate.url) || offset === channels.length) {
        setSelectedChannel(candidate);
        return;
      }
    }
  };

  const handlePrevChannel = () => {
    const channels = getActiveChannels();
    if (!channels.length || !selectedChannel) return;
    const currentIndex = channels.findIndex(c => c.url === selectedChannel.url);
    if (currentIndex > 0) {
      setSelectedChannel(channels[currentIndex - 1]);
    } else if (currentIndex === 0) {
      setSelectedChannel(channels[channels.length - 1]); // Loop around
    }
  };

  const markSelectedChannelBad = () => {
    if (!selectedChannel) return;
    const next = new Set(badChannelUrlsRef.current);
    next.add(selectedChannel.url);
    badChannelUrlsRef.current = next;
    setBadChannelUrls(next);
  };

  if (!isAuthenticated) {
    return (
      <main className="min-h-screen bg-black text-white flex items-center justify-center bg-[url('https://images.unsplash.com/photo-1574375927938-d5a98e8ffe85?q=80&w=2069&auto=format&fit=crop')] bg-cover bg-center bg-no-repeat">
        <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" />
        <div className="relative z-10 w-full">
          {loading ? (
            <div className="flex flex-col items-center justify-center text-white">
              <Loader2 className="w-16 h-16 text-indigo-500 animate-spin mb-4" />
              <p className="text-lg font-medium">Loading your channels...</p>
              <p className="text-sm text-zinc-400">This might take a moment for large playlists</p>
            </div>
          ) : (
            <Login onLogin={handleLogin} />
          )}
        </div>
      </main>
    );
  }

  const handleBack = () => {
    if (activeTab === 'live' && activeCategory !== 'All') {
      setActiveCategory('All');
    } else {
      setActiveTab('home');
    }
  };

  return (
    <main className="flex h-screen bg-black text-white overflow-hidden font-sans">
      <Sidebar 
        isOpen={sidebarOpen} 
        onClose={() => setSidebarOpen(false)}
        activeTab={activeTab}
        onTabChange={(tab) => {
          setActiveTab(tab);
          setActiveCategory('All'); // Reset category on tab change
          setSearchQuery('');
        }}
        onLogout={handleLogout}
      />

      <div className="flex-1 flex flex-col h-full relative w-full bg-zinc-950">
        <Header 
          onSearch={handleSearch} 
          toggleSidebar={() => setSidebarOpen(!sidebarOpen)} 
          userInfo={userInfo}
          onLogout={handleLogout}
          onTabChange={setActiveTab}
          onBack={handleBack}
          searchQuery={searchQuery}
          activeTab={activeTab}
        />

        <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-800">
          {/* Hero / Player Section - Only show if playing */}
          {selectedChannel && (
            <div className="w-full aspect-video max-h-[60vh] bg-black sticky top-0 z-20 shadow-2xl">
              {resolvedUrl && (
                <VideoPlayer 
                  url={resolvedUrl} 
                  poster={getValidImageUrl(selectedChannel.tvg.logo) || undefined}
                  autoPlay={true}
                  channelName={selectedChannel.name}
                  onNextChannel={handleNextChannel}
                  onPrevChannel={handlePrevChannel}
                  onPlaybackFailure={markSelectedChannelBad}
                  epgData={epgData}
                  channelId={selectedChannel.tvg.id || selectedChannel.name}
                />
              )}
              <button 
                onClick={() => setSelectedChannel(null)}
                className="absolute top-4 right-4 bg-black/50 p-2 rounded-full hover:bg-white/20 text-white"
              >
                ✕
              </button>
            </div>
          )}

          {/* Content Grid or Settings */}
          {activeTab === 'settings' ? (
            <SettingsView 
              onClearData={handleLogout} 
              onRefreshPlaylist={() => {
                const session = localStorage.getItem('iptv_session');
                if (session) {
                  const parsed = JSON.parse(session);
                  handleLogin(parsed.data, parsed.type);
                }
              }}
            />
          ) : (
            <div className="max-w-[1920px] mx-auto">
              {activeTab === 'home' ? (
                 <div className="p-8">
                    <h2 className="text-3xl font-bold mb-6">Welcome Back</h2>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                       <div 
                         onClick={() => setActiveTab('live')}
                         className="bg-gradient-to-br from-indigo-600 to-purple-700 p-6 rounded-2xl cursor-pointer hover:scale-105 transition-transform"
                       >
                          <h3 className="text-2xl font-bold mb-2">Live TV</h3>
                          <p className="text-white/80">{liveChannels.length} Channels</p>
                       </div>
                       <div 
                         onClick={() => setActiveTab('movies')}
                         className="bg-gradient-to-br from-pink-600 to-rose-700 p-6 rounded-2xl cursor-pointer hover:scale-105 transition-transform"
                       >
                          <h3 className="text-2xl font-bold mb-2">Movies</h3>
                          <p className="text-white/80">{movieChannels.length} Titles</p>
                       </div>
                       <div 
                         onClick={() => setActiveTab('series')}
                         className="bg-gradient-to-br from-emerald-600 to-teal-700 p-6 rounded-2xl cursor-pointer hover:scale-105 transition-transform"
                       >
                          <h3 className="text-2xl font-bold mb-2">Series</h3>
                          <p className="text-white/80">{seriesChannels.length} Shows</p>
                       </div>
                    </div>
                 </div>
              ) : (
                <ChannelGrid 
                  channels={getActiveChannels()}
                  onSelectChannel={setSelectedChannel}
                  onShowDetails={setDetailsChannel}
                  selectedChannel={selectedChannel}
                  searchQuery={searchQuery}
                  activeCategory={activeCategory}
                  onCategoryChange={setActiveCategory}
                  favorites={favorites}
                  onToggleFavorite={toggleFavorite}
                  epgData={epgData}
                  activeTab={activeTab}
                />
              )}
            </div>
          )}
        </div>
      </div>

      <ChannelDetailsModal 
        channel={detailsChannel}
        isOpen={!!detailsChannel}
        onClose={() => setDetailsChannel(null)}
        onPlay={setSelectedChannel}
        epgData={epgData}
      />
    </main>
  );
}
