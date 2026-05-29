'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '../../../context/AuthContext';
import { useParams } from 'next/navigation';
import Loader from '@/components/Loader';
import { ArrowLeft, Play, Star } from 'lucide-react';
import Link from 'next/link';
import FallbackArtwork from '@/components/FallbackArtwork';

interface Movie {
    stream_id: string | number;
    name: string;
    stream_icon: string;
    rating: string;
    added: string;
    container_extension: string;
    provider_id?: string;
    provider_name?: string;
}

import { useData } from '../../../context/DataContext';
import SortControls, { SortOption } from '@/components/SortControls';
import { useSortPreference } from '@/app/hooks/useSortPreference';
import { useInfiniteScroll } from '@/app/hooks/useInfiniteScroll';
import { useMemo } from 'react';
import { isAllowedCatalogItem, safeImagePath } from '@/app/lib/catalogFilters';
import { categoryProviderContext, cleanDisplayTitle, decodeRouteId, providerLabel, streamIdForStorage } from '@/app/lib/providerMode';

export default function MovieList() {
    const { credentials } = useAuth();
    const { categoryId } = useParams();
    const routeCategoryId = useMemo(() => decodeRouteId(categoryId as string), [categoryId]);
    const { getCachedStreams, getCachedCategories } = useData();

    const [movies, setMovies] = useState<Movie[]>([]);
    const [categoryName, setCategoryName] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [sort, setSort] = useSortPreference('movies', 'added');

    useEffect(() => {
        if (!credentials || !routeCategoryId) return;

        const loadData = async () => {
            try {
                // Fetch category name
                const categories = await getCachedCategories('movie');
                const category = categories.find(c => c.category_id === routeCategoryId);
                if (category) {
                    setCategoryName(category.category_name);
                }

                // Try cache first
                const cached = await getCachedStreams(routeCategoryId, 'movie');
                if (cached && cached.length > 0) {
                    setMovies(cached.map(s => ({
                        stream_id: s.id,
                        name: s.name,
                        stream_icon: s.icon || '',
                        rating: s.rating || '',
                        added: s.added || '',
                        container_extension: s.container_extension || '',
                        provider_id: s.provider_id,
                        provider_name: s.provider_name,
                    })));
                    setLoading(false);
                    return;
                }

                // Fallback to fetch
                const providerContext = categoryProviderContext(credentials, routeCategoryId);
                const res = await fetch('/api/proxy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        ...credentials,
                        ...(providerContext.providerId ? { providerId: providerContext.providerId } : {}),
                        action: 'get_vod_streams',
                        category_id: providerContext.rawCategoryId
                    })
                });

                const data = await res.json();
                if (Array.isArray(data)) {
                    setMovies(data
                        .filter((movie) => isAllowedCatalogItem(movie, 'movie'))
                        .map((movie) => ({
                            ...movie,
                            stream_id: streamIdForStorage(movie.stream_id, 'movie', providerContext.providerId || undefined, providerContext.combinedMode),
                            name: cleanDisplayTitle(movie.name || ''),
                            category_id: routeCategoryId,
                            provider_id: providerContext.providerId || undefined,
                            provider_name: providerContext.providerId ? providerLabel(providerContext.providerId) : undefined,
                            stream_icon: safeImagePath(movie.stream_icon || movie.cover) || '',
                        })));
                } else {
                    setMovies([]);
                }
            } catch (err) {
                setError('Failed to fetch movies');
            } finally {
                setLoading(false);
            }
        };

        loadData();
    }, [credentials, routeCategoryId, getCachedStreams, getCachedCategories]);

    const sortedMovies = useMemo(() => {
        return [...movies].sort((a, b) => {
            if (sort === 'name-asc') return a.name.localeCompare(b.name);
            if (sort === 'name-desc') return b.name.localeCompare(a.name);
            if (sort === 'added') return new Date(b.added || 0).getTime() - new Date(a.added || 0).getTime();
            if (sort === 'year') {
                const yearA = parseInt(a.name.match(/\d{4}/)?.[0] || '0');
                const yearB = parseInt(b.name.match(/\d{4}/)?.[0] || '0');
                return yearB - yearA;
            }
            return 0;
        });
    }, [movies, sort]);

    const { visibleItems, hasMore, sentinelRef } = useInfiniteScroll(sortedMovies);

    if (loading) return <Loader />;

    return (
        <div className="space-y-6 p-4 md:p-6 lg:p-10">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <Link
                    href="/dashboard/movies"
                    data-focusable="true"
                    tabIndex={0}
                    className="inline-flex items-center gap-2 text-gray-400 hover:text-white transition-colors focus:outline-none focus:text-blue-500 focus:scale-110 origin-left"
                >
                    <ArrowLeft size={20} />
                    Back to Categories
                </Link>
                <SortControls currentSort={sort} onSortChange={setSort} showYear />
            </div>

            <div className="space-y-4">
                <h3 className="text-xl font-bold text-white flex items-center gap-2">
                    <span className="w-2 h-8 bg-blue-600 rounded-full"></span>
                    {categoryName || 'Movies'} ({movies.length})
                </h3>

                {movies.length === 0 && !error ? (
                    <p className="text-gray-500">No movies found in this category.</p>
                ) : (
                    <>
                        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
                            {(visibleItems as Movie[]).map((movie) => (
                                <Link
                                    key={movie.stream_id}
                                    href={`/dashboard/watch/movie/${movie.stream_id}`}
                                    data-focusable="true"
                                    tabIndex={0}
                                    className="group relative bg-[#1f1f1f] rounded-xl overflow-hidden shadow-lg hover:shadow-2xl hover:shadow-blue-900/20 transition-all duration-300 transform hover:-translate-y-1 focus:outline-none focus:ring-4 focus:ring-blue-600 focus:scale-105 z-10"
                                >
                                    <div className="aspect-[2/3] relative overflow-hidden bg-black">
                                        <FallbackArtwork
                                            src={movie.stream_icon}
                                            title={movie.name}
                                            kind="movie"
                                            imageClassName="h-full w-full object-cover transition-transform duration-500 group-hover:scale-110"
                                        />

                                        {/* Overlay */}
                                        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center justify-center">
                                            <div className="bg-white/20  p-4 rounded-full text-white border border-white/30">
                                                <Play fill="currentColor" size={24} className="ml-1" />
                                            </div>
                                        </div>

                                        {movie.rating && (
                                            <div className="absolute top-2 right-2 bg-black/60 backdrop- px-2 py-1 rounded text-xs font-bold text-yellow-500 flex items-center gap-1">
                                                <Star size={10} fill="currentColor" /> {movie.rating}
                                            </div>
                                        )}
                                    </div>

                                    <div className="p-4">
                                        <h4 className="font-semibold text-gray-200 group-hover:text-white line-clamp-2 text-base mb-1" title={movie.name}>
                                            {movie.name}
                                        </h4>
                                        <div className="flex justify-between items-center text-xs text-gray-500">
                                            <span className="uppercase">{movie.container_extension}</span>
                                            <span>ID: {movie.stream_id}</span>
                                        </div>
                                        {movie.provider_name && (
                                            <div className="mt-2 text-[10px] font-semibold uppercase tracking-wide text-blue-300/80">
                                                {movie.provider_name}
                                            </div>
                                        )}
                                    </div>
                                </Link>
                            ))}
                        </div>
                        {hasMore && (
                            <div ref={sentinelRef} className="h-20 flex items-center justify-center p-4">
                                <Loader size="small" />
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
