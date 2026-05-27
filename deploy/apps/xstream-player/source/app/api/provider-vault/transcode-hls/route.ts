import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import { NextRequest, NextResponse } from 'next/server';
import {
    buildStreamUrl,
    getProviderAccount,
    providerIdFromSearch,
    resolveWorkingAccount,
    type ProviderId,
    type StreamKind,
} from '@/app/lib/server/providerVault';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Job = {
    key: string;
    dir: string;
    manifestPath: string;
    process?: ChildProcess;
    startedAt: number;
    lastTouch: number;
    stderr: string;
    failed?: string;
};

const JOBS = new Map<string, Job>();
const ROOT_DIR = path.join(os.tmpdir(), 'xstream-player-hls');
const JOB_TTL_MS = 3 * 60 * 60 * 1000;

function cleanExt(raw?: string | null) {
    return String(raw || 'mp4').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp4';
}

function cleanPart(raw?: string | null) {
    return String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

function jobKey(provider: ProviderId, kind: StreamKind, id: string, ext: string) {
    return crypto.createHash('sha256').update(`${provider}:${kind}:${id}:${ext}`).digest('hex').slice(0, 24);
}

async function fileExists(file: string) {
    try {
        await fsp.access(file, fs.constants.R_OK);
        return true;
    } catch {
        return false;
    }
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return true;
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return false;
}

async function cleanupOldJobs() {
    const now = Date.now();
    for (const [key, job] of JOBS) {
        if (now - job.lastTouch > JOB_TTL_MS) {
            job.process?.kill('SIGTERM');
            JOBS.delete(key);
            fsp.rm(job.dir, { recursive: true, force: true }).catch(() => undefined);
        }
    }
}

function ffmpegArgs(sourceUrl: string, dir: string, manifestPath: string) {
    return [
        '-hide_banner',
        '-loglevel',
        'warning',
        '-nostdin',
        '-user_agent',
        'IPTV Smarters Pro',
        '-reconnect',
        '1',
        '-reconnect_streamed',
        '1',
        '-reconnect_at_eof',
        '1',
        '-reconnect_delay_max',
        '5',
        '-i',
        sourceUrl,
        '-map',
        '0:v:0?',
        '-map',
        '0:a:0?',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '160k',
        '-ac',
        '2',
        '-f',
        'hls',
        '-hls_time',
        '6',
        '-hls_playlist_type',
        'event',
        '-hls_flags',
        'independent_segments',
        '-hls_segment_filename',
        path.join(dir, 'seg_%05d.ts'),
        manifestPath,
    ];
}

async function ensureJob(provider: ProviderId, kind: StreamKind, id: string, ext: string) {
    await cleanupOldJobs();
    const key = jobKey(provider, kind, id, ext);
    const existing = JOBS.get(key);
    if (existing && !existing.failed) {
        existing.lastTouch = Date.now();
        return existing;
    }

    const parsedAccount = getProviderAccount(provider);
    if (!parsedAccount) throw new Error('Provider is not configured on this server');

    const account = await resolveWorkingAccount(parsedAccount);
    const sourceUrl = buildStreamUrl(account, kind, id, ext);
    const dir = path.join(ROOT_DIR, key);
    const manifestPath = path.join(dir, 'index.m3u8');

    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await fsp.mkdir(dir, { recursive: true });

    const job: Job = {
        key,
        dir,
        manifestPath,
        startedAt: Date.now(),
        lastTouch: Date.now(),
        stderr: '',
    };
    JOBS.set(key, job);

    const child = spawn('ffmpeg', ffmpegArgs(sourceUrl, dir, manifestPath), {
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    job.process = child;

    child.stderr?.on('data', (chunk) => {
        job.stderr = `${job.stderr}${String(chunk)}`.slice(-2500);
    });
    child.on('exit', (code, signal) => {
        if (code && code !== 0) {
            job.failed = `ffmpeg exited ${code}${signal ? ` (${signal})` : ''}`;
        }
        job.process = undefined;
    });

    return job;
}

async function readSegment(job: Job, segment: string) {
    if (!/^seg_\d{5}\.ts$/.test(segment)) {
        return new Response('Invalid segment', { status: 400 });
    }

    job.lastTouch = Date.now();
    const file = path.join(job.dir, segment);
    const ready = await waitUntil(() => fileExists(file), 15_000);
    if (!ready) return new Response('Segment is not ready', { status: 404 });

    const stream = fs.createReadStream(file);
    return new Response(stream as any, {
        headers: {
            'Content-Type': 'video/mp2t',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
        },
    });
}

function rewritePlaylist(body: string, req: NextRequest, provider: ProviderId, kind: StreamKind, id: string, ext: string) {
    return body
        .split(/\r?\n/)
        .map((line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return line;
            const url = new URL(req.nextUrl.pathname, req.nextUrl.origin);
            url.searchParams.set('provider', provider);
            url.searchParams.set('kind', kind);
            url.searchParams.set('id', id);
            url.searchParams.set('ext', ext);
            url.searchParams.set('segment', path.basename(trimmed));
            return `${url.pathname}${url.search}`;
        })
        .join('\n');
}

async function readManifest(req: NextRequest, job: Job, provider: ProviderId, kind: StreamKind, id: string, ext: string) {
    const ready = await waitUntil(async () => {
        if (!(await fileExists(job.manifestPath))) return false;
        const body = await fsp.readFile(job.manifestPath, 'utf8').catch(() => '');
        return /seg_\d{5}\.ts/.test(body);
    }, 30_000);

    if (!ready) {
        const reason = job.failed || 'Transcode did not produce a playable manifest';
        return new Response(reason, {
            status: 502,
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
            },
        });
    }

    const body = await fsp.readFile(job.manifestPath, 'utf8');
    return new Response(rewritePlaylist(body, req, provider, kind, id, ext), {
        headers: {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
        },
    });
}

export async function GET(req: NextRequest) {
    const provider = providerIdFromSearch(req.nextUrl.searchParams.get('provider'));
    const kind = req.nextUrl.searchParams.get('kind');
    const id = cleanPart(req.nextUrl.searchParams.get('id'));
    const ext = cleanExt(req.nextUrl.searchParams.get('ext'));
    const segment = req.nextUrl.searchParams.get('segment');

    if (!provider || !id || (kind !== 'movie' && kind !== 'series')) {
        return NextResponse.json({ error: 'Invalid transcode request' }, { status: 400 });
    }

    try {
        const job = await ensureJob(provider, kind, id, ext);
        if (segment) return readSegment(job, segment);
        return readManifest(req, job, provider, kind, id, ext);
    } catch (error: any) {
        return new Response(error?.message || 'Transcode failed', {
            status: 502,
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
            },
        });
    }
}
