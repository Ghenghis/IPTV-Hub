'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/app/context/AuthContext';
import VideoPlayer from '@/components/VideoPlayer';

export default function WatchLivePage() {
    const { credentials } = useAuth();
    const params = useParams();
    const router = useRouter();
    const streamId = params.streamId as string;
    const [streamUrl, setStreamUrl] = useState<string | null>(null);
    const [fallbackUrl, setFallbackUrl] = useState<string | undefined>(undefined);

    useEffect(() => {
        if (!credentials || !streamId) return;

        if (credentials.providerId) {
            const provider = encodeURIComponent(credentials.providerId);
            const id = encodeURIComponent(streamId);
            if (credentials.providerId === 'apollo') {
                setStreamUrl(`/api/provider-vault/transcode-hls?provider=${provider}&kind=live&id=${id}&ext=ts`);
                setFallbackUrl(`/api/provider-vault/stream?provider=${provider}&kind=live&id=${id}&ext=ts`);
                return;
            }

            setStreamUrl(`/api/provider-vault/stream?provider=${provider}&kind=live&id=${id}&ext=m3u8`);
            setFallbackUrl(`/api/provider-vault/transcode-hls?provider=${provider}&kind=live&id=${id}&ext=ts`);
            return;
        }

        if (!credentials.hostUrl || !credentials.username || !credentials.password) {
            setStreamUrl(null);
            return;
        }

        const baseUrl = credentials.hostUrl.replace(/\/$/, '');
        const url = `${baseUrl}/${credentials.username}/${credentials.password}/${encodeURIComponent(streamId)}`;
        setStreamUrl(url);
        setFallbackUrl(undefined);
    }, [credentials, streamId]);

    if (!streamUrl) {
        return <div className="min-h-screen bg-black flex items-center justify-center text-white">Preparing stream...</div>;
    }

    return (
        <div className="fixed inset-0 bg-black z-50 flex flex-col">
            {/* Background Blur for atmosphere */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none">
                <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-transparent z-10"></div>
            </div>

            <div className="relative flex-1 flex items-center justify-center">
                <VideoPlayer
                    src={streamUrl}
                    fallbackSrc={fallbackUrl}
                    autoPlay={true}
                    onBack={() => router.back()}
                    enterFullscreen={true}
                />
            </div>
        </div>
    );
}
