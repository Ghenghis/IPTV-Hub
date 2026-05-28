/* Copyright Alen Pepa */
'use client';

import React, { useEffect, useState } from 'react';
import { fetchM3U, xtreamLogin } from '@/lib/iptv';
import { Loader2, Tv, Link as LinkIcon, Server, Settings, Eye, EyeOff, ShieldCheck, AlertCircle, Lock } from 'lucide-react';
import axios from 'axios';
import { motion, AnimatePresence } from 'motion/react';

interface LoginProps {
  onLogin: (data: any, type: 'm3u' | 'xtream' | 'stalker' | 'vault') => void;
}

interface VaultProvider {
  id: string;
  name: string;
  configured: boolean;
  supports: string[];
}

const COMBINED_PROVIDER_ID = 'combined';

export default function Login({ onLogin }: LoginProps) {
  const [activeTab, setActiveTab] = useState<'m3u' | 'xtream' | 'stalker'>('xtream');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vaultProviders, setVaultProviders] = useState<VaultProvider[]>([]);

  // Xtream State
  const [host, setHost] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // M3U State
  const [m3uUrl, setM3uUrl] = useState('');
  const [epgUrl, setEpgUrl] = useState('');

  // Stalker State
  const [macAddress, setMacAddress] = useState('');
  const [portalUrl, setPortalUrl] = useState('');

  useEffect(() => {
    let mounted = true;
    axios.get('/api/provider-vault/providers')
      .then((response) => {
        if (!mounted) return;
        const providers = Array.isArray(response.data?.providers) ? response.data.providers : [];
        setVaultProviders(providers.filter((provider: VaultProvider) => provider.configured));
      })
      .catch(() => {
        if (mounted) setVaultProviders([]);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const isSecure = (url: string) => {
    if (!url) return true; // Don't show warning when empty
    return url.trim().startsWith('https://');
  };

  const handleXtreamLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    let validHost = host.trim();
    if (!validHost.startsWith('http://') && !validHost.startsWith('https://')) {
      validHost = `http://${validHost}`;
    }

    try {
      const urlObj = new URL(validHost);
      if (!urlObj.hostname.includes('.')) {
        throw new Error('Invalid hostname');
      }
    } catch (err) {
      setError('Invalid Server URL format. Please enter a valid URL (e.g., http://example.com:8080).');
      setLoading(false);
      return;
    }

    try {
      const data = await xtreamLogin(validHost, username, password);
      if (data.user_info && data.user_info.auth === 1) {
        onLogin({ ...data, host: validHost, username, password }, 'xtream');
      } else {
        setError('Authentication failed. Incorrect username or password.');
      }
    } catch (err: any) {
      console.error('Xtream login error:', err);
      if (err.response) {
        const status = err.response.status;
        if (status === 401 || status === 403) {
          setError('Authentication failed. Incorrect username or password.');
        } else if (status === 404) {
          setError('Server not found. Please check the Server URL.');
        } else if (status >= 500) {
          setError('Server is currently unavailable or experiencing issues.');
        } else {
          setError(`Failed to connect to server (HTTP Error ${status}).`);
        }
      } else if (err.request) {
        setError('No response from server. Check your internet connection or the Server URL.');
      } else {
        setError('Failed to connect to server. Please check your details and try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleM3uLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const isRawContent = m3uUrl.trim().startsWith('#EXTM3U');
    
    if (!isRawContent) {
      let validUrl = m3uUrl.trim();
      if (!validUrl.startsWith('http://') && !validUrl.startsWith('https://')) {
        validUrl = `http://${validUrl}`;
      }
      try {
        new URL(validUrl);
      } catch (err) {
        setError('Invalid Playlist URL format. Please enter a valid URL or paste raw #EXTM3U content.');
        setLoading(false);
        return;
      }
    }

    try {
      let playlist;
      if (isRawContent) {
        const { parseM3U } = await import('@/lib/iptv');
        playlist = parseM3U(m3uUrl);
      } else {
        let validUrl = m3uUrl.trim();
        if (!validUrl.startsWith('http://') && !validUrl.startsWith('https://')) {
          validUrl = `http://${validUrl}`;
        }
        playlist = await fetchM3U(validUrl);
      }

      if (playlist && playlist.items && playlist.items.length > 0) {
        onLogin({ playlist, url: m3uUrl, epgUrl: epgUrl.trim() || undefined }, 'm3u');
      } else {
        setError('No channels found in playlist. Please check the content or URL.');
      }
    } catch (err: any) {
      console.error('M3U login error:', err);
      if (err.response) {
        const status = err.response.status;
        if (status === 404) {
          setError('Playlist not found (404). Please check the URL.');
        } else if (status >= 500) {
          setError('Server is currently unavailable (500).');
        } else {
          setError(`Failed to load playlist (HTTP Error ${status}).`);
        }
      } else if (err.request) {
        setError('No response from server. Check your internet connection or the URL.');
      } else {
        setError('Failed to load playlist. Check URL or content format.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleStalkerLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    let validUrl = portalUrl.trim();
    if (!validUrl.startsWith('http://') && !validUrl.startsWith('https://')) {
      validUrl = `http://${validUrl}`;
    }
    try {
      new URL(validUrl);
    } catch (err) {
      setError('Invalid Portal URL format. Please enter a valid URL.');
      setLoading(false);
      return;
    }

    const rawMac = macAddress.trim();
    // Normalize MAC address: remove non-hex characters and format as XX:XX:XX:XX:XX:XX
    const hexOnly = rawMac.replace(/[^0-9A-Fa-f]/g, '');
    let normalizedMac = '';
    
    if (hexOnly.length === 12) {
      // Format 001A79... to 00:1A:79:...
      normalizedMac = hexOnly.match(/.{1,2}/g)?.join(':').toUpperCase() || rawMac;
    } else {
      normalizedMac = rawMac.toUpperCase();
    }

    const macRegex = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/;
    if (!macRegex.test(normalizedMac)) {
      setError('Invalid MAC Address format. Expected format: 00:1A:79:XX:XX:XX');
      setLoading(false);
      return;
    }

    try {
      const handshakeRes = await axios.get('/api/stalker', {
        params: { action: 'handshake', mac: normalizedMac, url: validUrl }
      });
      
      const token = handshakeRes.data?.js?.token;
      if (!token) {
        throw new Error('Handshake failed: No token received from portal. Your MAC address might not be authorized.');
      }

      const realUrl = handshakeRes.data.real_url || validUrl;

      const profileRes = await axios.get('/api/stalker', {
        params: { action: 'get_profile', mac: normalizedMac, url: realUrl, token }
      });

      if (profileRes.data?.js?.id) {
        onLogin({ mac: normalizedMac, url: realUrl, token, profile: profileRes.data.js }, 'stalker');
      } else {
        const serverError = profileRes.data?.error || profileRes.data?.js?.error;
        if (serverError) {
           setError(`Stalker Portal Error: ${serverError}`);
        } else {
           setError('Stalker authentication failed. The portal accepted your MAC but didn\'t return a profile. It might be expired or restricted.');
        }
      }

    } catch (err: any) {
      console.error('Stalker login error:', err);
      if (err.response) {
        const status = err.response.status;
        const serverError = err.response.data?.error;
        
        if (status === 401 || status === 403) {
          setError(serverError || 'Authentication failed. Your MAC address might be blocked, expired, or unregistered on this portal.');
        } else if (status === 404) {
          setError('Portal not found. Please check the Portal URL and ensure it\'s a Stalker/Ministra portal.');
        } else if (status >= 500) {
          setError('Portal server is currently unavailable or returned an internal error.');
        } else {
          setError(serverError || `Failed to connect to Stalker portal (HTTP Error ${status}).`);
        }
      } else if (err.request) {
        setError('No response from portal. Check your internet connection or the Portal URL. Some portals block requests from certain regions.');
      } else {
        setError(err.message || 'Failed to connect to Stalker portal.');
      }
    } finally {
      setLoading(false);
    }
  };

  const SecurityIndicator = ({ url }: { url: string }) => {
    if (!url) return null;
    const secure = isSecure(url);
    return (
      <div className={`flex items-center gap-1.5 text-xs mt-1.5 ${secure ? 'text-emerald-400' : 'text-amber-400'}`}>
        {secure ? <ShieldCheck className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
        <span>{secure ? 'Secure connection (HTTPS)' : 'Unsecure connection (HTTP)'}</span>
      </div>
    );
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[80vh] w-full max-w-md mx-auto p-6 relative z-10">
      <motion.div 
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="text-center mb-8"
      >
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-3xl bg-gradient-to-br from-indigo-500 to-purple-600 mb-6 shadow-2xl shadow-indigo-500/30 border border-white/10 relative overflow-hidden">
          <div className="absolute inset-0 bg-white/10 opacity-0 hover:opacity-100 transition-opacity duration-300"></div>
          <Tv className="w-10 h-10 text-white relative z-10" />
        </div>
        <h1 className="text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-white to-zinc-400 mb-3 tracking-tight">Smart IPTV</h1>
        <p className="text-zinc-400 text-sm font-medium flex items-center justify-center gap-2">
          <Lock className="w-4 h-4 text-indigo-400" />
          Securely connect to your provider
        </p>
      </motion.div>

      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.1 }}
        className="w-full bg-zinc-900/80 backdrop-blur-2xl border border-white/10 rounded-3xl p-2 mb-6 flex overflow-x-auto scrollbar-hide shadow-2xl"
      >
        {[
          { id: 'xtream', icon: Server, label: 'Xtream' },
          { id: 'm3u', icon: LinkIcon, label: 'M3U' },
          { id: 'stalker', icon: Settings, label: 'Stalker' }
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => {
              setActiveTab(tab.id as any);
              setError(null);
            }}
            className={`flex-1 py-3.5 px-4 text-sm font-semibold rounded-2xl transition-all duration-300 flex items-center justify-center gap-2 whitespace-nowrap relative ${
              activeTab === tab.id
                ? 'text-white shadow-lg'
                : 'text-zinc-400 hover:text-white hover:bg-white/5'
            }`}
          >
            {activeTab === tab.id && (
              <motion.div
                layoutId="activeTab"
                className="absolute inset-0 bg-gradient-to-r from-indigo-600 to-indigo-500 rounded-2xl -z-10"
                transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
              />
            )}
            <tab.icon className={`w-4 h-4 ${activeTab === tab.id ? 'text-white' : 'text-zinc-500'}`} />
            {tab.label}
          </button>
        ))}
      </motion.div>

      {vaultProviders.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.15 }}
          className="w-full bg-zinc-900/80 backdrop-blur-2xl border border-emerald-400/20 rounded-3xl p-4 mb-6 shadow-2xl"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {vaultProviders.map((provider) => (
              <button
                key={provider.id}
                type="button"
                disabled={loading}
                onClick={() => onLogin({ providerId: provider.id }, 'vault')}
                className="flex items-center justify-center gap-2 rounded-2xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-3.5 text-sm font-bold text-emerald-100 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ShieldCheck className="h-4 w-4 text-emerald-300" />
                {provider.name}
              </button>
            ))}
            {vaultProviders.length > 1 && (
              <button
                type="button"
                disabled={loading}
                onClick={() => onLogin({
                  providerId: COMBINED_PROVIDER_ID,
                  providers: vaultProviders.map((provider) => provider.id)
                }, 'vault')}
                className="sm:col-span-2 flex items-center justify-center gap-2 rounded-2xl border border-sky-400/25 bg-sky-500/10 px-4 py-3.5 text-sm font-bold text-sky-100 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ShieldCheck className="h-4 w-4 text-sky-300" />
                Combined Tagged Catalog
              </button>
            )}
          </div>
        </motion.div>
      )}

      <motion.div 
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5, delay: 0.2 }}
        className="w-full bg-zinc-900/80 backdrop-blur-2xl border border-white/10 rounded-3xl p-8 shadow-2xl relative overflow-hidden"
      >
        {/* Decorative background glow */}
        <div className="absolute -top-24 -right-24 w-48 h-48 bg-indigo-500/20 rounded-full blur-3xl pointer-events-none"></div>
        <div className="absolute -bottom-24 -left-24 w-48 h-48 bg-purple-500/20 rounded-full blur-3xl pointer-events-none"></div>

        <AnimatePresence mode="wait">
          {error && (
            <motion.div 
              initial={{ opacity: 0, height: 0, marginBottom: 0 }}
              animate={{ opacity: 1, height: 'auto', marginBottom: 24 }}
              exit={{ opacity: 0, height: 0, marginBottom: 0 }}
              className="overflow-hidden"
            >
              <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-2xl text-red-400 text-sm flex items-start gap-3">
                <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                <p>{error}</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="relative z-10">
          {activeTab === 'xtream' && (
            <motion.form 
              key="xtream"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ duration: 0.3 }}
              onSubmit={handleXtreamLogin} 
              className="space-y-5"
            >
              <div>
                <label className="block text-xs font-bold text-zinc-400 mb-2 uppercase tracking-widest">Server URL</label>
                <div className="relative group">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                    <Server className="h-5 w-5 text-zinc-500 group-focus-within:text-indigo-400 transition-colors" />
                  </div>
                  <input
                    type="text"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="http://example.com:8080"
                    className="w-full bg-black/50 border border-white/10 rounded-2xl pl-11 pr-4 py-3.5 text-white placeholder-zinc-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all"
                    required
                  />
                </div>
                <SecurityIndicator url={host} />
              </div>
              <div>
                <label className="block text-xs font-bold text-zinc-400 mb-2 uppercase tracking-widest">Username</label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Enter your username"
                  className="w-full bg-black/50 border border-white/10 rounded-2xl px-4 py-3.5 text-white placeholder-zinc-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-zinc-400 mb-2 uppercase tracking-widest">Password</label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full bg-black/50 border border-white/10 rounded-2xl px-4 py-3.5 text-white placeholder-zinc-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all pr-12"
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute inset-y-0 right-0 pr-4 flex items-center text-zinc-500 hover:text-zinc-300 transition-colors"
                  >
                    {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                  </button>
                </div>
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-bold py-4 rounded-2xl transition-all duration-300 mt-4 flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40"
              >
                {loading ? <Loader2 className="w-6 h-6 animate-spin" /> : 'Connect Securely'}
              </button>
            </motion.form>
          )}

          {activeTab === 'm3u' && (
            <motion.form 
              key="m3u"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ duration: 0.3 }}
              onSubmit={handleM3uLogin} 
              className="space-y-5"
            >
              <div>
                <label className="block text-xs font-bold text-zinc-400 mb-2 uppercase tracking-widest">Playlist URL or Content</label>
                <textarea
                  value={m3uUrl}
                  onChange={(e) => setM3uUrl(e.target.value)}
                  placeholder="http://example.com/playlist.m3u&#10;OR paste raw #EXTM3U content here..."
                  className="w-full bg-black/50 border border-white/10 rounded-2xl px-4 py-3.5 text-white placeholder-zinc-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all min-h-[140px] resize-y"
                  required
                />
                {!m3uUrl.trim().startsWith('#EXTM3U') && <SecurityIndicator url={m3uUrl} />}
              </div>
              <div>
                <label className="block text-xs font-bold text-zinc-400 mb-2 uppercase tracking-widest">EPG URL <span className="text-zinc-600 font-normal">(Optional)</span></label>
                <input
                  type="url"
                  value={epgUrl}
                  onChange={(e) => setEpgUrl(e.target.value)}
                  placeholder="http://example.com/epg.xml"
                  className="w-full bg-black/50 border border-white/10 rounded-2xl px-4 py-3.5 text-white placeholder-zinc-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all"
                />
                <SecurityIndicator url={epgUrl} />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-bold py-4 rounded-2xl transition-all duration-300 mt-4 flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40"
              >
                {loading ? <Loader2 className="w-6 h-6 animate-spin" /> : 'Load Playlist'}
              </button>
            </motion.form>
          )}

          {activeTab === 'stalker' && (
            <motion.form 
              key="stalker"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              transition={{ duration: 0.3 }}
              onSubmit={handleStalkerLogin} 
              className="space-y-5"
            >
              <div>
                <label className="block text-xs font-bold text-zinc-400 mb-2 uppercase tracking-widest">Portal URL</label>
                <div className="relative group">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                    <Server className="h-5 w-5 text-zinc-500 group-focus-within:text-indigo-400 transition-colors" />
                  </div>
                  <input
                    type="text"
                    value={portalUrl}
                    onChange={(e) => setPortalUrl(e.target.value)}
                    placeholder="http://example.com/c/"
                    className="w-full bg-black/50 border border-white/10 rounded-2xl pl-11 pr-4 py-3.5 text-white placeholder-zinc-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all"
                    required
                  />
                </div>
                <SecurityIndicator url={portalUrl} />
              </div>
              <div>
                <label className="block text-xs font-bold text-zinc-400 mb-2 uppercase tracking-widest">MAC Address</label>
                <input
                  type="text"
                  value={macAddress}
                  onChange={(e) => setMacAddress(e.target.value)}
                  placeholder="00:1A:79:XX:XX:XX"
                  className="w-full bg-black/50 border border-white/10 rounded-2xl px-4 py-3.5 text-white placeholder-zinc-600 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all uppercase"
                  required
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-bold py-4 rounded-2xl transition-all duration-300 mt-4 flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-indigo-500/25 hover:shadow-indigo-500/40"
              >
                {loading ? <Loader2 className="w-6 h-6 animate-spin" /> : 'Connect Portal'}
              </button>
            </motion.form>
          )}
        </div>
      </motion.div>
      
      <motion.p 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.4 }}
        className="text-center text-xs text-zinc-500 mt-6 max-w-xs"
      >
        Private provider accounts stay server-side when launched from DaveTV.
      </motion.p>
    </div>
  );
}
