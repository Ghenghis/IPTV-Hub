import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export type ProviderId = 'apollo' | 'xtremehd';
export type StreamKind = 'live' | 'movie' | 'series';

export interface ProviderAccount {
    id: ProviderId;
    name: string;
    server: string;
    username: string;
    password: string;
    m3uUrl?: string;
    urlCandidates: string[];
}

const PROVIDERS: Array<{ id: ProviderId; name: string; match: RegExp }> = [
    { id: 'apollo', name: 'Apollo Group TV', match: /apollo|apollo\s*group/i },
    { id: 'xtremehd', name: 'XtremeHD', match: /xtremehd|xtreme\s*hd|xtreme/i },
];

const TOKEN_TTL_MS = 10 * 60 * 1000;
const streamTokens = new Map<string, { url: string; expiresAt: number }>();
const preferredServers = new Map<ProviderId, { server: string; expiresAt: number }>();

function privateDir() {
    if (process.env.IPTV_PRIVATE_DIR) return process.env.IPTV_PRIVATE_DIR;
    if (process.platform === 'win32') return 'G:\\Github\\DaveAI-IPTV\\private';
    return '/opt/davetv/private';
}

function cleanValue(value?: string) {
    return String(value || '')
        .trim()
        .replace(/^["'`]+|["'`,;]+$/g, '')
        .replace(/\\n/g, '')
        .replace(/\\r/g, '');
}

function textFiles(root: string) {
    const files: string[] = [];
    if (!fs.existsSync(root)) return files;

    const walk = (dir: string) => {
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, item.name);
            if (item.isDirectory()) {
                walk(full);
            } else if (item.isFile() && ['.txt', '.md', '.json', '.env'].includes(path.extname(item.name).toLowerCase())) {
                files.push(full);
            }
        }
    };

    walk(root);
    return files;
}

function combinedPrivateText() {
    return textFiles(privateDir())
        .map((file) => fs.readFileSync(file, 'utf8'))
        .join('\n\n');
}

function valueAfter(label: string, text: string) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`${escaped}\\s*[:=]\\s*([^\\r\\n]+)`, 'i'));
    return cleanValue(match?.[1]);
}

function normalizeServer(raw: string) {
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    const parsed = new URL(withProtocol);
    return `${parsed.protocol}//${parsed.host}`;
}

function accountFromContext(id: ProviderId, name: string, context: string): ProviderAccount | null {
    const urlCandidates = [...context.matchAll(/https?:\/\/[^\s"'<>]+/gi)]
        .map((match) => cleanValue(match[0]).replace(/[),.]+$/g, ''))
        .filter(Boolean);

    const playlistUrl = urlCandidates.find((url) => /get\.php|m3u|type=|output=|player_api/i.test(url));
    let server = '';
    let username = '';
    let password = '';

    for (const raw of [playlistUrl, ...urlCandidates].filter(Boolean) as string[]) {
        try {
            const parsed = new URL(raw);
            username ||= cleanValue(parsed.searchParams.get('username') || parsed.searchParams.get('user') || '');
            password ||= cleanValue(parsed.searchParams.get('password') || parsed.searchParams.get('pass') || '');
            server ||= `${parsed.protocol}//${parsed.host}`;
        } catch {
            // Ignore notes that are not valid URLs.
        }
    }

    server ||= valueAfter('server', context) || valueAfter('host', context) || valueAfter('portal', context);
    username ||= valueAfter('username', context) || valueAfter('user', context);
    password ||= valueAfter('password', context) || valueAfter('pass', context);

    if (!server || !username || !password) return null;

    try {
        return {
            id,
            name,
            server: normalizeServer(server),
            username,
            password,
            m3uUrl: playlistUrl,
            urlCandidates,
        };
    } catch {
        return null;
    }
}

export function providerIdFromSearch(raw?: string | null): ProviderId | null {
    const value = String(raw || '').toLowerCase();
    return value === 'apollo' || value === 'xtremehd' ? value : null;
}

export function getProviderAccount(id: ProviderId) {
    const provider = PROVIDERS.find((item) => item.id === id);
    if (!provider) return null;

    const text = combinedPrivateText();
    const matchIndex = text.search(provider.match);
    const context = matchIndex >= 0
        ? text.slice(Math.max(0, matchIndex - 1200), matchIndex + 6500)
        : text;

    return accountFromContext(provider.id, provider.name, context);
}

export function listVaultProviders() {
    return PROVIDERS.map((provider) => {
        const account = getProviderAccount(provider.id);
        return {
            id: provider.id,
            name: provider.name,
            configured: Boolean(account),
            supports: account ? ['xtream'] : [],
        };
    });
}

export async function resolveWorkingAccount(account: ProviderAccount) {
    const cached = preferredServers.get(account.id);
    if (cached && cached.expiresAt > Date.now()) {
        return { ...account, server: cached.server };
    }

    for (const origin of candidateOrigins(account)) {
        try {
            if (await authStatusAtOrigin(account, origin)) {
                preferredServers.set(account.id, {
                    server: origin,
                    expiresAt: Date.now() + 15 * 60 * 1000,
                });
                return { ...account, server: origin };
            }
        } catch {
            // Try the next candidate origin.
        }
    }

    throw new Error('Provider account is not authenticated');
}

export function buildXtreamApiUrl(account: ProviderAccount, action?: string, params: Record<string, string> = {}) {
    const url = new URL('/player_api.php', account.server);
    url.searchParams.set('username', account.username);
    url.searchParams.set('password', account.password);
    if (action) url.searchParams.set('action', action);
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return url.toString();
}

export async function fetchXtreamJson(account: ProviderAccount, action?: string, params: Record<string, string> = {}) {
    const workingAccount = await resolveWorkingAccount(account);
    const response = await fetch(buildXtreamApiUrl(workingAccount, action, params), {
        headers: { 'User-Agent': 'IPTV Smarters Pro' },
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
        throw new Error(`Provider request failed with status ${response.status}`);
    }
    return response.json();
}

function candidateOrigins(account: ProviderAccount) {
    const origins = [account.server];
    for (const raw of account.urlCandidates) {
        try {
            const parsed = new URL(raw);
            origins.push(`${parsed.protocol}//${parsed.host}`);
        } catch {
            // Ignore invalid notes.
        }
    }
    return [...new Set(origins.filter(Boolean))];
}

async function authStatusAtOrigin(account: ProviderAccount, origin: string) {
    const candidate = { ...account, server: origin };
    const response = await fetch(buildXtreamApiUrl(candidate), {
        headers: { 'User-Agent': 'Mozilla/5.0 IPTV QA' },
        signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return false;
    const data = await response.json().catch(() => null);
    return Boolean(data?.user_info && String(data.user_info.auth) !== '0');
}

export function sanitizeUserInfo(data: any, providerName: string) {
    const user = data?.user_info || {};
    return {
        username: providerName,
        status: user.status || '',
        exp_date: user.exp_date || '',
        active_cons: user.active_cons || '',
        max_connections: user.max_connections || '',
    };
}

export function sanitizeServerInfo(data: any, providerName: string) {
    const server = data?.server_info || {};
    return {
        url: providerName,
        port: '',
        https_port: '',
        server_protocol: 'vault',
        rtmp_port: '',
        timezone: server.timezone || '',
        timestamp_now: server.timestamp_now || 0,
        time_now: server.time_now || '',
    };
}

export async function resolveRequestAccount(body: any) {
    const providerId = providerIdFromSearch(body?.providerId);
    if (providerId) {
        const account = getProviderAccount(providerId);
        if (!account) throw new Error('Provider is not configured on this server');
        return resolveWorkingAccount(account);
    }

    if (body?.hostUrl && body?.username && body?.password) {
        return {
            id: 'apollo' as ProviderId,
            name: 'Manual',
            server: String(body.hostUrl).replace(/\/$/, ''),
            username: String(body.username),
            password: String(body.password),
            urlCandidates: [],
        };
    }

    throw new Error('Missing provider');
}

export function buildStreamUrl(account: ProviderAccount, kind: StreamKind, id: string, ext = 'm3u8') {
    const safeExt = ext.replace(/[^a-z0-9]/gi, '') || (kind === 'movie' ? 'mp4' : 'm3u8');
    const parts = [kind, account.username, account.password, `${id}.${safeExt}`].map(encodeURIComponent);
    return `${account.server}/${parts.join('/')}`;
}

function cleanupTokens() {
    const now = Date.now();
    for (const [token, entry] of streamTokens) {
        if (entry.expiresAt < now) streamTokens.delete(token);
    }
}

export function createUrlToken(url: string) {
    cleanupTokens();
    const token = crypto.randomBytes(18).toString('base64url');
    streamTokens.set(token, { url, expiresAt: Date.now() + TOKEN_TTL_MS });
    return token;
}

export function resolveUrlToken(token: string) {
    const entry = streamTokens.get(token);
    if (!entry || entry.expiresAt < Date.now()) {
        streamTokens.delete(token);
        return null;
    }
    entry.expiresAt = Date.now() + TOKEN_TTL_MS;
    return entry.url;
}

function tokenizedSegmentUrl(rawUrl: string, baseUrl: string) {
    try {
        const absolute = new URL(rawUrl, baseUrl).toString();
        return `/api/provider-vault/segment?token=${createUrlToken(absolute)}`;
    } catch {
        return rawUrl;
    }
}

function rewriteM3u8Manifest(body: string, sourceUrl: string) {
    return body
        .split(/\r?\n/)
        .map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return line;
            if (trimmed.startsWith('#')) {
                return line.replace(/URI="([^"]+)"/g, (_full, uri) => `URI="${tokenizedSegmentUrl(uri, sourceUrl)}"`);
            }
            return tokenizedSegmentUrl(trimmed, sourceUrl);
        })
        .join('\n');
}

export async function proxyMediaResponse(sourceUrl: string, range?: string | null) {
    const headers: Record<string, string> = { 'User-Agent': 'IPTV Smarters Pro' };
    if (range) headers.Range = range;

    const upstream = await fetch(sourceUrl, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(30_000),
    });

    if (!upstream.ok && upstream.status !== 206) {
        return new Response('Provider stream request failed', { status: upstream.status });
    }

    const contentType = upstream.headers.get('content-type') || '';
    const isManifest = contentType.includes('mpegurl') || /\.m3u8(\?|$)/i.test(sourceUrl);
    if (isManifest) {
        const body = await upstream.text();
        return new Response(rewriteM3u8Manifest(body, sourceUrl), {
            status: upstream.status,
            headers: {
                'Content-Type': 'application/vnd.apple.mpegurl',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
            },
        });
    }

    if (/text\/html|application\/json/i.test(contentType)) {
        return new Response('Provider returned a non-video response for this stream', {
            status: 502,
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
            },
        });
    }

    const responseHeaders = new Headers();
    for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const value = upstream.headers.get(key);
        if (value) responseHeaders.set(key, value);
    }
    responseHeaders.set('Cache-Control', 'no-store');
    responseHeaders.set('Access-Control-Allow-Origin', '*');

    return new Response(upstream.body, {
        status: upstream.status,
        headers: responseHeaders,
    });
}
