import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

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
  alternates?: ProviderAccount[];
}

interface TokenEntry {
  url: string;
  expiresAt: number;
}

const PROVIDERS: Array<{ id: ProviderId; name: string; match: RegExp }> = [
  { id: 'apollo', name: 'Apollo Group TV', match: /apollo|apollo\s*group/i },
  { id: 'xtremehd', name: 'XtremeHD', match: /xtremehd|xtreme\s*hd|xtreme/i }
];

const TOKEN_TTL_MS = 10 * 60 * 1000;
const streamTokens = new Map<string, TokenEntry>();
const preferredServers = new Map<ProviderId, { server: string; expiresAt: number }>();
const preferredAccounts = new Map<ProviderId, { account: ProviderAccount; expiresAt: number }>();

function privateDir() {
  if (process.env.IPTV_PRIVATE_DIR) return process.env.IPTV_PRIVATE_DIR;
  if (process.platform === 'win32') return 'G:\\Github\\DaveAI-IPTV\\private';
  return '/opt/davetv/private';
}

function textFiles(root: string) {
  const files: string[] = [];
  if (!fs.existsSync(root)) return files;

  function walk(dir: string) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        walk(full);
      } else if (item.isFile() && ['.txt', '.md', '.json', '.env'].includes(path.extname(item.name).toLowerCase())) {
        files.push(full);
      }
    }
  }

  walk(root);
  return files;
}

function combinedPrivateText() {
  return textFiles(privateDir())
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n\n');
}

function privateTextEntries() {
  return textFiles(privateDir()).map((file) => ({
    file,
    basename: path.basename(file).toLowerCase(),
    text: fs.readFileSync(file, 'utf8')
  }));
}

function cleanValue(value?: string | null) {
  return String(value || '')
    .trim()
    .replace(/^["'`]+|["'`,;]+$/g, '');
}

function valueAfter(label: string, text: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`${escaped}\\s*[:=]\\s*([^\\r\\n]+)`, 'i'));
  return cleanValue(match?.[1]);
}

function labelMatches(labels: string[], text: string) {
  const pattern = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const matches: Array<{ index: number; value: string }> = [];
  for (const match of text.matchAll(new RegExp(`(?:^|[\\r\\n])\\s*(?:${pattern})\\s*[:=]\\s*([^\\r\\n]+)`, 'gi'))) {
    const value = cleanValue(match[1]);
    if (value) matches.push({ index: match.index ?? 0, value });
  }
  return matches;
}

function normalizeServer(raw: string) {
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  const parsed = new URL(withProtocol);
  return `${parsed.protocol}//${parsed.host}`;
}

function accountsFromContext(id: ProviderId, name: string, context: string): ProviderAccount[] {
  const urlCandidates = [...context.matchAll(/https?:\/\/[^\s"'<>]+/gi)]
    .map((match) => cleanValue(match[0]).replace(/[),.]+$/g, ''))
    .filter(Boolean);

  const playlistUrl = urlCandidates.find((url) => /get\.php|m3u|type=|output=|player_api/i.test(url));
  const accounts: ProviderAccount[] = [];
  const seen = new Set<string>();

  function push(server: string, username: string, password: string, m3uUrl?: string) {
    if (!server || !username || !password) return;
    try {
      const normalizedServer = normalizeServer(server);
      const key = `${normalizedServer}|${username}|${password}`;
      if (seen.has(key)) return;
      seen.add(key);
      accounts.push({
        id,
        name,
        server: normalizedServer,
        username,
        password,
        m3uUrl,
        urlCandidates
      });
    } catch {
      // Ignore malformed note snippets.
    }
  }

  for (const raw of [playlistUrl, ...urlCandidates].filter(Boolean) as string[]) {
    try {
      const parsed = new URL(raw);
      const username = cleanValue(parsed.searchParams.get('username') || parsed.searchParams.get('user'));
      const password = cleanValue(parsed.searchParams.get('password') || parsed.searchParams.get('pass'));
      push(`${parsed.protocol}//${parsed.host}`, username, password, raw);
    } catch {
      // Ignore notes that are not URLs.
    }
  }

  const urlServers = [...new Set(urlCandidates.map((raw) => {
    try {
      const parsed = new URL(raw);
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      return '';
    }
  }).filter(Boolean))];
  const serverLabels = labelMatches(['server', 'host', 'portal'], context);
  const servers = serverLabels.concat(urlServers.map((value) => ({ index: 0, value })));
  const usernames = labelMatches(['username', 'user'], context);
  const passwords = labelMatches(['password', 'pass'], context);
  const defaultServer = serverLabels[0]?.value || urlServers[0] || '';

  usernames.forEach((userMatch, index) => {
    const passMatch = passwords[index] || passwords.find((item) => item.index >= userMatch.index) || passwords[0];
    const serverMatch = [...servers].reverse().find((item) => item.index <= userMatch.index) || servers[0];
    push(serverMatch?.value || defaultServer, userMatch.value, passMatch?.value || '', playlistUrl);
  });

  return accounts;
}

function accountFromContext(id: ProviderId, name: string, context: string): ProviderAccount | null {
  return accountsFromContext(id, name, context)[0] || null;
}

function providerSectionContexts(provider: { id: ProviderId; name: string; match: RegExp }) {
  const entries = privateTextEntries();
  const otherProviderMatches = PROVIDERS
    .filter((item) => item.id !== provider.id)
    .map((item) => item.match);
  const contexts: string[] = [];

  for (const entry of entries) {
    const text = entry.text;
    const exactProviderHits = [...text.matchAll(new RegExp(provider.match.source, provider.match.flags.includes('g') ? provider.match.flags : `${provider.match.flags}g`))];

    for (const hit of exactProviderHits) {
      const start = hit.index ?? 0;
      let end = text.length;
      for (const otherMatch of otherProviderMatches) {
        const other = new RegExp(otherMatch.source, otherMatch.flags.includes('g') ? otherMatch.flags : `${otherMatch.flags}g`);
        for (const otherHit of text.slice(start + 1).matchAll(other)) {
          const absolute = start + 1 + (otherHit.index ?? 0);
          if (absolute > start && absolute < end) end = absolute;
          break;
        }
      }
      contexts.push(text.slice(start, Math.min(end, start + 6500)));
    }

    const filenameLooksProviderSpecific =
      entry.basename.includes(provider.id) ||
      provider.name.toLowerCase().split(/\s+/).some((part) => part.length >= 5 && entry.basename.includes(part));

    if (filenameLooksProviderSpecific && exactProviderHits.length === 0) {
      contexts.push(text);
    }

    const filenameLooksOtherProviderSpecific = PROVIDERS
      .filter((item) => item.id !== provider.id)
      .some((item) => (
        entry.basename.includes(item.id) ||
        item.name.toLowerCase().split(/\s+/).some((part) => part.length >= 5 && entry.basename.includes(part))
      ));
    const textMentionsOtherProvider = otherProviderMatches.some((match) => match.test(text));
    if (
      exactProviderHits.length === 0 &&
      !filenameLooksProviderSpecific &&
      !filenameLooksOtherProviderSpecific &&
      !textMentionsOtherProvider &&
      accountFromContext(provider.id, provider.name, text)
    ) {
      contexts.push(text);
    }
  }

  if (!contexts.length) {
    contexts.push(combinedPrivateText());
  }

  return contexts;
}

export function getProviderAccount(id: ProviderId) {
  const provider = PROVIDERS.find((item) => item.id === id);
  if (!provider) return null;

  const accounts: ProviderAccount[] = [];
  const seen = new Set<string>();
  for (const context of providerSectionContexts(provider)) {
    for (const account of accountsFromContext(provider.id, provider.name, context)) {
      const key = `${account.server}|${account.username}|${account.password}`;
      if (seen.has(key)) continue;
      seen.add(key);
      accounts.push(account);
    }
  }

  const [primary, ...alternates] = accounts;
  if (!primary) return null;
  primary.alternates = alternates;
  return primary;
}

export function listVaultProviders() {
  return PROVIDERS.map((provider) => {
    const account = getProviderAccount(provider.id);
    return {
      id: provider.id,
      name: provider.name,
      configured: Boolean(account),
      supports: account ? ['xtream'] : []
    };
  });
}

export function providerIdFromSearch(value: string | null): ProviderId | null {
  if (value === 'apollo' || value === 'xtremehd') return value;
  return null;
}

export function buildXtreamApiUrl(account: ProviderAccount, action?: string, params: Record<string, string> = {}) {
  const query = new URLSearchParams({
    username: account.username,
    password: account.password,
    ...params
  });
  if (action) query.set('action', action);
  return `${account.server}/player_api.php?${query.toString()}`;
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
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) return false;
  const data = await response.json().catch(() => null);
  return Boolean(data?.user_info && String(data.user_info.auth) !== '0');
}

export async function resolveWorkingAccount(account: ProviderAccount) {
  const cachedAccount = preferredAccounts.get(account.id);
  if (cachedAccount && cachedAccount.expiresAt > Date.now()) {
    return cachedAccount.account;
  }

  const candidates = [account, ...(account.alternates || [])];
  for (const candidateAccount of candidates) {
    for (const origin of candidateOrigins(candidateAccount)) {
      try {
        if (await authStatusAtOrigin(candidateAccount, origin)) {
          const workingAccount = { ...candidateAccount, server: origin };
          preferredServers.set(account.id, {
            server: origin,
            expiresAt: Date.now() + 15 * 60 * 1000
          });
          preferredAccounts.set(account.id, {
            account: workingAccount,
            expiresAt: Date.now() + 15 * 60 * 1000
          });
          return workingAccount;
        }
      } catch {
        // Try the next candidate origin/account.
      }
    }
  }

  throw new Error('Provider account is not authenticated');
}

export function buildStreamUrl(account: ProviderAccount, kind: StreamKind, id: string, ext = 'm3u8') {
  const safeExt = ext.replace(/[^a-z0-9]/gi, '') || (kind === 'movie' ? 'mp4' : 'm3u8');
  const parts = [kind, account.username, account.password, `${id}.${safeExt}`].map(encodeURIComponent);
  return `${account.server}/${parts.join('/')}`;
}

export function publicStreamPath(provider: ProviderId, kind: StreamKind, id: string, ext = 'm3u8') {
  const params = new URLSearchParams({ provider, kind, id, ext });
  return `/api/provider-vault/stream?${params.toString()}`;
}

export function publicSeriesMarker(provider: ProviderId, seriesId: string) {
  return `VAULT_SERIES:${provider}:${seriesId}`;
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

function cleanupTokens() {
  const now = Date.now();
  for (const [token, entry] of streamTokens) {
    if (entry.expiresAt < now) streamTokens.delete(token);
  }
}

function tokenizedSegmentUrl(rawUrl: string, baseUrl: string) {
  try {
    const absolute = new URL(rawUrl, baseUrl).toString();
    return `/api/provider-vault/segment?token=${createUrlToken(absolute)}`;
  } catch {
    return rawUrl;
  }
}

export function rewriteM3u8Manifest(body: string, sourceUrl: string) {
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

export async function fetchXtreamJson(account: ProviderAccount, action?: string, params: Record<string, string> = {}) {
  const workingAccount = await resolveWorkingAccount(account);
  const response = await fetch(buildXtreamApiUrl(workingAccount, action, params), {
    headers: { 'User-Agent': 'IPTV Smarters Pro' },
    signal: AbortSignal.timeout(25_000)
  });

  if (!response.ok) {
    throw new Error(`Provider request failed with status ${response.status}`);
  }

  return response.json();
}

export function sanitizedUserInfo(data: any, providerName: string) {
  const user = data?.user_info || {};
  return {
    providerName,
    status: user.status || '',
    auth: user.auth,
    exp_date: user.exp_date || '',
    active_cons: user.active_cons || '',
    max_connections: user.max_connections || ''
  };
}

export function safeLogoUrl(raw: string, account: ProviderAccount) {
  if (!raw) return '';
  const value = cleanValue(raw);
  if (!/^https?:\/\//i.test(value)) return value;
  if (value.includes(account.username) || value.includes(account.password)) return '';
  if (/[?&](username|user|password|pass|token|key)=/i.test(value)) return '';
  const params = new URLSearchParams({ src: value });
  return `/api/provider-vault/image?${params.toString()}`;
}

export async function proxyMediaResponse(sourceUrl: string, range?: string | null) {
  const headers: Record<string, string> = {
    'User-Agent': 'IPTV Smarters Pro'
  };
  if (range) headers.Range = range;

  const upstream = await fetch(sourceUrl, {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000)
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
        'Cache-Control': 'no-store'
      }
    });
  }

  const responseHeaders = new Headers();
  for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const value = upstream.headers.get(key);
    if (value) responseHeaders.set(key, value);
  }
  responseHeaders.set('Cache-Control', 'no-store');

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders
  });
}
