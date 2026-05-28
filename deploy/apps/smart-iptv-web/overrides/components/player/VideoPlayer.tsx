/* Copyright Alen Pepa */
'use client';

import React, { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { AlertCircle, Loader2, Signal, Play, Pause, Volume2, VolumeX, Maximize, Minimize, Settings, ChevronUp, ChevronDown, PictureInPicture, Info, Keyboard, Activity, X } from 'lucide-react';
import { EPGData, EPGProgram } from '@/lib/iptv';

interface VideoPlayerProps {
  url: string;
  poster?: string;
  autoPlay?: boolean;
  channelName?: string;
  onNextChannel?: () => void;
  onPrevChannel?: () => void;
  onClose?: () => void;
  onMinimize?: () => void;
  onPlaybackFailure?: (message: string) => void;
  epgData?: EPGData | null;
  channelId?: string;
}

interface StreamStats {
  resolution?: string;
  bitrate?: string;
  fps?: number;
  codec?: string;
}

export default function VideoPlayer({ 
  url, 
  poster, 
  autoPlay = true, 
  channelName, 
  onNextChannel, 
  onPrevChannel, 
  onClose,
  onMinimize,
  onPlaybackFailure,
  epgData, 
  channelId 
}: VideoPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [buffering, setBuffering] = useState(false);
  const [stats, setStats] = useState<StreamStats | null>(null);
  const [showStats, setShowStats] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [isPiP, setIsPiP] = useState(false);

  // EPG State
  const [currentProgram, setCurrentProgram] = useState<EPGProgram | null>(null);
  const [nextProgram, setNextProgram] = useState<EPGProgram | null>(null);
  const [epgProgress, setEpgProgress] = useState(0);

  useEffect(() => {
    if (!epgData || !channelId) {
      setCurrentProgram(null);
      setNextProgram(null);
      return;
    }

    const updateEPG = () => {
      const now = new Date().getTime();
      const channelPrograms = epgData.programs.filter(p => p.channel === channelId);
      
      // Sort by start time
      channelPrograms.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

      let current = null;
      let next = null;

      for (let i = 0; i < channelPrograms.length; i++) {
        const p = channelPrograms[i];
        const start = new Date(p.start).getTime();
        const stop = new Date(p.stop).getTime();

        if (now >= start && now < stop) {
          current = p;
          if (i + 1 < channelPrograms.length) {
            next = channelPrograms[i + 1];
          }
          break;
        }
      }

      setCurrentProgram(current);
      setNextProgram(next);

      if (current) {
        const start = new Date(current.start).getTime();
        const stop = new Date(current.stop).getTime();
        const duration = stop - start;
        const elapsed = now - start;
        setEpgProgress(Math.min(100, Math.max(0, (elapsed / duration) * 100)));
      }
    };

    updateEPG();
    const interval = setInterval(updateEPG, 60000); // Update every minute
    return () => clearInterval(interval);
  }, [epgData, channelId]);

  const formatEpgTime = (timeString: string) => {
    return new Date(timeString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // Custom controls state
  const [isPlaying, setIsPlaying] = useState(autoPlay);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [retryCount, setRetryCount] = useState(0);
  const maxRetries = 3;
  const retryTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const [useProxy, setUseProxy] = useState(false);

  // HLS specific state
  const [hlsLevels, setHlsLevels] = useState<any[]>([]);
  const [currentLevel, setCurrentLevel] = useState<number>(-1);
  const hlsRef = useRef<Hls | null>(null);

  const readNumberSetting = (key: string, fallback: number, min: number, max: number) => {
    if (typeof window === 'undefined') return fallback;
    const raw = localStorage.getItem(`iptv_setting_${key}`);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  };

  const readBooleanSetting = (key: string, fallback: boolean) => {
    if (typeof window === 'undefined') return fallback;
    const raw = localStorage.getItem(`iptv_setting_${key}`);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return fallback;
  };

  useEffect(() => {
    setRetryCount(0);
    setError(null);
    setLoading(true);
    setBuffering(false);
  }, [url]);

  useEffect(() => {
    let hls: Hls | null = null;
    let mpegtsPlayer: any = null; // Type as any to avoid import issues
    let statsInterval: any = null;
    let startupTimeout: NodeJS.Timeout | null = null;
    let stallTimeout: NodeJS.Timeout | null = null;
    let skipTimeout: NodeJS.Timeout | null = null;
    let lastPlaybackTime = 0;
    const video = videoRef.current;

    if (!video) return;

    const clearStartupTimeout = () => {
      if (startupTimeout) {
        clearTimeout(startupTimeout);
        startupTimeout = null;
      }
    };

    const clearStallTimeout = () => {
      if (stallTimeout) {
        clearTimeout(stallTimeout);
        stallTimeout = null;
      }
    };

    const failPlayback = (message: string, skipNext = false) => {
      clearStartupTimeout();
      clearStallTimeout();
      setLoading(false);
      setBuffering(false);
      setIsPlaying(false);
      setError(message);
      onPlaybackFailure?.(message);
      if (skipNext && onNextChannel) {
        skipTimeout = setTimeout(() => onNextChannel(), 1800);
      }
    };

    const retryOrFail = (message: string, skipNext = false) => {
      if (retryCount < maxRetries) {
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
        retryTimerRef.current = setTimeout(() => handleRetry(), 1500);
        return;
      }
      failPlayback(message, skipNext);
    };

    const scheduleStartupTimeout = () => {
      clearStartupTimeout();
      startupTimeout = setTimeout(() => {
        retryOrFail('Stream did not start in time. Skipping this channel if another one is available.', true);
      }, 25000);
    };

    const scheduleStallTimeout = () => {
      clearStallTimeout();
      const observedTime = video.currentTime;
      stallTimeout = setTimeout(() => {
        const moved = Math.abs(video.currentTime - observedTime) > 0.25;
        if (!moved && !video.paused && !video.ended) {
          retryOrFail('Stream stalled and did not recover. Skipping this channel if another one is available.', true);
        }
      }, 18000);
    };

    // Native buffering listeners
    const onWaiting = () => {
      setBuffering(true);
      scheduleStallTimeout();
    };
    const onPlaying = () => {
      clearStartupTimeout();
      clearStallTimeout();
      setLoading(false);
      setBuffering(false);
      setIsPlaying(true);
      setRetryCount(0);
    };
    const onPause = () => setIsPlaying(false);
    const onTimeUpdate = () => {
      if (video.currentTime !== lastPlaybackTime) {
        lastPlaybackTime = video.currentTime;
        clearStartupTimeout();
        clearStallTimeout();
        setLoading(false);
        setBuffering(false);
      }
    };

    const initPlayer = async () => {
      setLoading(true);
      setBuffering(false);
      setError(null);
      setStats(null);
      scheduleStartupTimeout();
      video.preload = 'auto';

      const maxBufferLengthSeconds = readNumberSetting('maxBufferLength', 300, 30, 600);
      const maxBufferSizeMb = readNumberSetting('bufferSize', 256, 32, 768);
      const liveLatencyChasing = readBooleanSetting('liveBufferLatencyChasing', false);
      const seekTypeSetting = localStorage.getItem('iptv_setting_seekType') || 'range';

      // Determine stream type
      let checkUrl = url;
      
      // Auto-proxy for mixed content or if forced
      const isMixedContent = checkUrl.startsWith('http://') && window.location.protocol === 'https:';
      if (isMixedContent || useProxy) {
        checkUrl = `/api/stream-proxy?url=${encodeURIComponent(url)}`;
      }

      const playbackUrl = checkUrl.startsWith('/')
        ? new URL(checkUrl, window.location.origin).toString()
        : checkUrl;
      const playbackUrlDetails = new URL(playbackUrl, window.location.origin);
      const streamExt = (playbackUrlDetails.searchParams.get('ext') || '').toLowerCase();

      const cleanUrl = playbackUrl.split('?')[0].toLowerCase();
      
      const isProviderVaultHls = playbackUrlDetails.pathname.includes('/api/provider-vault/aac-hls');
      const isHls = isProviderVaultHls || cleanUrl.endsWith('.m3u8') || streamExt === 'm3u8' || playbackUrl.includes('output=m3u8') || playbackUrl.includes('m3u8');
      const isDash = cleanUrl.endsWith('.mpd');
      const nativeExts = ['mp4', 'webm', 'ogg', 'mov', 'mkv', 'mp3', 'aac'];
      const mpegTsExts = ['ts', 'mpg', 'mpeg', 'm2ts', 'flv'];
      const isNative = nativeExts.some(ext => cleanUrl.endsWith(`.${ext}`)) || nativeExts.includes(streamExt);
      const isMpegTs = !isProviderVaultHls && (mpegTsExts.some(ext => cleanUrl.endsWith(`.${ext}`)) || mpegTsExts.includes(streamExt) || playbackUrl.includes('output=ts'));
      
      // If not HLS and not explicitly Native, and not DASH, assume MPEG-TS/FLV (common for IPTV)
      const shouldTryMpegTs = !isProviderVaultHls && (isMpegTs || (!isHls && !isNative && !isDash));

      video.addEventListener('waiting', onWaiting);
      video.addEventListener('stalled', onWaiting);
      video.addEventListener('playing', onPlaying);
      video.addEventListener('canplay', onPlaying);
      video.addEventListener('loadeddata', onPlaying);
      video.addEventListener('pause', onPause);
      video.addEventListener('timeupdate', onTimeUpdate);

      const initFallbackPlayer = () => {
        // Default to HLS or Native
        if (Hls.isSupported() && (isHls || (!video.canPlayType('application/vnd.apple.mpegurl') && !isNative))) {
          hls = new Hls({
            enableWorker: true,
            lowLatencyMode: false,
            backBufferLength: maxBufferLengthSeconds,
            maxBufferLength: maxBufferLengthSeconds,
            maxMaxBufferLength: Math.max(600, maxBufferLengthSeconds),
            maxBufferSize: maxBufferSizeMb * 1024 * 1024,
            liveSyncDurationCount: 8,
            liveMaxLatencyDurationCount: 16,
          });
          
          hlsRef.current = hls;

          hls.loadSource(playbackUrl);
          hls.attachMedia(video);

          hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
            setLoading(false);
            setRetryCount(0); // Reset retry on success
            
            if (data.levels && data.levels.length > 0) {
              setHlsLevels(data.levels);
            }
            
            // Apply saved quality preference
            const savedQuality = localStorage.getItem('stream_quality') || 'auto';
            if (savedQuality !== 'auto' && data.levels && data.levels.length > 0) {
              // Sort levels by resolution/bitrate (highest to lowest)
              const sortedLevels = [...data.levels].map((level, index) => ({...level, originalIndex: index})).sort((a, b) => b.height - a.height);
              
              let selectedIndex = -1;
              if (savedQuality === 'high') {
                selectedIndex = sortedLevels[0].originalIndex; // Highest
              } else if (savedQuality === 'medium') {
                selectedIndex = sortedLevels[Math.floor(sortedLevels.length / 2)].originalIndex; // Middle
              } else if (savedQuality === 'low') {
                selectedIndex = sortedLevels[sortedLevels.length - 1].originalIndex; // Lowest
              }
              
              if (selectedIndex !== -1 && hls) {
                hls.currentLevel = selectedIndex;
                setCurrentLevel(selectedIndex);
              }
            }

            // Initial stats
            if (data.levels && data.levels.length > 0) {
               const level = data.levels[hls && hls.currentLevel !== -1 ? hls.currentLevel : 0];
               setStats({
                 resolution: `${level.width}x${level.height}`,
                 bitrate: `${Math.round(level.bitrate / 1000)} kbps`
               });
            }
            if (autoPlay) {
              const playPromise = video.play();
              if (playPromise !== undefined) {
                playPromise.catch((e) => console.log('Autoplay blocked or interrupted', e));
              }
            }
          });

          hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
             setCurrentLevel(data.level);
             const level = hls?.levels[data.level];
             if (level) {
               setStats({
                 resolution: `${level.width}x${level.height}`,
                 bitrate: `${Math.round(level.bitrate / 1000)} kbps`
               });
             }
          });

          hls.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
              setLoading(false);
              switch (data.type) {
                case Hls.ErrorTypes.NETWORK_ERROR:
                  console.warn('Network error encountered', data.type, data.details);
                  let netErrorMsg = 'Network error encountered.';
                  if (data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR) {
                    netErrorMsg = 'Failed to load stream manifest. The URL might be invalid or blocked by CORS.';
                  } else if (data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT) {
                    netErrorMsg = 'Stream manifest load timed out. The server might be down or slow.';
                  } else if (data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR) {
                    netErrorMsg = 'Failed to parse stream manifest. The format might be invalid.';
                  } else {
                    netErrorMsg = `Network error: ${data.details}`;
                  }
                  
                  if (retryCount < maxRetries) {
                    console.log(`Retrying HLS playback (${retryCount + 1}/${maxRetries})...`);
                    retryOrFail(netErrorMsg, true);
                  } else {
                    failPlayback(netErrorMsg, true);
                    hls?.destroy();
                  }
                  break;
                case Hls.ErrorTypes.MEDIA_ERROR:
                  console.warn('Media error encountered', data.type, data.details);
                  hls?.recoverMediaError();
                  break;
                default:
                  console.warn('Unrecoverable error', data.type, data.details);
                  failPlayback(`Stream error: ${data.details}`, true);
                  hls?.destroy();
                  break;
              }
            }
          });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          // Native HLS support (Safari)
          video.src = playbackUrl;
          video.addEventListener('loadedmetadata', () => {
            setLoading(false);
            setRetryCount(0); // Reset retry on success
            setStats({
               resolution: `${video.videoWidth}x${video.videoHeight}`,
               bitrate: 'Auto'
            });
            if (autoPlay) {
              const playPromise = video.play();
              if (playPromise !== undefined) {
                playPromise.catch((e) => console.log('Autoplay blocked or interrupted', e));
              }
            }
          });
          video.addEventListener('resize', () => {
             setStats(prev => ({
               ...prev,
               resolution: `${video.videoWidth}x${video.videoHeight}`
             }));
          });
          video.addEventListener('error', () => {
             const err = video.error;
             console.warn('Native playback error', err?.code, err?.message);
             let msg = 'Native playback error';
             if (err) {
               switch (err.code) {
                 case 1: msg = 'Playback aborted by user.'; break;
                 case 2: msg = 'Network error occurred while fetching media.'; break;
                 case 3: msg = 'Media decoding failed. The stream might be corrupted or unsupported.'; break;
                 case 4: msg = 'Media format not supported or stream URL is invalid.'; break;
                 default: msg = `Unknown native playback error (Code: ${err.code})`; break;
               }
               if (err.message) msg += ` - ${err.message}`;
             }
             failPlayback(msg, true);
          });
        } else {
          // Fallback for direct MP4/WebM or if HLS not supported and not Safari
          video.src = playbackUrl;
          video.addEventListener('loadedmetadata', () => {
             setLoading(false);
             setStats({
                resolution: `${video.videoWidth}x${video.videoHeight}`,
                codec: 'Native'
             });
             if (autoPlay) {
               const playPromise = video.play();
               if (playPromise !== undefined) {
                 playPromise.catch((e) => console.log('Autoplay blocked or interrupted', e));
               }
             }
          });
          video.addEventListener('error', (e) => {
             const err = video.error;
             console.warn('Native Video Error', err?.code, err?.message);
             let msg = 'Format not supported or stream failed.';
             if (err) {
               switch (err.code) {
                 case 1: msg = 'Playback aborted by user.'; break;
                 case 2: msg = 'Network error occurred while fetching media.'; break;
                 case 3: msg = 'Media decoding failed. The stream might be corrupted or unsupported.'; break;
                 case 4: msg = 'Media format not supported or stream URL is invalid.'; break;
                 default: msg = `Unknown native playback error (Code: ${err.code})`; break;
               }
               if (err.message) msg += ` - ${err.message}`;
             }
             failPlayback(msg, true);
          });
        }
      };

      if (shouldTryMpegTs) {
        try {
          // Dynamically import mpegts.js to avoid SSR issues
          const mpegts = (await import('mpegts.js')).default;
          
          if (mpegts.getFeatureList().mseLivePlayback) {
            const createAndPlay = () => {
              mpegtsPlayer = mpegts.createPlayer({
                type: cleanUrl.endsWith('.flv') ? 'flv' : 'mpegts',
                url: playbackUrl,
                isLive: true,
                cors: true,
              }, {
                enableWorker: true,
                enableStashBuffer: true,
                lazyLoadMaxDuration: maxBufferLengthSeconds,
                seekType: seekTypeSetting === 'param' || seekTypeSetting === 'custom' ? seekTypeSetting : 'range',
                liveBufferLatencyChasing: liveLatencyChasing,
                stashInitialSize: Math.min(2048, Math.max(384, maxBufferSizeMb * 4)),
                autoCleanupSourceBuffer: true,
                autoCleanupMaxBackwardDuration: maxBufferLengthSeconds,
                autoCleanupMinBackwardDuration: Math.min(120, Math.floor(maxBufferLengthSeconds / 2)),
                statisticsInfoReportInterval: 86400000, // Disable internal stats reporter to prevent currentURL error
              });
              mpegtsPlayer.attachMediaElement(video);
              mpegtsPlayer.load();
              if (autoPlay) {
                const playPromise = mpegtsPlayer.play();
                if (playPromise !== undefined) {
                  playPromise.catch((e: any) => console.log('Autoplay blocked or interrupted', e));
                }
              }
              
              // MPEG-TS Statistics
              if (statsInterval) clearInterval(statsInterval);
              statsInterval = setInterval(() => {
                 try {
                   if (mpegtsPlayer && mpegtsPlayer._emitter) { // Check if it's not destroyed
                     const info = mpegtsPlayer.statisticsInfo;
                     if (info) {
                       setStats({
                         resolution: `${info.videoWidth || video.videoWidth}x${info.videoHeight || video.videoHeight}`,
                         bitrate: info.speed ? `${Math.round(info.speed * 8)} kbps` : undefined, // Approximate current speed
                         fps: info.fps ? Math.round(info.fps) : undefined
                       });
                     }
                   } else {
                     clearInterval(statsInterval);
                   }
                 } catch (e) {
                   // Ignore errors if player is destroyed during interval
                   clearInterval(statsInterval);
                 }
              }, 1000);

              mpegtsPlayer.on(mpegts.Events.ERROR, (type: any, details: any, data: any) => {
                 clearInterval(statsInterval);
                 console.warn('MpegTS event:', type, details);
                 
                 let errorMessage = `Stream Error: ${details}`;
                 if (details === 'HttpStatusCodeInvalid') {
                    errorMessage = 'Server returned an invalid status code (e.g. 403 or 404). Check your credentials.';
                 } else if (details === 'NetworkException') {
                    errorMessage = 'Network connection failed. The server might be unreachable.';
                 } else if (details === 'Exception') {
                    errorMessage = 'An internal player exception occurred.';
                 }

                 if (retryCount < maxRetries) {
                    console.log(`MpegTS stream interrupted, attempting to reconnect... (Attempt ${retryCount + 1}/${maxRetries})`);
                    if (mpegtsPlayer) {
                      try {
                        mpegtsPlayer.pause();
                        mpegtsPlayer.unload();
                        mpegtsPlayer.detachMediaElement();
                        mpegtsPlayer.destroy();
                      } catch (e) {
                        // Ignore destroy errors
                      }
                      mpegtsPlayer = null;
                    }
                    retryOrFail(errorMessage, true);
                    return;
                 } else {
                    console.log('Max retries reached, falling back to HLS/Native.');
                    if (mpegtsPlayer) {
                      try {
                        mpegtsPlayer.pause();
                        mpegtsPlayer.unload();
                        mpegtsPlayer.detachMediaElement();
                        mpegtsPlayer.destroy();
                      } catch (e) {}
                      mpegtsPlayer = null;
                    }
                    failPlayback(errorMessage, true);
                    return;
                 }
              });
            };
            
            createAndPlay();
            
            return;
          }
        } catch (e) {
          console.warn('Failed to load mpegts.js', e);
        }
      }

      initFallbackPlayer();
    };

    initPlayer();

    return () => {
      if (statsInterval) clearInterval(statsInterval);
      clearStartupTimeout();
      clearStallTimeout();
      if (skipTimeout) clearTimeout(skipTimeout);
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('stalled', onWaiting);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('canplay', onPlaying);
      video.removeEventListener('loadeddata', onPlaying);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('timeupdate', onTimeUpdate);

      if (hls) {
        hls.destroy();
        hlsRef.current = null;
      }
      if (mpegtsPlayer) {
        try {
          mpegtsPlayer.pause();
          mpegtsPlayer.unload();
          mpegtsPlayer.detachMediaElement();
          mpegtsPlayer.destroy();
        } catch (e) {
          // Ignore destroy errors
        }
        mpegtsPlayer = null;
      }
    };
  }, [autoPlay, url, useProxy, retryCount, onNextChannel, onPlaybackFailure]); // Depend on autoPlay, url, useProxy, retryCount

  const handleRetry = () => {
    setError(null);
    setLoading(true);
    setRetryCount(prev => prev + 1);
  };

  // Custom controls handlers
  const togglePlay = () => {
    if (videoRef.current) {
      if (videoRef.current.paused) {
        const playPromise = videoRef.current.play();
        if (playPromise !== undefined) {
          playPromise.catch((e) => console.log('Play blocked or interrupted', e));
        }
      } else {
        videoRef.current.pause();
      }
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
    if (videoRef.current) {
      videoRef.current.volume = newVolume;
      videoRef.current.muted = newVolume === 0;
    }
    setIsMuted(newVolume === 0);
  };

  const toggleMute = () => {
    if (videoRef.current) {
      const newMuted = !isMuted;
      videoRef.current.muted = newMuted;
      setIsMuted(newMuted);
      if (newMuted) {
        setVolume(0);
      } else {
        setVolume(1);
        videoRef.current.volume = 1;
      }
    }
  };

  const changePlaybackRate = () => {
    const rates = [0.5, 1, 1.25, 1.5, 2];
    const currentIndex = rates.indexOf(playbackRate);
    const nextRate = rates[(currentIndex + 1) % rates.length];
    setPlaybackRate(nextRate);
    if (videoRef.current) {
      videoRef.current.playbackRate = nextRate;
    }
  };

  const toggleFullscreen = async () => {
    if (!containerRef.current) return;

    if (!document.fullscreenElement) {
      try {
        await containerRef.current.requestFullscreen();
      } catch (err) {
        console.warn("Error attempting to enable fullscreen:", err);
      }
    } else {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      }
    }
  };

  const togglePiP = async () => {
    if (!videoRef.current) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        setIsPiP(false);
      } else if (videoRef.current.requestPictureInPicture) {
        await videoRef.current.requestPictureInPicture();
        setIsPiP(true);
      }
    } catch (error) {
      console.warn("PiP Error:", error);
    }
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    
    const onEnterPiP = () => setIsPiP(true);
    const onLeavePiP = () => setIsPiP(false);
    
    video.addEventListener('enterpictureinpicture', onEnterPiP);
    video.addEventListener('leavepictureinpicture', onLeavePiP);
    
    return () => {
      video.removeEventListener('enterpictureinpicture', onEnterPiP);
      video.removeEventListener('leavepictureinpicture', onLeavePiP);
    };
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const handleMouseMove = () => {
    setShowControls(true);
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    controlsTimeoutRef.current = setTimeout(() => {
      if (isPlaying) {
        setShowControls(false);
      }
    }, 3000);
  };

  const handleMouseLeave = () => {
    if (isPlaying) {
      setShowControls(false);
    }
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTimeUpdate = () => setCurrentTime(video.currentTime);
    const onDurationChange = () => setDuration(video.duration);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('durationchange', onDurationChange);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('durationchange', onDurationChange);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in an input
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') {
        return;
      }

      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          if (onNextChannel) onNextChannel();
          break;
        case 'ArrowDown':
          e.preventDefault();
          if (onPrevChannel) onPrevChannel();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          setVolume(prev => Math.max(0, prev - 0.1));
          setIsMuted(false);
          break;
        case 'ArrowRight':
          e.preventDefault();
          setVolume(prev => Math.min(1, prev + 0.1));
          setIsMuted(false);
          break;
        case 's':
        case 'S':
          e.preventDefault();
          setShowStats(prev => !prev);
          break;
        case 'p':
        case 'P':
          e.preventDefault();
          togglePiP();
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          toggleFullscreen();
          break;
        case ' ':
          e.preventDefault();
          togglePlay();
          break;
        case 'm':
        case 'M':
          e.preventDefault();
          toggleMute();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onNextChannel, onPrevChannel, isPlaying, isMuted, volume]);

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    setCurrentTime(time);
    if (videoRef.current) {
      videoRef.current.currentTime = time;
    }
  };

  const formatDuration = (time: number) => {
    if (isNaN(time) || !isFinite(time)) return '00:00';
    const h = Math.floor(time / 3600);
    const m = Math.floor((time % 3600) / 60);
    const s = Math.floor(time % 60);
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const isLive = !isFinite(duration) || duration === 0;

  return (
    <div 
      ref={containerRef}
      className="relative w-full h-full bg-black flex items-center justify-center overflow-hidden group"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onClick={() => {
        if (showSettingsMenu) {
          setShowSettingsMenu(false);
        } else {
          togglePlay();
        }
      }}
    >
      {/* Top Controls (Close/Minimize) */}
      <div className={`absolute top-0 left-0 right-0 p-4 flex items-center justify-between z-40 transition-opacity duration-300 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <div className="flex items-center gap-3">
          {channelName && (
            <div className="bg-black/40 backdrop-blur-md border border-white/10 px-3 py-1.5 rounded-full flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <span className="text-xs font-bold text-white uppercase tracking-wider">{channelName}</span>
            </div>
          )}
        </div>
        
        <div className="flex items-center gap-2">
          {onMinimize && (
            <button 
              onClick={(e) => { e.stopPropagation(); onMinimize(); }}
              className="p-2 bg-black/40 hover:bg-white/10 backdrop-blur-md border border-white/10 rounded-full text-white transition-all"
              title="Minimize"
            >
              <PictureInPicture className="w-5 h-5" />
            </button>
          )}
          {onClose && (
            <button 
              onClick={(e) => { e.stopPropagation(); onClose(); }}
              className="p-2 bg-black/40 hover:bg-red-500/80 backdrop-blur-md border border-white/10 rounded-full text-white transition-all"
              title="Close"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {/* Loading / Buffering Indicator */}
      {(loading || buffering) && !error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center z-20 bg-black/50 backdrop-blur-sm pointer-events-none">
          <Loader2 className="w-12 h-12 text-indigo-500 animate-spin mb-2" />
          <p className="text-white font-medium text-sm animate-pulse">
            {loading ? 'Connecting...' : 'Buffering...'}
          </p>
        </div>
      )}
      
      {/* Stream Stats Overlay */}
      {!loading && !error && stats && showStats && (
        <div className="absolute top-4 left-4 z-40 bg-zinc-900/90 backdrop-blur-xl p-4 rounded-xl border border-white/10 flex flex-col gap-3 opacity-95 hover:opacity-100 transition-all duration-300 pointer-events-auto shadow-2xl shadow-black/50 min-w-[220px]">
          <div className="flex items-center justify-between border-bottom border-white/5 pb-2 mb-1">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-indigo-400" />
              <span className="text-xs font-bold text-white uppercase tracking-widest">Stats for Nerds</span>
            </div>
            <button onClick={() => setShowStats(false)} className="text-zinc-500 hover:text-white">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-1 gap-2.5">
            <div className="flex items-center justify-between gap-4">
              <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">Resolution</span>
              <span className="text-xs font-mono text-white bg-white/5 px-1.5 py-0.5 rounded">{stats.resolution || 'Unknown'}</span>
            </div>
            
            <div className="flex items-center justify-between gap-4">
              <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">Bitrate</span>
              <span className="text-xs font-mono text-indigo-400">{stats.bitrate || 'Auto'}</span>
            </div>

            {stats.fps && (
              <div className="flex items-center justify-between gap-4">
                <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">Frame Rate</span>
                <span className="text-xs font-mono text-emerald-400">{stats.fps} FPS</span>
              </div>
            )}

            <div className="flex items-center justify-between gap-4">
              <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">Speed</span>
              <span className="text-xs font-mono text-amber-400">{playbackRate}x</span>
            </div>

            {stats.codec && (
              <div className="flex items-center justify-between gap-4">
                <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">Codec</span>
                <span className="text-[10px] font-mono text-zinc-300 truncate max-w-[120px]">{stats.codec}</span>
              </div>
            )}

            <div className="flex items-center justify-between gap-4">
              <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">Format</span>
              <span className="text-[10px] font-mono text-zinc-400 uppercase">
                {url.split('?')[0].split('.').pop() || 'Stream'}
              </span>
            </div>
          </div>
        </div>
      )}
      
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center z-20 bg-black/90 text-white p-6 text-center backdrop-blur-md">
          <div className="w-16 h-16 bg-red-500/20 rounded-full flex items-center justify-center mb-4 border border-red-500/30">
            <AlertCircle className="w-8 h-8 text-red-500" />
          </div>
          <h3 className="text-lg font-bold mb-2">Playback Error</h3>
          <p className="text-sm text-zinc-400 mb-6 max-w-md">{error}</p>
          <div className="flex gap-3">
            <button 
              onClick={(e) => { e.stopPropagation(); handleRetry(); }}
              className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 rounded-full text-sm font-semibold transition-all shadow-lg shadow-indigo-500/20 flex items-center gap-2"
            >
              <Activity className="w-4 h-4" />
              Try Again {retryCount > 0 && `(${retryCount}/${maxRetries})`}
            </button>
            {onClose && (
              <button 
                onClick={(e) => { e.stopPropagation(); onClose(); }}
                className="px-6 py-2.5 bg-white/10 hover:bg-white/20 rounded-full text-sm font-semibold transition-all"
              >
                Close Player
              </button>
            )}
          </div>
        </div>
      )}

      <video
        ref={videoRef}
        className="w-full h-full object-contain"
        poster={poster}
        playsInline
        crossOrigin="anonymous"
      />

      {/* Custom Controls */}
      <div 
        className={`absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent px-4 py-6 transition-opacity duration-300 z-30 ${
          showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Channel Info Overlay */}
        {channelName && (
          <div className="absolute bottom-full left-4 mb-6 pointer-events-none w-full max-w-2xl">
            <h2 className="text-3xl font-bold text-white drop-shadow-lg">{channelName}</h2>
            {isLive && (
              <div className="flex items-center gap-2 mt-2 mb-4">
                <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                <span className="text-sm font-medium text-red-400 uppercase tracking-wider drop-shadow-md">Live Broadcast</span>
              </div>
            )}
            
            {/* EPG Timeline */}
            {isLive && (currentProgram || nextProgram) && (
              <div className="bg-black/60 backdrop-blur-md border border-white/10 rounded-xl p-4 mt-2 shadow-2xl pointer-events-auto">
                <div className="flex items-center justify-between text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
                  <span>Now Playing</span>
                  <span>Up Next</span>
                </div>
                
                <div className="relative h-1.5 bg-zinc-800 rounded-full mb-4 overflow-hidden">
                  <div 
                    className="absolute top-0 left-0 h-full bg-indigo-500 transition-all duration-1000" 
                    style={{ width: `${epgProgress}%` }}
                  />
                </div>
                
                <div className="flex justify-between items-start gap-4">
                  <div className="flex-1">
                    <div className="text-sm font-medium text-white line-clamp-1">
                      {currentProgram ? currentProgram.title[0]?.value : 'Unknown Program'}
                      {currentProgram?.episodeNum?.[0]?.value && (
                        <span className="ml-2 text-xs text-indigo-400 font-mono">
                          (Ep: {currentProgram.episodeNum[0].value})
                        </span>
                      )}
                    </div>
                    {currentProgram && (
                      <>
                        <div className="text-xs text-zinc-400 mt-1">
                          {formatEpgTime(currentProgram.start)} - {formatEpgTime(currentProgram.stop)}
                          {currentProgram.rating?.[0]?.value && (
                            <span className="ml-2 px-1.5 py-0.5 bg-white/10 rounded text-[10px] uppercase">
                              {currentProgram.rating[0].value}
                            </span>
                          )}
                        </div>
                        {currentProgram.desc?.[0]?.value && (
                          <div className="text-xs text-zinc-500 mt-2 line-clamp-2">
                            {currentProgram.desc[0].value}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  <div className="w-px h-12 bg-white/10" />
                  <div className="flex-1 text-right">
                    <div className="text-sm font-medium text-zinc-300 line-clamp-1">
                      {nextProgram ? nextProgram.title[0]?.value : 'No Data'}
                      {nextProgram?.episodeNum?.[0]?.value && (
                        <span className="ml-2 text-xs text-indigo-400/70 font-mono">
                          (Ep: {nextProgram.episodeNum[0].value})
                        </span>
                      )}
                    </div>
                    {nextProgram && (
                      <div className="text-xs text-zinc-500 mt-1">
                        {formatEpgTime(nextProgram.start)} - {formatEpgTime(nextProgram.stop)}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Channel Surfing Controls */}
        {(onNextChannel || onPrevChannel) && (
          <div className="absolute right-4 bottom-full mb-6 flex flex-col gap-2">
            {onNextChannel && (
              <button 
                onClick={(e) => { e.stopPropagation(); onNextChannel(); }}
                className="p-3 bg-black/60 hover:bg-indigo-600 backdrop-blur-md rounded-full text-white transition-all transform hover:scale-110 shadow-lg border border-white/10"
                title="Next Channel"
              >
                <ChevronUp className="w-6 h-6" />
              </button>
            )}
            {onPrevChannel && (
              <button 
                onClick={(e) => { e.stopPropagation(); onPrevChannel(); }}
                className="p-3 bg-black/60 hover:bg-indigo-600 backdrop-blur-md rounded-full text-white transition-all transform hover:scale-110 shadow-lg border border-white/10"
                title="Previous Channel"
              >
                <ChevronDown className="w-6 h-6" />
              </button>
            )}
          </div>
        )}
        {/* Progress Bar */}
        {!isLive && (
          <div className="flex items-center gap-3 mb-4">
            <span className="text-xs text-white font-mono">{formatDuration(currentTime)}</span>
            <input
              type="range"
              min="0"
              max={duration || 100}
              value={currentTime}
              onChange={handleSeek}
              className="flex-1 h-1.5 bg-white/20 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-indigo-500 [&::-webkit-slider-thumb]:rounded-full"
            />
            <span className="text-xs text-white/70 font-mono">{formatDuration(duration)}</span>
          </div>
        )}

        {/* Controls Row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button 
              onClick={togglePlay}
              className="text-white hover:text-indigo-400 transition-colors focus:outline-none"
            >
              {isPlaying ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6" />}
            </button>

            <div className="flex items-center gap-2 group/volume">
              <button 
                onClick={toggleMute}
                className="text-white hover:text-indigo-400 transition-colors focus:outline-none"
              >
                {isMuted || volume === 0 ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
              </button>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={isMuted ? 0 : volume}
                onChange={handleVolumeChange}
                className="w-0 opacity-0 group-hover/volume:w-20 group-hover/volume:opacity-100 transition-all duration-300 h-1.5 bg-white/20 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full origin-left"
              />
            </div>

            {isLive && (
              <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-red-500/20 border border-red-500/30">
                <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                <span className="text-[10px] font-bold text-red-500 uppercase tracking-wider">Live</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-4 relative">
            {/* Settings Menu */}
            {showSettingsMenu && (
              <div className="absolute bottom-full right-0 mb-4 bg-zinc-900/95 backdrop-blur-md border border-white/10 rounded-lg p-2 min-w-[180px] shadow-xl z-50 max-h-[60vh] overflow-y-auto scrollbar-hide">
                {/* Playback Speed */}
                <div className="mb-4">
                  <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2 px-2">Playback Speed</div>
                  {[0.5, 0.75, 1, 1.25, 1.5, 2].map(rate => (
                    <button
                      key={rate}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPlaybackRate(rate);
                        if (videoRef.current) videoRef.current.playbackRate = rate;
                        setShowSettingsMenu(false);
                      }}
                      className={`w-full text-left px-2 py-1.5 rounded text-sm transition-colors ${playbackRate === rate ? 'bg-indigo-500/20 text-indigo-400' : 'text-zinc-200 hover:bg-white/10'}`}
                    >
                      {rate === 1 ? 'Normal' : `${rate}x`}
                    </button>
                  ))}
                </div>

                {/* Quality Selection (HLS only) */}
                {hlsLevels.length > 0 && (
                  <div>
                    <div className="w-full h-px bg-white/10 my-2" />
                    <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2 px-2">Quality</div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (hlsRef.current) {
                          hlsRef.current.currentLevel = -1; // Auto
                          setCurrentLevel(-1);
                          localStorage.setItem('stream_quality', 'auto');
                        }
                        setShowSettingsMenu(false);
                      }}
                      className={`w-full text-left px-2 py-1.5 rounded text-sm transition-colors ${currentLevel === -1 ? 'bg-indigo-500/20 text-indigo-400' : 'text-zinc-200 hover:bg-white/10'}`}
                    >
                      Auto
                    </button>
                    {hlsLevels.map((level, index) => (
                      <button
                        key={index}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (hlsRef.current) {
                            hlsRef.current.currentLevel = index;
                            setCurrentLevel(index);
                            
                            // Save preference based on relative position
                            if (index === hlsLevels.length - 1) localStorage.setItem('stream_quality', 'high');
                            else if (index === 0) localStorage.setItem('stream_quality', 'low');
                            else localStorage.setItem('stream_quality', 'medium');
                          }
                          setShowSettingsMenu(false);
                        }}
                        className={`w-full text-left px-2 py-1.5 rounded text-sm transition-colors ${currentLevel === index ? 'bg-indigo-500/20 text-indigo-400' : 'text-zinc-200 hover:bg-white/10'}`}
                      >
                        {level.height}p {level.bitrate ? `(${Math.round(level.bitrate / 1000)} kbps)` : ''}
                      </button>
                    ))}
                  </div>
                )}

                {/* Advanced Options */}
                <div>
                  <div className="w-full h-px bg-white/10 my-2" />
                  <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2 px-2">Advanced</div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowShortcuts(true);
                      setShowSettingsMenu(false);
                    }}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors text-zinc-200 hover:bg-white/10"
                  >
                    <Keyboard className="w-4 h-4" />
                    Keyboard Shortcuts
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowStats(!showStats);
                      setShowSettingsMenu(false);
                    }}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors text-zinc-200 hover:bg-white/10"
                  >
                    <Info className="w-4 h-4" />
                    Stats for Nerds
                  </button>

                  <div className="w-full h-px bg-white/10 my-2" />
                  <div className="px-2 py-2">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Stream Proxy</span>
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          setUseProxy(!useProxy);
                          setShowSettingsMenu(false);
                        }}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${useProxy ? 'bg-indigo-500' : 'bg-zinc-700'}`}
                      >
                        <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${useProxy ? 'translate-x-5' : 'translate-x-1'}`} />
                      </button>
                    </div>
                    <p className="text-[10px] text-zinc-500 leading-tight">Enable if stream fails to load (CORS/Mixed Content fix).</p>
                  </div>
                </div>
              </div>
            )}

            {/* PiP Button */}
            {typeof document !== 'undefined' && document.pictureInPictureEnabled && (
              <button 
                onClick={(e) => {
                  e.stopPropagation();
                  togglePiP();
                }}
                className={`text-white hover:text-indigo-400 transition-colors focus:outline-none ${isPiP ? 'text-indigo-400' : ''}`}
                title="Picture-in-Picture"
              >
                <PictureInPicture className="w-5 h-5" />
              </button>
            )}

            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowSettingsMenu(!showSettingsMenu);
              }}
              className="text-white hover:text-indigo-400 transition-colors focus:outline-none"
              title="Settings"
            >
              <Settings className="w-5 h-5" />
            </button>

            <button 
              onClick={(e) => {
                e.stopPropagation();
                toggleFullscreen();
              }}
              className="text-white hover:text-indigo-400 transition-colors focus:outline-none"
            >
              {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>

      {/* Keyboard Shortcuts Modal */}
      {showShortcuts && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowShortcuts(false)}>
          <div className="bg-zinc-900 border border-white/10 rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                <Keyboard className="w-5 h-5 text-indigo-400" />
                Keyboard Shortcuts
              </h3>
              <button onClick={() => setShowShortcuts(false)} className="text-zinc-400 hover:text-white transition-colors">
                ✕
              </button>
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-zinc-300">Play / Pause</span>
                <kbd className="px-2 py-1 bg-zinc-800 border border-white/10 rounded text-xs font-mono text-zinc-300">Space</kbd>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-300">Fullscreen</span>
                <kbd className="px-2 py-1 bg-zinc-800 border border-white/10 rounded text-xs font-mono text-zinc-300">F</kbd>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-300">Mute / Unmute</span>
                <kbd className="px-2 py-1 bg-zinc-800 border border-white/10 rounded text-xs font-mono text-zinc-300">M</kbd>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-300">Picture-in-Picture</span>
                <kbd className="px-2 py-1 bg-zinc-800 border border-white/10 rounded text-xs font-mono text-zinc-300">P</kbd>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-300">Next Channel</span>
                <kbd className="px-2 py-1 bg-zinc-800 border border-white/10 rounded text-xs font-mono text-zinc-300">↑</kbd>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-300">Previous Channel</span>
                <kbd className="px-2 py-1 bg-zinc-800 border border-white/10 rounded text-xs font-mono text-zinc-300">↓</kbd>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-300">Volume Up / Down</span>
                <kbd className="px-2 py-1 bg-zinc-800 border border-white/10 rounded text-xs font-mono text-zinc-300">← / →</kbd>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-zinc-300">Toggle Stats</span>
                <kbd className="px-2 py-1 bg-zinc-800 border border-white/10 rounded text-xs font-mono text-zinc-300">S</kbd>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
