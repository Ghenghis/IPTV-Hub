import { NextRequest, NextResponse } from 'next/server';

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function redactUrl(raw: string): string {
  return raw
    .replace(/(username=)[^&]+/gi, '$1***')
    .replace(/(password=)[^&]+/gi, '$1***')
    .replace(/\/(live|movie|series|timeshift)\/([^/]+)\/([^/]+)\//gi, '/$1/***/***/');
}

function shouldInspectText(url: string, contentType: string): boolean {
  return /mpegurl|m3u|text\/plain/i.test(contentType) || /\.m3u8?(\?|$)/i.test(url);
}

function rewritePlaylist(text: string, baseUrl: string): string {
  return text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    try {
      const absolute = new URL(trimmed, baseUrl).toString();
      return `/api/iptv-proxy?url=${encodeURIComponent(absolute)}`;
    } catch {
      return line;
    }
  }).join('\n');
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const url = searchParams.get('url');
  const ua = searchParams.get('ua') || DEFAULT_UA;
  const referer = searchParams.get('referer') || undefined;

  if (!url) {
    return NextResponse.json({ error: 'Missing URL parameter' }, { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return NextResponse.json({ error: 'Invalid URL parameter' }, { status: 400 });
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return NextResponse.json({ error: 'Unsupported URL protocol' }, { status: 400 });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const response = await fetch(target.toString(), {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': ua,
        ...(referer ? { Referer: referer } : {}),
        Accept: '*/*',
      },
    });
    clearTimeout(timeout);

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const headers = new Headers({
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });

    const acceptRanges = response.headers.get('accept-ranges');
    const contentRange = response.headers.get('content-range');
    if (acceptRanges) headers.set('Accept-Ranges', acceptRanges);
    if (contentRange) headers.set('Content-Range', contentRange);

    if (!response.ok) {
      return NextResponse.json(
        { error: `IPTV upstream returned HTTP ${response.status}`, url: redactUrl(target.toString()) },
        { status: response.status, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    if (shouldInspectText(target.toString(), contentType)) {
      const text = await response.text();
      const body = text.trimStart().startsWith('#EXTM3U') ? rewritePlaylist(text, target.toString()) : text;
      return new NextResponse(body, { status: response.status, headers });
    }

    return new Response(response.body, { status: response.status, headers });
  } catch (error: any) {
    console.error(`[IPTV Proxy] Error fetching ${redactUrl(url)}:`, error.message);
    return NextResponse.json({
      error: `Failed to fetch IPTV data: ${error.message}`,
    }, { status: error.name === 'AbortError' ? 504 : 500 });
  }
}
