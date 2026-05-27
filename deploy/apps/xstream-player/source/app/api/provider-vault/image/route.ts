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

function fallbackLabel(sourceUrl: string) {
    try {
        const parsed = new URL(sourceUrl);
        const tail = parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname;
        return (tail || parsed.hostname || 'TV')
            .replace(/\.[a-z0-9]{2,5}$/i, '')
            .replace(/[^a-z0-9]+/gi, ' ')
            .trim()
            .slice(0, 28) || 'TV';
    } catch {
        return 'TV';
    }
}

function svgFallback(sourceUrl: string) {
    const label = fallbackLabel(sourceUrl)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    const initials = label
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() || '')
        .join('') || 'TV';

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360" role="img" aria-label="${label}">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="#0f172a"/>
      <stop offset="0.55" stop-color="#111827"/>
      <stop offset="1" stop-color="#134e4a"/>
    </linearGradient>
  </defs>
  <rect width="640" height="360" rx="26" fill="url(#bg)"/>
  <rect x="28" y="28" width="584" height="304" rx="22" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="2"/>
  <circle cx="320" cy="150" r="58" fill="rgba(45,212,191,.18)" stroke="rgba(94,234,212,.45)" stroke-width="3"/>
  <text x="320" y="169" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="44" font-weight="800" fill="#e0f2fe">${initials}</text>
  <text x="320" y="244" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="26" font-weight="700" fill="#f8fafc">${label}</text>
  <text x="320" y="279" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="17" fill="#a7f3d0">DaveTV provider artwork</text>
</svg>`;

    return new Response(svg, {
        status: 200,
        headers: {
            'Content-Type': 'image/svg+xml; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
            'X-Content-Type-Options': 'nosniff',
            'X-DaveTV-Image-Fallback': '1',
        },
    });
}

export async function GET(req: NextRequest) {
    const sourceUrl = resolveSourceUrl(req);
    if (!sourceUrl) return new Response('Image unavailable', { status: 404 });

    let upstream: Response;
    try {
        upstream = await fetch(sourceUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 DaveTV Image Proxy' },
            redirect: 'follow',
            signal: AbortSignal.timeout(15_000),
        });
    } catch {
        return svgFallback(sourceUrl);
    }

    if (!upstream.ok || !upstream.body) {
        return svgFallback(sourceUrl);
    }

    const headers = new Headers();
    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    headers.set('Content-Type', contentType);
    headers.set('Cache-Control', 'public, max-age=21600');
    headers.set('X-Content-Type-Options', 'nosniff');

    return new Response(upstream.body, {
        status: upstream.status,
        headers,
    });
}
