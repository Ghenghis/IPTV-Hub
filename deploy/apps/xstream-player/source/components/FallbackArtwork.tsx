'use client';

import { useEffect, useMemo, useState } from 'react';
import { Film, Layers, Tv } from 'lucide-react';

type ArtworkKind = 'live' | 'movie' | 'series';

type Props = {
    src?: string | null;
    title: string;
    kind: ArtworkKind;
    className?: string;
    imageClassName?: string;
};

const PLACEHOLDER_IMAGE_PATTERNS = [
    /imgur\.com\/NMuKr1y/i,
    /NMuKr1y\.png/i,
    /placeholder/i,
    /no[-_ ]?(image|poster|cover|logo)/i,
    /not[-_ ]?found/i,
    /unavailable/i,
];

function cx(...values: Array<string | false | null | undefined>) {
    return values.filter(Boolean).join(' ');
}

function isKnownPlaceholder(src?: string | null) {
    const value = String(src || '');
    return PLACEHOLDER_IMAGE_PATTERNS.some((pattern) => pattern.test(value));
}

function initials(title: string) {
    const cleaned = String(title || 'TV')
        .replace(/^USA\s+/i, '')
        .replace(/\b(UHD|FHD|HD|SD|LHD)\b/gi, '')
        .replace(/[^a-z0-9 ]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const words = cleaned.split(' ').filter(Boolean);
    if (!words.length) return 'TV';
    if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
    return words.slice(0, 3).map((word) => word[0]).join('').toUpperCase();
}

function fallbackLabel(kind: ArtworkKind) {
    if (kind === 'movie') return 'Movie';
    if (kind === 'series') return 'Series';
    return 'Live';
}

export default function FallbackArtwork({
    src,
    title,
    kind,
    className = 'h-full w-full',
    imageClassName = 'h-full w-full object-cover',
}: Props) {
    const [imageFailed, setImageFailed] = useState(false);
    const hasPlaceholderSource = isKnownPlaceholder(src);
    const shortTitle = useMemo(() => initials(title), [title]);
    const showImage = Boolean(src) && !imageFailed && !hasPlaceholderSource;

    useEffect(() => {
        setImageFailed(false);
    }, [src]);

    if (showImage) {
        return (
            <img
                data-artwork-image={kind}
                src={src || ''}
                alt={title}
                className={imageClassName}
                loading="lazy"
                onError={() => setImageFailed(true)}
                onLoad={(event) => {
                    const image = event.currentTarget;
                    const isTiny = image.naturalWidth < 32 || image.naturalHeight < 32;
                    const isImgurMissing = image.naturalWidth === 161 && image.naturalHeight === 81;
                    if (isTiny || isImgurMissing) setImageFailed(true);
                }}
            />
        );
    }

    const Icon = kind === 'series' ? Layers : kind === 'movie' ? Film : Tv;
    const isPoster = kind !== 'live';

    return (
        <div
            data-artwork-fallback={kind}
            className={cx(
                className,
                'relative flex overflow-hidden border border-white/10 bg-gradient-to-br from-zinc-950 via-zinc-900 to-red-950/40 text-white',
                isPoster ? 'items-end justify-start p-4' : 'items-center justify-center',
            )}
            title={title}
        >
            <Icon
                className={cx(
                    'absolute text-white/10',
                    isPoster ? 'right-3 top-3 h-14 w-14' : 'right-1 top-1 h-8 w-8',
                )}
            />
            <div className={cx('relative z-10 font-black tracking-wide', isPoster ? 'text-3xl' : 'text-sm')}>
                {shortTitle}
            </div>
            {isPoster && (
                <div className="absolute bottom-2 left-4 right-4 truncate text-[10px] font-semibold uppercase tracking-wide text-white/45">
                    {fallbackLabel(kind)}
                </div>
            )}
        </div>
    );
}
