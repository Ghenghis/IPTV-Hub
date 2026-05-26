import { NextRequest } from 'next/server';
import { resolveUrlToken } from '@/app/lib/server/providerVault';

export const dynamic = 'force-dynamic';

function resolveSourceUrl(req: NextRequest) {
    const token = req.nextUrl.searchParams.get('token') || '';
    if (token) return resolveUrlToken(token);

    const src = req.nextUrl.searchParams.get('src') || '';
    if (!src) return null;

    try {
        const parsed = new URL(src);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        if (parsed.username || parsed.password) return null;
        if (/[?&](username|user|password|pass|token|key)=/i.test(parsed.search)) return null;
        return parsed.toString();
    } catch {
        return null;
    }
}

export async function GET(req: NextRequest) {
    const sourceUrl = resolveSourceUrl(req);
    if (!sourceUrl) return new Response('Image unavailable', { status: 404 });

    const upstream = await fetch(sourceUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 DaveTV Image Proxy' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
    });

    if (!upstream.ok || !upstream.body) {
        return new Response('Image request failed', { status: upstream.status || 502 });
    }

    const headers = new Headers();
    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    headers.set('Content-Type', contentType);
    headers.set('Cache-Control', 'public, max-age=21600');

    return new Response(upstream.body, {
        status: upstream.status,
        headers,
    });
}
