import { NextResponse } from 'next/server';
import {
    responseCache,
    CACHE_TTL,
    getCacheKey,
    performPeriodicCleanup,
    fetchWithRetry,
    parseResponse
} from './cache';
import { buildXtreamApiUrl, resolveRequestAccount } from '@/app/lib/server/providerVault';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { action, page, limit, providerId, hostUrl, username, password, ...otherParams } = body;
        const account = await resolveRequestAccount(body);

        // Periodic cache cleanup (every 2 minutes)
        performPeriodicCleanup();

        // ---- PAGINATED MODE ----
        // When page & limit are provided, serve from server-side cache
        if (page !== undefined && limit !== undefined) {
            const cacheKey = getCacheKey(account.id, account.name, action);
            let cached = responseCache.get(cacheKey);

            // If no cache or expired, fetch from upstream first
            if (!cached || Date.now() - cached.timestamp > CACHE_TTL) {
                console.log(`[Proxy] Paginated: Fetching full data for ${action} (cache miss)`);

                const apiUrl = buildXtreamApiUrl(account, action || '', otherParams);

                const response = await fetchWithRetry(apiUrl, action);
                if (!response.ok) {
                    return NextResponse.json(
                        { error: `Upstream error: ${response.statusText}` },
                        { status: response.status }
                    );
                }

                const data = await parseResponse(response);

                if (Array.isArray(data)) {
                    cached = { data, timestamp: Date.now(), total: data.length };
                    responseCache.set(cacheKey, cached);
                    console.log(`[Proxy] Paginated: Cached ${data.length} items for ${action}`);
                } else {
                    // Non-array response, return directly
                    return NextResponse.json(data);
                }
            }

            // Serve the requested page
            const pageNum = Math.max(1, parseInt(page));
            const pageSize = Math.min(5000, Math.max(1, parseInt(limit)));
            const startIdx = (pageNum - 1) * pageSize;
            const endIdx = Math.min(startIdx + pageSize, cached.total);
            const pageData = cached.data.slice(startIdx, endIdx);

            const totalPages = Math.ceil(cached.total / pageSize);

            console.log(`[Proxy] Paginated: ${action} page ${pageNum}/${totalPages} (${pageData.length} items, total: ${cached.total})`);

            return NextResponse.json({
                items: pageData,
                page: pageNum,
                limit: pageSize,
                total: cached.total,
                totalPages,
                hasMore: pageNum < totalPages
            });
        }

        // ---- STANDARD MODE (non-paginated, for categories and small requests) ----
        const apiUrl = buildXtreamApiUrl(account, action || '', otherParams);

        console.log(`[Proxy] Action: ${action || 'profile'} | Provider: ${account.name}`);
        if (Object.keys(otherParams).length > 0) {
            console.log(`[Proxy] Params:`, JSON.stringify(otherParams));
        }

        const response = await fetchWithRetry(apiUrl, action);

        if (!response.ok) {
            return NextResponse.json(
                { error: `Upstream error: ${response.statusText}`, details: response.status === 504 ? 'Gateway Timeout' : undefined },
                { status: response.status }
            );
        }

        const data = await parseResponse(response);
        const count = Array.isArray(data) ? data.length : 'object';
        console.log(`[Proxy] Data: ${count} items/type`);

        return NextResponse.json(data);

    } catch (error: any) {
        console.error('[Proxy] CRITICAL Error:', error);
        return NextResponse.json(
            { error: 'Internal Server Error', details: error.message },
            { status: 500 }
        );
    }
}
