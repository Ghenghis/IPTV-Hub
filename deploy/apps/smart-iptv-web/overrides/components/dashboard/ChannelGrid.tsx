/* Copyright Alen Pepa */
import React, { useMemo, useState, useEffect } from 'react';
import { Channel, EPGData, EPGProgram } from '@/lib/iptv';
import { Play, Star, Info, Globe, Search, LayoutGrid, List as ListIcon, GripVertical, X, Clock } from 'lucide-react';
import { getValidImageUrl } from '@/lib/utils';
import Image from 'next/image';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, rectSortingStrategy, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface ChannelGridProps {
  channels: Channel[];
  onSelectChannel: (channel: Channel) => void;
  onShowDetails: (channel: Channel) => void;
  selectedChannel: Channel | null;
  searchQuery: string;
  activeCategory: string;
  onCategoryChange?: (category: string) => void;
  favorites?: Channel[];
  onToggleFavorite?: (channel: Channel) => void;
  epgData?: EPGData | null;
  activeTab?: string;
}

const COUNTRY_MAP: Record<string, string> = {
  'FR': 'France', 'GR': 'Greece', 'IT': 'Italy', 'UK': 'United Kingdom', 'GB': 'United Kingdom', 'US': 'United States', 'USA': 'United States',
  'ES': 'Spain', 'DE': 'Germany', 'PT': 'Portugal', 'NL': 'Netherlands', 'BE': 'Belgium',
  'CH': 'Switzerland', 'AT': 'Austria', 'SE': 'Sweden', 'NO': 'Norway', 'DK': 'Denmark',
  'FI': 'Finland', 'PL': 'Poland', 'RO': 'Romania', 'BG': 'Bulgaria', 'RU': 'Russia',
  'TR': 'Turkey', 'AR': 'Arabic', 'AL': 'Albania', 'BR': 'Brazil', 'MX': 'Mexico',
  'CA': 'Canada', 'AU': 'Australia', 'NZ': 'New Zealand', 'IN': 'India', 'ZA': 'South Africa',
  'IE': 'Ireland', 'IL': 'Israel', 'HU': 'Hungary', 'CZ': 'Czech Republic', 'SK': 'Slovakia',
  'RS': 'Serbia', 'HR': 'Croatia', 'BA': 'Bosnia and Herzegovina', 'MK': 'North Macedonia', 'SI': 'Slovenia',
  'LT': 'Lithuania', 'LV': 'Latvia', 'EE': 'Estonia', 'UA': 'Ukraine', 'BY': 'Belarus',
  'KZ': 'Kazakhstan', 'CN': 'China', 'JP': 'Japan', 'KR': 'Korea', 'TW': 'Taiwan',
  'VN': 'Vietnam', 'TH': 'Thailand', 'PH': 'Philippines', 'ID': 'Indonesia', 'MY': 'Malaysia',
  'SG': 'Singapore', 'SA': 'Saudi Arabia', 'AE': 'UAE', 'EG': 'Egypt', 'MA': 'Morocco',
  'DZ': 'Algeria', 'TN': 'Tunisia', 'CO': 'Colombia', 'CL': 'Chile', 'PE': 'Peru',
  'VE': 'Venezuela', 'ARAB': 'Arabic', 'EX-YU': 'Ex-Yugoslavia', 'LATINO': 'Latino',
  'AD': 'Andorra', 'AZ': 'Azerbaijan', 'TD': 'Chad', 'CR': 'Costa Rica', 'CY': 'Cyprus', 
  'DO': 'Dominican Republic', 'FO': 'Faroe Islands', 'GE': 'Georgia', 'GL': 'Greenland', 
  'HK': 'Hong Kong', 'IS': 'Iceland', 'IR': 'Iran', 'IQ': 'Iraq', 'LU': 'Luxembourg', 
  'MO': 'Macau', 'MD': 'Moldova', 'MC': 'Monaco', 'ME': 'Montenegro',
  'AFRICA': 'Africa', 'ASIA': 'Asia', 'EUROPE': 'Europe', 'VIP': 'VIP', '24/7': '24/7',
  'KIDS': 'Kids', 'SPORTS': 'Sports', 'NEWS': 'News', 'MUSIC': 'Music', 'DOCUMENTARY': 'Documentary',
  'MOVIES': 'Movies', 'CINEMA': 'Cinema', 'ENTERTAINMENT': 'Entertainment', 'RELIGION': 'Religion',
  'ADULT': 'Adult', 'XXX': 'Adult', 'RADIO': 'Radio', 'TEST': 'Test', 'LOCAL': 'Local',
  'DOCUMENTARIES': 'Documentary', 'KID': 'Kids', 'ANIMATION': 'Kids', 'CARTOONS': 'Kids'
};

const CATEGORY_ICONS: Record<string, string> = {
  'All': '📺',
  'Favorites': '⭐',
  'Recently Played': '🕒',
  'France': '🇫🇷',
  'Greece': '🇬🇷',
  'Italy': '🇮🇹',
  'United Kingdom': '🇬🇧',
  'United States': '🇺🇸',
  'Spain': '🇪🇸',
  'Germany': '🇩🇪',
  'Portugal': '🇵🇹',
  'Netherlands': '🇳🇱',
  'Belgium': '🇧🇪',
  'Switzerland': '🇨🇭',
  'Austria': '🇦🇹',
  'Sweden': '🇸🇪',
  'Norway': '🇳🇴',
  'Denmark': '🇩🇰',
  'Finland': '🇫🇮',
  'Poland': '🇵🇱',
  'Romania': '🇷🇴',
  'Bulgaria': '🇧🇬',
  'Russia': '🇷🇺',
  'Turkey': '🇹🇷',
  'Arabic': '🇸🇦',
  'Albania': '🇦🇱',
  'Brazil': '🇧🇷',
  'Mexico': '🇲🇽',
  'Canada': '🇨🇦',
  'Australia': '🇦🇺',
  'New Zealand': '🇳🇿',
  'India': '🇮🇳',
  'South Africa': '🇿🇦',
  'Ireland': '🇮🇪',
  'Israel': '🇮🇱',
  'Hungary': '🇭🇺',
  'Czech Republic': '🇨🇿',
  'Slovakia': '🇸🇰',
  'Serbia': '🇷🇸',
  'Croatia': '🇭🇷',
  'Bosnia': '🇧🇦',
  'North Macedonia': '🇲🇰',
  'Slovenia': '🇸🇮',
  'Lithuania': '🇱🇹',
  'Latvia': '🇱🇻',
  'Estonia': '🇪🇪',
  'Ukraine': '🇺🇦',
  'Belarus': '🇧🇾',
  'Kazakhstan': '🇰🇿',
  'China': '🇨🇳',
  'Japan': '🇯🇵',
  'South Korea': '🇰🇷',
  'Taiwan': '🇹🇼',
  'Vietnam': '🇻🇳',
  'Thailand': '🇹🇭',
  'Philippines': '🇵🇭',
  'Indonesia': '🇮🇩',
  'Malaysia': '🇲🇾',
  'Singapore': '🇸🇬',
  'Saudi Arabia': '🇸🇦',
  'UAE': '🇦🇪',
  'Egypt': '🇪🇬',
  'Morocco': '🇲🇦',
  'Algeria': '🇩🇿',
  'Tunisia': '🇹🇳',
  'Colombia': '🇨🇴',
  'Chile': '🇨🇱',
  'Peru': '🇵🇪',
  'Venezuela': '🇻🇪',
  'Ex-Yugoslavia': '🇽🇺',
  'Latino': '🌎',
  'Africa': '🌍',
  'Asia': '🌏',
  'Europe': '🇪🇺',
  'VIP': '💎',
  '24/7': '🔄',
  'Kids': '🧸',
  'Sports': '⚽',
  'News': '📰',
  'Music': '🎵',
  'Documentary': '📜',
  'Movies': '🎬',
  'Cinema': '🎬',
  'Entertainment': '🎭',
  'Religion': '⛪',
  'Adult': '🔞',
  'Radio': '📻',
  'Test': '🧪'
};

function stripProviderPrefix(value: string) {
  return value.replace(/^(Apollo Group TV|XtremeHD|Combined Tagged)\s*\/\s*/i, '').trim();
}

function getCountryFromGroup(group: string, channelName?: string): string {
  const normalizedGroup = stripProviderPrefix(group || '');
  const upperGroup = normalizedGroup.toUpperCase().trim();
  const upperName = (channelName || '').toUpperCase().trim();
  
  // Generic groups that should be ignored in favor of channel name prefixes
  const genericGroups = ['LIVE TV', 'ALL CHANNELS', 'IPTV', 'TV', 'CHANNELS', 'GENERAL', 'OTHER', 'LIVE', 'ALL', 'DEFAULT'];
  
  const isGeneric = genericGroups.includes(upperGroup) || !upperGroup;

  // 1. Check for common prefixes like "UK |", "US:", "[FR]", etc. in group or name
  const checkPrefix = (text: string) => {
    const prefixMatch = text.match(/^([A-Z]{2,3})[\s\-|:\]]/);
    if (prefixMatch) {
      const code = prefixMatch[1];
      if (COUNTRY_MAP[code]) return COUNTRY_MAP[code];
    }
    return null;
  };

  let country = checkPrefix(upperGroup);
  if (country) return country;

  // If group is generic, prioritize channel name prefix
  if (isGeneric) {
    country = checkPrefix(upperName);
    if (country) return country;
  }

  // 2. Check if the group name itself is a country code or name
  if (COUNTRY_MAP[upperGroup]) return COUNTRY_MAP[upperGroup];
  
  // 3. Split by common delimiters and check each part
  const parts = upperGroup.split(/[\s\-|:()\[\]]+/).filter(Boolean);
  for (const part of parts) {
    if (COUNTRY_MAP[part]) return COUNTRY_MAP[part];
  }

  // 4. Check if any country name is contained in the group name
  for (const [code, name] of Object.entries(COUNTRY_MAP)) {
    if (upperGroup.includes(name.toUpperCase())) return name;
  }

  // 5. If group is generic, try to find country in channel name
  if (isGeneric) {
    for (const [code, name] of Object.entries(COUNTRY_MAP)) {
      if (upperName.includes(name.toUpperCase())) return name;
    }
  }

  // 6. If no match, return the original group name (cleaned up)
  if (!isGeneric) {
    let cleaned = normalizedGroup.split(/[:|-]/)[0].trim();
    if (cleaned.toUpperCase() === 'LIVE' || cleaned.toUpperCase() === 'TV' || cleaned.toUpperCase() === 'CHANNELS') {
      cleaned = normalizedGroup.split(/[:|-]/)[1]?.trim() || cleaned;
    }
    return cleaned || 'Other';
  }
  
  return 'Other';
}

function getChannelNumber(channel: Channel): string | null {
  if (channel.tvg?.chno) return channel.tvg.chno;
  // Try to extract tvg-chno from the raw string if it's not parsed by the library
  if (channel.raw) {
    const match = channel.raw.match(/tvg-chno="([^"]+)"/);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

export default function ChannelGrid({ channels, onSelectChannel, onShowDetails, selectedChannel, searchQuery, activeCategory, onCategoryChange, favorites = [], onToggleFavorite, epgData, activeTab = 'live' }: ChannelGridProps) {
  const [gridSearchQuery, setGridSearchQuery] = useState('');
  const [categorySearchQuery, setCategorySearchQuery] = useState('');
  const [isBouquetSidebarOpen, setIsBouquetSidebarOpen] = useState(false);
  const [recentlyPlayed, setRecentlyPlayed] = useState<Channel[]>([]);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [now, setNow] = useState(new Date().getTime());
  const [customOrders, setCustomOrders] = useState<Record<string, string[]>>({});

  useEffect(() => {
    const savedView = localStorage.getItem('channel_view_mode');
    if (savedView === 'grid' || savedView === 'list') {
      setTimeout(() => setViewMode(savedView), 0);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('channel_view_mode', viewMode);
  }, [viewMode]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5, // 5px movement required before drag starts
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  useEffect(() => {
    const savedOrders = localStorage.getItem('channel_custom_orders');
    if (savedOrders) {
      try {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setCustomOrders(JSON.parse(savedOrders));
      } catch (e) {
        console.error('Failed to load custom orders', e);
      }
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date().getTime()), 60000);
    return () => clearInterval(interval);
  }, []);

  const getCurrentProgram = (channelId: string) => {
    if (!epgData) return null;
    const channelPrograms = epgData.programs.filter(p => p.channel === channelId);
    return channelPrograms.find(p => {
      const start = new Date(p.start).getTime();
      const stop = new Date(p.stop).getTime();
      return now >= start && now < stop;
    });
  };

  useEffect(() => {
    const saved = localStorage.getItem('recently_played');
    if (saved) {
      try {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setRecentlyPlayed(JSON.parse(saved));
      } catch (e) {
        console.error('Failed to load recently played', e);
      }
    }
  }, []);

  const handleSelectChannel = (channel: Channel) => {
    setRecentlyPlayed(prev => {
      const filtered = prev.filter(c => c.url !== channel.url);
      const updated = [channel, ...filtered].slice(0, 5);
      localStorage.setItem('recently_played', JSON.stringify(updated));
      return updated;
    });
    onSelectChannel(channel);
  };
  
  // Extract countries to use as categories
  const bouquetCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    channels.forEach(c => {
      const country = getCountryFromGroup(c.group?.title || '', c.name);
      counts[country] = (counts[country] || 0) + 1;
    });
    return counts;
  }, [channels]);

  const categories = useMemo(() => {
    const catSet = new Set<string>();
    Object.keys(bouquetCounts).forEach(cat => catSet.add(cat));
    const sortedCats = Array.from(catSet).sort();
    return ['All', 'Favorites', 'Recently Played', ...sortedCats];
  }, [bouquetCounts]);

  const REVERSE_COUNTRY_MAP = useMemo(() => {
    const map: Record<string, string> = {};
    Object.entries(COUNTRY_MAP).forEach(([code, name]) => {
      if (code.length === 2) {
        map[name] = code.toLowerCase();
      }
    });
    return map;
  }, []);

  const bouquetList = useMemo(() => {
    return Object.entries(bouquetCounts)
      .map(([name, count]) => ({ 
        name, 
        count,
        code: REVERSE_COUNTRY_MAP[name] || null
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [bouquetCounts, REVERSE_COUNTRY_MAP]);

  // Filter channels based on search and category (country)
  const filteredChannels = useMemo(() => {
    let baseChannels = channels;
    if (activeCategory === 'Favorites') {
      baseChannels = favorites;
    } else if (activeCategory === 'Recently Played') {
      baseChannels = recentlyPlayed;
    }

    const filtered = baseChannels.filter(channel => {
      const group = channel.group?.title || '';
      const name = channel.name || '';
      const country = getCountryFromGroup(group, name);
      
      const matchesGlobalSearch = name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                            group.toLowerCase().includes(searchQuery.toLowerCase());
                            
      const matchesGridSearch = name.toLowerCase().includes(gridSearchQuery.toLowerCase());
      
      let matchesCategory = true;
      if (activeCategory !== 'All' && activeCategory !== 'Favorites' && activeCategory !== 'Recently Played') {
        matchesCategory = country === activeCategory;
      }

      return matchesGlobalSearch && matchesGridSearch && matchesCategory;
    });

    // Apply custom ordering if no search query is active
    if (!searchQuery && !gridSearchQuery) {
      const orderKey = `${activeTab}_${activeCategory}`;
      const savedOrder = customOrders[orderKey];
      
      if (savedOrder && savedOrder.length > 0) {
        // Create a map for O(1) lookups
        const orderMap = new Map(savedOrder.map((url, index) => [url, index]));
        
        filtered.sort((a, b) => {
          const aIndex = orderMap.get(a.url);
          const bIndex = orderMap.get(b.url);
          
          if (aIndex !== undefined && bIndex !== undefined) {
            return aIndex - bIndex;
          }
          if (aIndex !== undefined) return -1;
          if (bIndex !== undefined) return 1;
          return 0; // Keep original order for new channels
        });
      }
    }

    return filtered;
  }, [channels, favorites, recentlyPlayed, activeCategory, searchQuery, gridSearchQuery, customOrders, activeTab]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    
    if (over && active.id !== over.id) {
      const oldIndex = filteredChannels.findIndex(c => c.url === active.id);
      const newIndex = filteredChannels.findIndex(c => c.url === over.id);
      
      if (oldIndex !== -1 && newIndex !== -1) {
        const newChannels = arrayMove(filteredChannels, oldIndex, newIndex);
        const newOrder = newChannels.map(c => c.url);
        
        const orderKey = `${activeTab}_${activeCategory}`;
        const updatedOrders = {
          ...customOrders,
          [orderKey]: newOrder
        };
        
        setCustomOrders(updatedOrders);
        localStorage.setItem('channel_custom_orders', JSON.stringify(updatedOrders));
      }
    }
  };

  // Filter categories based on category search
  const filteredCategories = useMemo(() => {
    if (!categorySearchQuery) return categories;
    return categories.filter(cat => 
      cat.toLowerCase().includes(categorySearchQuery.toLowerCase())
    );
  }, [categories, categorySearchQuery]);

  return (
    <div className="flex flex-col md:flex-row h-full overflow-hidden relative">
      {/* Bouquet Sidebar (Countries) - Only for Live TV or if many categories */}
      {activeTab === 'live' && categories.length > 5 && (
        <div className={`
          fixed inset-y-0 left-0 z-40 w-72 bg-zinc-950 border-r border-white/5 flex flex-col shrink-0 overflow-hidden transition-transform duration-300 md:relative md:translate-x-0 md:w-64 md:bg-zinc-900/30
          ${isBouquetSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
        `}>
          <div className="p-4 border-b border-white/5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Globe className="w-4 h-4 text-indigo-400" />
              <h3 className="font-bold text-sm uppercase tracking-wider text-zinc-400">Bouquets</h3>
            </div>
            <button 
              onClick={() => setIsBouquetSidebarOpen(false)}
              className="md:hidden p-2 text-zinc-500 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="p-4 border-b border-white/5">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
              <input 
                type="text"
                placeholder="Search countries..."
                value={categorySearchQuery}
                onChange={(e) => setCategorySearchQuery(e.target.value)}
                className="w-full bg-black/40 border border-white/5 rounded-lg pl-9 pr-3 py-2 text-xs text-white placeholder-zinc-600 focus:outline-none focus:border-indigo-500/50 transition-all"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1 scrollbar-thin scrollbar-thumb-zinc-800">
            {filteredCategories.map((cat) => (
              <button
                key={cat}
                onClick={() => {
                  onCategoryChange?.(cat);
                  if (window.innerWidth < 768) setIsBouquetSidebarOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                  activeCategory === cat 
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' 
                    : 'text-zinc-400 hover:text-white hover:bg-white/5'
                }`}
              >
                <span className="text-lg leading-none shrink-0">
                  {CATEGORY_ICONS[cat] || '📁'}
                </span>
                <span className="truncate">{cat}</span>
                {activeCategory === cat && (
                  <div className="ml-auto w-1.5 h-1.5 rounded-full bg-white" />
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Mobile Sidebar Overlay */}
      {isBouquetSidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-30 md:hidden"
          onClick={() => setIsBouquetSidebarOpen(false)}
        />
      )}

      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="p-6 space-y-6 overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-800">
          {/* Filters */}
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 flex-1">
                {/* Mobile Bouquet Toggle */}
                {activeTab === 'live' && categories.length > 5 && (
                  <button 
                    onClick={() => setIsBouquetSidebarOpen(true)}
                    className="md:hidden p-2.5 bg-zinc-900 border border-white/5 rounded-xl text-zinc-400 hover:text-white"
                  >
                    <Globe className="w-5 h-5" />
                  </button>
                )}
                
                {/* Local Search Bar */}
                <div className="relative w-full max-w-md">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                  <input 
                    type="text"
                    placeholder={`Search ${activeCategory === 'All' ? 'all' : activeCategory} channels...`}
                    value={gridSearchQuery}
                    onChange={(e) => setGridSearchQuery(e.target.value)}
                    className="w-full bg-zinc-900/50 border border-white/5 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/50 transition-all"
                  />
                </div>
              </div>

              {/* View Toggle */}
              <div className="flex items-center bg-zinc-900/50 border border-white/5 rounded-lg p-1">
                <button
                  onClick={() => setViewMode('grid')}
                  className={`p-2 rounded-md transition-colors ${viewMode === 'grid' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
                  title="Grid View"
                >
                  <LayoutGrid className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setViewMode('list')}
                  className={`p-2 rounded-md transition-colors ${viewMode === 'list' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
                  title="List View"
                >
                  <ListIcon className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Horizontal Categories (Only if NOT showing sidebar or for Movies/Series) */}
            {(activeTab !== 'live' || categories.length <= 5) && categories.length > 1 && (
              <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
                <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900 rounded-lg text-zinc-400 text-sm border border-white/5 shrink-0">
                  <Globe className="w-4 h-4" />
                  <span>Categories:</span>
                </div>
                {categories.map((cat) => (
                  <button
                    key={cat}
                    onClick={() => onCategoryChange?.(cat)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-all shrink-0 flex items-center gap-2 ${
                      activeCategory === cat 
                        ? 'bg-indigo-600 text-white shadow-md shadow-indigo-500/20' 
                        : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-white border border-white/5'
                    }`}
                  >
                    {CATEGORY_ICONS[cat] && (
                      <span className="text-base leading-none">{CATEGORY_ICONS[cat]}</span>
                    )}
                    <span>{cat}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Grid / List */}
          {activeTab === 'live' && activeCategory === 'All' && !gridSearchQuery && !searchQuery ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
              {bouquetList.map((bouquet) => (
                <button
                  key={bouquet.name}
                  onClick={() => onCategoryChange?.(bouquet.name)}
                  className="flex items-center gap-3 p-3 bg-[#2a2a2a] hover:bg-[#3a3a3a] border border-white/5 rounded-md transition-all group text-left shadow-sm"
                >
                  <div className="w-10 h-10 shrink-0 rounded-full overflow-hidden bg-zinc-800 flex items-center justify-center border border-white/10 group-hover:scale-105 transition-transform">
                    {bouquet.code ? (
                      <Image 
                        src={`https://flagcdn.com/w80/${bouquet.code.toLowerCase()}.png`}
                        alt={bouquet.name}
                        width={40}
                        height={40}
                        unoptimized
                        className="w-full h-full object-cover"
                        referrerPolicy="no-referrer"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                          (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
                        }}
                      />
                    ) : null}
                    <span className={`${bouquet.code ? 'hidden' : ''} text-lg`}>
                      {CATEGORY_ICONS[bouquet.name] || '📁'}
                    </span>
                  </div>
                  <div className="min-w-0 flex items-center gap-1.5">
                    <h3 className="text-[#e0e0e0] font-medium text-sm truncate group-hover:text-white transition-colors">
                      {bouquet.name}
                    </h3>
                    <span className="text-zinc-500 text-sm font-medium shrink-0">
                      ({bouquet.count})
                    </span>
                  </div>
                </button>
              ))}
            </div>
          ) : filteredChannels.length > 0 ? (
            <div className="space-y-4">
              {activeTab === 'live' && activeCategory !== 'All' && !gridSearchQuery && !searchQuery && (
                <button 
                  onClick={() => onCategoryChange?.('All')}
                  className="flex items-center gap-2 text-zinc-400 hover:text-white text-sm font-medium transition-colors mb-4"
                >
                  <X className="w-4 h-4 rotate-45" />
                  Back to Bouquets
                </button>
              )}
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <div className={
                  viewMode === 'grid' 
                    ? "grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4"
                    : "flex flex-col gap-2"
                }>
              <SortableContext
                items={filteredChannels.map(c => c.url)}
                strategy={viewMode === 'grid' ? rectSortingStrategy : verticalListSortingStrategy}
              >
                {filteredChannels.map((channel) => {
                  const isFavorite = favorites.some(f => f.url === channel.url);
                  const country = getCountryFromGroup(channel.group?.title || '');
                  const channelNumber = getChannelNumber(channel);
                  const currentProgram = getCurrentProgram(channel.tvg.id || channel.name);
                  
                  return (
                    <SortableChannelItem
                      key={channel.url}
                      channel={channel}
                      viewMode={viewMode}
                      isFavorite={isFavorite}
                      country={country}
                      channelNumber={channelNumber}
                      currentProgram={currentProgram}
                      selectedChannel={selectedChannel}
                      onSelectChannel={handleSelectChannel}
                      onShowDetails={onShowDetails}
                      onToggleFavorite={onToggleFavorite}
                    />
                  );
                })}
              </SortableContext>
            </div>
          </DndContext>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-20 text-zinc-500">
          <Search className="w-12 h-12 mb-4 opacity-20" />
          <p className="text-lg font-medium">No channels found</p>
          <p className="text-sm">Try adjusting your search or category</p>
          {(gridSearchQuery || searchQuery || activeCategory !== 'All') && (
            <button 
              onClick={() => {
                setGridSearchQuery('');
                onCategoryChange?.('All');
              }}
              className="mt-4 text-indigo-400 hover:text-indigo-300 text-sm font-medium"
            >
              Clear all filters
            </button>
          )}
        </div>
      )}
        </div>
      </div>
    </div>
  );
}

interface SortableChannelItemProps {
  channel: Channel;
  viewMode: 'grid' | 'list';
  isFavorite: boolean;
  country: string;
  channelNumber: string | null;
  currentProgram: EPGProgram | null | undefined;
  selectedChannel: Channel | null;
  onSelectChannel: (channel: Channel) => void;
  onShowDetails: (channel: Channel) => void;
  onToggleFavorite?: (channel: Channel) => void;
}

function SortableChannelItem({
  channel,
  viewMode,
  isFavorite,
  country,
  channelNumber,
  currentProgram,
  selectedChannel,
  onSelectChannel,
  onShowDetails,
  onToggleFavorite
}: SortableChannelItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: channel.url });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : 'auto',
  };

  if (viewMode === 'list') {
    return (
      <div 
        ref={setNodeRef}
        style={style}
        onClick={() => onSelectChannel(channel)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelectChannel(channel);
          }
        }}
        tabIndex={0}
        role="button"
        className={`group flex items-center gap-4 p-3 bg-zinc-900 rounded-xl border transition-all duration-200 cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500 hover:bg-zinc-800 ${
          selectedChannel?.name === channel.name 
            ? 'border-indigo-500 shadow-md shadow-indigo-500/10 bg-indigo-950/20' 
            : 'border-white/5 hover:border-white/10'
        }`}
      >
        <div 
          {...attributes} 
          {...listeners}
          className="cursor-grab active:cursor-grabbing p-2 text-zinc-500 hover:text-white transition-colors"
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="w-5 h-5" />
        </div>
        <div className="w-16 h-12 bg-black/40 rounded-lg flex items-center justify-center overflow-hidden shrink-0">
          {getValidImageUrl(channel.tvg.logo) ? (
            <div className="relative w-full h-full p-1">
              <Image 
                src={getValidImageUrl(channel.tvg.logo)!} 
                alt={channel.name} 
                referrerPolicy="no-referrer"
                unoptimized
                fill
                className="object-contain"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                  (e.target as HTMLImageElement).parentElement?.nextElementSibling?.classList.remove('hidden');
                }}
              />
            </div>
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-zinc-800 text-zinc-500 font-bold text-xs">
              {channel.name.substring(0, 2).toUpperCase()}
            </div>
          )}
          <div className="hidden w-full h-full flex items-center justify-center bg-zinc-800 text-zinc-500 font-bold text-xs">
            {channel.name.substring(0, 2).toUpperCase()}
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {channelNumber && (
              <span className="text-xs font-mono text-zinc-500 bg-black/30 px-1.5 py-0.5 rounded">
                CH {channelNumber}
              </span>
            )}
            <h3 className="font-medium text-white truncate group-hover:text-indigo-400 transition-colors">
              {channel.name}
            </h3>
          </div>
          <p className="text-xs text-zinc-500 truncate mt-1">
            {country} • {channel.group?.title || 'Uncategorized'}
          </p>
          {currentProgram && (
            <p className="text-xs text-indigo-400 truncate mt-1 font-medium">
              Now: {currentProgram.title[0]?.value}
              {currentProgram.episodeNum?.[0]?.value && (
                <span className="ml-1 opacity-70 font-mono">(Ep: {currentProgram.episodeNum[0].value})</span>
              )}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <button 
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite?.(channel);
            }}
            className="p-2 bg-black/40 hover:bg-black/60 rounded-full text-white transition-colors"
            title={isFavorite ? "Remove from Favorites" : "Add to Favorites"}
          >
            <Star className={`w-4 h-4 ${isFavorite ? 'fill-yellow-400 text-yellow-400' : ''}`} />
          </button>
          <button 
            onClick={(e) => {
              e.stopPropagation();
              onShowDetails(channel);
            }}
            className="p-2 bg-black/40 hover:bg-black/60 rounded-full text-white transition-colors"
            title="Channel Info"
          >
            <Info className="w-4 h-4" />
          </button>
          <button 
            onClick={(e) => {
              e.stopPropagation();
              onSelectChannel(channel);
            }}
            className="p-2 bg-indigo-600 hover:bg-indigo-700 rounded-full text-white transition-colors shadow-lg shadow-indigo-500/20"
            title="Play Channel"
          >
            <Play className="w-4 h-4 ml-0.5" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div 
      ref={setNodeRef}
      style={style}
      onClick={() => onSelectChannel(channel)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelectChannel(channel);
        }
      }}
      tabIndex={0}
      role="button"
      className={`group relative aspect-video bg-zinc-900 rounded-xl overflow-hidden border transition-all duration-300 cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500 hover:scale-105 hover:shadow-2xl focus:scale-105 focus:shadow-2xl z-0 hover:z-10 focus:z-10 ${
        selectedChannel?.name === channel.name 
          ? 'border-indigo-500 shadow-lg shadow-indigo-500/20 ring-1 ring-indigo-500' 
          : 'border-white/5 hover:border-white/20'
      }`}
    >
      {/* Drag Handle */}
      <div 
        {...attributes} 
        {...listeners}
        className="absolute top-2 right-2 z-20 p-1.5 bg-black/40 hover:bg-black/60 rounded-md text-zinc-400 hover:text-white opacity-0 group-hover:opacity-100 transition-all cursor-grab active:cursor-grabbing"
        onClick={(e) => e.stopPropagation()}
      >
        <GripVertical className="w-4 h-4" />
      </div>

      {/* Logo / Placeholder */}
      <div className="absolute inset-0 flex items-center justify-center p-4 bg-zinc-900">
        {getValidImageUrl(channel.tvg.logo) ? (
          <Image 
            src={getValidImageUrl(channel.tvg.logo)!} 
            alt={channel.name} 
            referrerPolicy="no-referrer"
            unoptimized
            fill
            className="object-contain opacity-80 group-hover:opacity-100 group-focus:opacity-100 transition-opacity"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
              (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
            }}
          />
        ) : null}
        <span className={`text-2xl font-bold text-zinc-700 ${getValidImageUrl(channel.tvg.logo) ? 'hidden' : ''}`}>
          {channel.name.substring(0, 2).toUpperCase()}
        </span>
      </div>

      {/* Overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/40 to-transparent opacity-0 group-hover:opacity-100 group-focus:opacity-100 focus-within:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-3">
        <div className="transform translate-y-2 group-hover:translate-y-0 group-focus:translate-y-0 transition-transform duration-300">
          <div className="flex items-start justify-between gap-2 mb-1">
            <h3 className="text-white font-bold text-sm truncate leading-tight">
              {channel.name}
            </h3>
            {channelNumber && (
              <span className="shrink-0 text-[10px] font-mono font-bold text-white bg-indigo-600 px-1.5 py-0.5 rounded shadow-sm">
                #{channelNumber}
              </span>
            )}
          </div>
          
          <div className="flex flex-wrap gap-1 mb-2">
            <span className="text-[10px] px-1.5 py-0.5 bg-white/10 text-zinc-300 rounded-md border border-white/5 backdrop-blur-sm">
              {country}
            </span>
            {channel.group?.title && (
              <span className="text-[10px] px-1.5 py-0.5 bg-indigo-500/20 text-indigo-300 rounded-md border border-indigo-500/20 backdrop-blur-sm truncate max-w-[100px]">
                {channel.group.title}
              </span>
            )}
          </div>

          {currentProgram && (
            <div className="mb-2">
              <p className="text-indigo-300 text-[11px] truncate font-medium flex items-center gap-1">
                <span className="w-1 h-1 bg-indigo-400 rounded-full animate-pulse" />
                {currentProgram.title[0]?.value}
              </p>
              {currentProgram.episodeNum?.[0]?.value && (
                <p className="text-zinc-500 text-[10px] font-mono">
                  Ep: {currentProgram.episodeNum[0].value}
                </p>
              )}
            </div>
          )}
          
          <div className="flex items-center justify-between mt-1">
            <div className="flex gap-2">
              <button 
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectChannel(channel);
                }}
                className="p-2 bg-white text-black rounded-full hover:scale-110 transition-transform shadow-lg"
                title="Play"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
              </button>
              <button 
                onClick={(e) => {
                  e.stopPropagation();
                  onShowDetails(channel);
                }}
                className="p-2 bg-zinc-800/80 text-white rounded-full hover:bg-zinc-700 transition-colors backdrop-blur-sm"
                title="Details"
              >
                <Info className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Active Indicator */}
      {selectedChannel?.name === channel.name && (
        <div className="absolute top-2 right-10 w-2 h-2 bg-indigo-500 rounded-full animate-pulse shadow-[0_0_10px_rgba(99,102,241,0.5)]" />
      )}

      {/* Favorite Indicator / Button (Always visible if favorited, or visible on hover) */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite?.(channel);
        }}
        className={`absolute top-2 left-2 p-1.5 rounded-full transition-all focus:outline-none focus:ring-2 focus:ring-yellow-400 z-10 ${
          isFavorite 
            ? 'text-yellow-400 opacity-100 drop-shadow-md bg-black/40 hover:bg-black/60' 
            : 'text-zinc-400 opacity-0 group-hover:opacity-100 hover:text-yellow-400 bg-black/40 hover:bg-black/60'
        }`}
        tabIndex={0}
      >
        <Star className={`w-4 h-4 ${isFavorite ? 'fill-current' : ''}`} />
      </button>
    </div>
  );
}
