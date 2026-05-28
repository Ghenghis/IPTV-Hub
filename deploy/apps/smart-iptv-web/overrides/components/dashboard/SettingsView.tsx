/* Copyright Alen Pepa */
import React, { useState, useEffect } from 'react';
import { Save, Trash2, RefreshCw, Settings, PlayCircle, Wifi, Cpu, Shield, Clock, Monitor } from 'lucide-react';

interface SettingsViewProps {
  onClearData: () => void;
  onRefreshPlaylist: () => void;
}

export default function SettingsView({ onClearData, onRefreshPlaylist }: SettingsViewProps) {
  const [activeTab, setActiveTab] = useState('general');
  const [isSaving, setIsSaving] = useState(false);

  // Settings State
  const [settings, setSettings] = useState({
    // General
    theme: 'dark',
    clockFormat: '24h',
    epgUpdateFrequency: '24',
    showAdultChannels: false,
    parentalPin: '',
    
    // Playback
    streamQuality: 'auto',
    autoPlay: true,
    hardwareAcceleration: true,
    defaultVolume: '100',
    bufferSize: '256',
    
    // Network
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    timeoutDuration: '15',
    retryCount: '3',
    
    // Advanced
    liveBufferLatencyChasing: false,
    maxBufferLength: '300',
    seekType: 'range',
    debugMode: false,
  });

  useEffect(() => {
    // Load all settings from localStorage
    const loadedSettings = { ...settings };
    let hasChanges = false;

    Object.keys(loadedSettings).forEach((key) => {
      const savedValue = localStorage.getItem(`iptv_setting_${key}`);
      if (savedValue !== null) {
        // Handle boolean parsing
        if (savedValue === 'true') (loadedSettings as any)[key] = true;
        else if (savedValue === 'false') (loadedSettings as any)[key] = false;
        else (loadedSettings as any)[key] = savedValue;
        hasChanges = true;
      }
    });

    // Backwards compatibility for old settings
    const oldPin = localStorage.getItem('parental_pin');
    const oldQuality = localStorage.getItem('stream_quality');
    
    if (oldPin && !localStorage.getItem('iptv_setting_parentalPin')) {
      loadedSettings.parentalPin = oldPin;
      hasChanges = true;
    }
    if (oldQuality && !localStorage.getItem('iptv_setting_streamQuality')) {
      loadedSettings.streamQuality = oldQuality;
      hasChanges = true;
    }

    if (hasChanges) {
      setSettings(loadedSettings);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChange = (key: string, value: any) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const handleSave = () => {
    setIsSaving(true);
    
    // Save all settings
    Object.entries(settings).forEach(([key, value]) => {
      localStorage.setItem(`iptv_setting_${key}`, String(value));
    });
    
    // Backwards compatibility
    localStorage.setItem('parental_pin', settings.parentalPin);
    localStorage.setItem('stream_quality', settings.streamQuality);

    setTimeout(() => {
      setIsSaving(false);
      // Optional: Add a toast notification here instead of alert
    }, 600);
  };

  const tabs = [
    { id: 'general', label: 'General', icon: Settings },
    { id: 'playback', label: 'Playback', icon: PlayCircle },
    { id: 'network', label: 'Network', icon: Wifi },
    { id: 'advanced', label: 'Advanced', icon: Cpu },
  ];

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto text-white h-[calc(100vh-4rem)] overflow-y-auto pb-24">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
          <h2 className="text-3xl font-bold">Advanced Settings</h2>
          <p className="text-zinc-400 mt-1">Configure your IPTV experience</p>
        </div>
        
        <button 
          onClick={handleSave}
          disabled={isSaving}
          className={`flex items-center gap-2 px-6 py-3 rounded-xl font-medium shadow-lg transition-all ${
            isSaving 
              ? 'bg-zinc-700 text-zinc-400 cursor-not-allowed' 
              : 'bg-indigo-600 hover:bg-indigo-700 shadow-indigo-500/20 hover:scale-105'
          }`}
        >
          <Save className={`w-5 h-5 ${isSaving ? 'animate-pulse' : ''}`} />
          {isSaving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>

      <div className="flex flex-col lg:flex-row gap-8">
        {/* Sidebar Navigation */}
        <div className="w-full lg:w-64 flex-shrink-0 space-y-2">
          {tabs.map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${
                  activeTab === tab.id 
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' 
                    : 'bg-zinc-900/50 text-zinc-400 hover:bg-zinc-800 hover:text-white'
                }`}
              >
                <Icon className="w-5 h-5" />
                <span className="font-medium">{tab.label}</span>
              </button>
            );
          })}

          <div className="pt-8 space-y-2">
            <button 
              onClick={onRefreshPlaylist}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-zinc-900/50 text-zinc-300 hover:bg-zinc-800 transition-all border border-white/5"
            >
              <RefreshCw className="w-5 h-5 text-blue-400" />
              <span className="font-medium">Refresh Playlist</span>
            </button>
            
            <button 
              onClick={() => {
                if (confirm('Are you sure you want to clear all data and logout? This cannot be undone.')) {
                  onClearData();
                }
              }}
              className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-red-950/30 text-red-400 hover:bg-red-900/50 transition-all border border-red-900/30"
            >
              <Trash2 className="w-5 h-5" />
              <span className="font-medium">Clear Data & Logout</span>
            </button>
          </div>
        </div>

        {/* Settings Content */}
        <div className="flex-1 bg-zinc-900/80 border border-white/5 rounded-2xl p-6 md:p-8">
          
          {/* GENERAL TAB */}
          {activeTab === 'general' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
              <div className="flex items-center gap-3 border-b border-white/10 pb-4">
                <Settings className="w-6 h-6 text-indigo-400" />
                <h3 className="text-xl font-semibold">General Preferences</h3>
              </div>

              <div className="grid md:grid-cols-2 gap-8">
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-zinc-400 mb-2">App Theme</label>
                    <select 
                      value={settings.theme}
                      onChange={(e) => handleChange('theme', e.target.value)}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-3 text-white focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                    >
                      <option value="dark">Dark Mode (Default)</option>
                      <option value="midnight">Midnight OLED</option>
                      <option value="light">Light Mode</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-zinc-400 mb-2">Clock Format</label>
                    <div className="flex bg-zinc-950 p-1 rounded-lg border border-zinc-800">
                      <button 
                        onClick={() => handleChange('clockFormat', '12h')}
                        className={`flex-1 py-2 rounded-md text-sm font-medium transition-colors ${settings.clockFormat === '12h' ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
                      >
                        12-Hour (AM/PM)
                      </button>
                      <button 
                        onClick={() => handleChange('clockFormat', '24h')}
                        className={`flex-1 py-2 rounded-md text-sm font-medium transition-colors ${settings.clockFormat === '24h' ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
                      >
                        24-Hour
                      </button>
                    </div>
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-zinc-400 mb-2">EPG Update Frequency</label>
                    <select 
                      value={settings.epgUpdateFrequency}
                      onChange={(e) => handleChange('epgUpdateFrequency', e.target.value)}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-3 text-white focus:ring-2 focus:ring-indigo-500 focus:outline-none"
                    >
                      <option value="12">Every 12 Hours</option>
                      <option value="24">Every 24 Hours (Recommended)</option>
                      <option value="48">Every 48 Hours</option>
                      <option value="72">Every 72 Hours</option>
                      <option value="manual">Manual Only</option>
                    </select>
                  </div>
                </div>

                <div className="space-y-6">
                  <div className="bg-zinc-950/50 p-5 rounded-xl border border-zinc-800/50">
                    <div className="flex items-center gap-3 mb-4">
                      <Shield className="w-5 h-5 text-rose-400" />
                      <h4 className="font-medium text-rose-100">Parental Controls</h4>
                    </div>
                    
                    <div className="space-y-4">
                      <label className="flex items-center justify-between cursor-pointer">
                        <span className="text-sm text-zinc-300">Show Adult Channels</span>
                        <div className="relative">
                          <input 
                            type="checkbox" 
                            className="sr-only" 
                            checked={settings.showAdultChannels}
                            onChange={(e) => handleChange('showAdultChannels', e.target.checked)}
                          />
                          <div className={`block w-10 h-6 rounded-full transition-colors ${settings.showAdultChannels ? 'bg-rose-500' : 'bg-zinc-700'}`}></div>
                          <div className={`absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform ${settings.showAdultChannels ? 'transform translate-x-4' : ''}`}></div>
                        </div>
                      </label>

                      <div>
                        <label className="block text-sm font-medium text-zinc-400 mb-2">Parental PIN Code</label>
                        <input 
                          type="password" 
                          maxLength={4}
                          value={settings.parentalPin}
                          onChange={(e) => handleChange('parentalPin', e.target.value.replace(/\D/g, ''))}
                          placeholder="Enter 4-digit PIN"
                          className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-2 text-white focus:ring-2 focus:ring-rose-500 focus:outline-none placeholder-zinc-600 text-center tracking-[0.5em] font-mono text-lg"
                        />
                        <p className="text-xs text-zinc-500 mt-2">Required to access locked categories or change this setting.</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* PLAYBACK TAB */}
          {activeTab === 'playback' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
              <div className="flex items-center gap-3 border-b border-white/10 pb-4">
                <PlayCircle className="w-6 h-6 text-emerald-400" />
                <h3 className="text-xl font-semibold">Playback & Video</h3>
              </div>

              <div className="grid md:grid-cols-2 gap-8">
                <div className="space-y-6">
                  <div>
                    <label className="block text-sm font-medium text-zinc-400 mb-2">Default Stream Quality</label>
                    <select 
                      value={settings.streamQuality}
                      onChange={(e) => handleChange('streamQuality', e.target.value)}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-3 text-white focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                    >
                      <option value="auto">Auto (Best Available)</option>
                      <option value="4k">4K Ultra HD</option>
                      <option value="1080p">1080p Full HD</option>
                      <option value="720p">720p HD</option>
                      <option value="480p">480p SD (Data Saver)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-zinc-400 mb-2">Default Volume: {settings.defaultVolume}%</label>
                    <input 
                      type="range" 
                      min="0" 
                      max="100" 
                      value={settings.defaultVolume}
                      onChange={(e) => handleChange('defaultVolume', e.target.value)}
                      className="w-full h-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                    />
                  </div>

                  <label className="flex items-center justify-between cursor-pointer bg-zinc-950 p-4 rounded-xl border border-zinc-800/50 hover:border-zinc-700 transition-colors">
                    <div>
                      <span className="block text-sm font-medium text-zinc-200">Auto-Play Channels</span>
                      <span className="block text-xs text-zinc-500 mt-1">Start playing immediately when selected</span>
                    </div>
                    <div className="relative">
                      <input 
                        type="checkbox" 
                        className="sr-only" 
                        checked={settings.autoPlay}
                        onChange={(e) => handleChange('autoPlay', e.target.checked)}
                      />
                      <div className={`block w-10 h-6 rounded-full transition-colors ${settings.autoPlay ? 'bg-emerald-500' : 'bg-zinc-700'}`}></div>
                      <div className={`absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform ${settings.autoPlay ? 'transform translate-x-4' : ''}`}></div>
                    </div>
                  </label>
                </div>

                <div className="space-y-6">
                  <div>
                    <label className="block text-sm font-medium text-zinc-400 mb-2">Initial Buffer Size (MB)</label>
                    <select 
                      value={settings.bufferSize}
                      onChange={(e) => handleChange('bufferSize', e.target.value)}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-3 text-white focus:ring-2 focus:ring-emerald-500 focus:outline-none"
                    >
                      <option value="8">8 MB (Fast Start, High Network Usage)</option>
                      <option value="16">16 MB (Balanced)</option>
                      <option value="32">32 MB (Default)</option>
                      <option value="64">64 MB (Smooth Playback, Slower Start)</option>
                      <option value="128">128 MB (For Unstable Connections)</option>
                      <option value="256">256 MB (Large Movie Buffer)</option>
                      <option value="512">512 MB (Maximum Buffer)</option>
                    </select>
                  </div>

                  <label className="flex items-center justify-between cursor-pointer bg-zinc-950 p-4 rounded-xl border border-zinc-800/50 hover:border-zinc-700 transition-colors">
                    <div>
                      <span className="block text-sm font-medium text-zinc-200">Hardware Acceleration</span>
                      <span className="block text-xs text-zinc-500 mt-1">Use GPU for video decoding if available</span>
                    </div>
                    <div className="relative">
                      <input 
                        type="checkbox" 
                        className="sr-only" 
                        checked={settings.hardwareAcceleration}
                        onChange={(e) => handleChange('hardwareAcceleration', e.target.checked)}
                      />
                      <div className={`block w-10 h-6 rounded-full transition-colors ${settings.hardwareAcceleration ? 'bg-emerald-500' : 'bg-zinc-700'}`}></div>
                      <div className={`absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform ${settings.hardwareAcceleration ? 'transform translate-x-4' : ''}`}></div>
                    </div>
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* NETWORK TAB */}
          {activeTab === 'network' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
              <div className="flex items-center gap-3 border-b border-white/10 pb-4">
                <Wifi className="w-6 h-6 text-blue-400" />
                <h3 className="text-xl font-semibold">Network & Connection</h3>
              </div>

              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-zinc-400 mb-2">Custom User-Agent</label>
                  <textarea 
                    value={settings.userAgent}
                    onChange={(e) => handleChange('userAgent', e.target.value)}
                    rows={2}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-3 text-white focus:ring-2 focus:ring-blue-500 focus:outline-none font-mono text-xs"
                    placeholder="Enter custom User-Agent string..."
                  />
                  <p className="text-xs text-zinc-500 mt-2">Some IPTV providers require specific User-Agent strings to allow connections.</p>
                </div>

                <div className="grid md:grid-cols-2 gap-6">
                  <div>
                    <label className="block text-sm font-medium text-zinc-400 mb-2">Connection Timeout (Seconds)</label>
                    <input 
                      type="number" 
                      min="5" 
                      max="60"
                      value={settings.timeoutDuration}
                      onChange={(e) => handleChange('timeoutDuration', e.target.value)}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-3 text-white focus:ring-2 focus:ring-blue-500 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-zinc-400 mb-2">Max Auto-Retries</label>
                    <select 
                      value={settings.retryCount}
                      onChange={(e) => handleChange('retryCount', e.target.value)}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-3 text-white focus:ring-2 focus:ring-blue-500 focus:outline-none"
                    >
                      <option value="0">Disabled</option>
                      <option value="1">1 Retry</option>
                      <option value="3">3 Retries (Default)</option>
                      <option value="5">5 Retries</option>
                      <option value="10">10 Retries</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ADVANCED TAB */}
          {activeTab === 'advanced' && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
              <div className="flex items-center gap-3 border-b border-white/10 pb-4">
                <Cpu className="w-6 h-6 text-amber-400" />
                <h3 className="text-xl font-semibold">Advanced Engine Settings</h3>
              </div>
              
              <div className="bg-amber-950/20 border border-amber-900/30 rounded-xl p-4 mb-6">
                <p className="text-sm text-amber-200/80">
                  <strong className="text-amber-400">Warning:</strong> These settings directly affect the underlying video decoding engines (mpegts.js / hls.js). 
                  Modifying them may cause playback instability or increased memory usage.
                </p>
              </div>

              <div className="grid md:grid-cols-2 gap-8">
                <div className="space-y-6">
                  <label className="flex items-center justify-between cursor-pointer bg-zinc-950 p-4 rounded-xl border border-zinc-800/50 hover:border-zinc-700 transition-colors">
                    <div>
                      <span className="block text-sm font-medium text-zinc-200">Live Buffer Latency Chasing</span>
                      <span className="block text-xs text-zinc-500 mt-1">Automatically drop frames to catch up to live edge</span>
                    </div>
                    <div className="relative">
                      <input 
                        type="checkbox" 
                        className="sr-only" 
                        checked={settings.liveBufferLatencyChasing}
                        onChange={(e) => handleChange('liveBufferLatencyChasing', e.target.checked)}
                      />
                      <div className={`block w-10 h-6 rounded-full transition-colors ${settings.liveBufferLatencyChasing ? 'bg-amber-500' : 'bg-zinc-700'}`}></div>
                      <div className={`absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform ${settings.liveBufferLatencyChasing ? 'transform translate-x-4' : ''}`}></div>
                    </div>
                  </label>

                  <div>
                    <label className="block text-sm font-medium text-zinc-400 mb-2">Max Buffer Length (Seconds)</label>
                    <input 
                      type="number" 
                      min="10" 
                      max="600"
                      value={settings.maxBufferLength}
                      onChange={(e) => handleChange('maxBufferLength', e.target.value)}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-3 text-white focus:ring-2 focus:ring-amber-500 focus:outline-none"
                    />
                    <p className="text-xs text-zinc-500 mt-2">Maximum amount of video data to keep in memory.</p>
                  </div>
                </div>

                <div className="space-y-6">
                  <div>
                    <label className="block text-sm font-medium text-zinc-400 mb-2">Seek Type</label>
                    <select 
                      value={settings.seekType}
                      onChange={(e) => handleChange('seekType', e.target.value)}
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-3 text-white focus:ring-2 focus:ring-amber-500 focus:outline-none"
                    >
                      <option value="range">Range (HTTP Range Requests)</option>
                      <option value="param">Param (Query Parameters)</option>
                      <option value="custom">Custom</option>
                    </select>
                  </div>

                  <label className="flex items-center justify-between cursor-pointer bg-zinc-950 p-4 rounded-xl border border-zinc-800/50 hover:border-zinc-700 transition-colors">
                    <div>
                      <span className="block text-sm font-medium text-zinc-200">Debug Mode</span>
                      <span className="block text-xs text-zinc-500 mt-1">Output verbose player logs to console</span>
                    </div>
                    <div className="relative">
                      <input 
                        type="checkbox" 
                        className="sr-only" 
                        checked={settings.debugMode}
                        onChange={(e) => handleChange('debugMode', e.target.checked)}
                      />
                      <div className={`block w-10 h-6 rounded-full transition-colors ${settings.debugMode ? 'bg-amber-500' : 'bg-zinc-700'}`}></div>
                      <div className={`absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform ${settings.debugMode ? 'transform translate-x-4' : ''}`}></div>
                    </div>
                  </label>
                </div>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
