import { NextRequest } from 'next/server';
import { proxyMediaResponse, resolveUrlToken } from '@/app/lib/server/providerVault';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
    const token = req.nextUrl.searchParams.get('token') || '';
    const sourceUrl = resolveUrlToken(token);
    if (!sourceUrl) {
        return new Response('Segment token expired', { status: 404 });
    }
    return proxyMediaResponse(sourceUrl, req.headers.get('range'));
}
