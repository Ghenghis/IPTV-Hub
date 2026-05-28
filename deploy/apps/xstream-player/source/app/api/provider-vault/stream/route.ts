import { NextRequest, NextResponse } from 'next/server';
import {
    buildStreamUrl,
    defaultStreamExtension,
    getProviderAccount,
    providerIdFromSearch,
    proxyMediaResponse,
    resolveWorkingAccount,
} from '@/app/lib/server/providerVault';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
    const providerId = providerIdFromSearch(req.nextUrl.searchParams.get('provider'));
    const kind = req.nextUrl.searchParams.get('kind');
    const id = req.nextUrl.searchParams.get('id');
    if (!providerId || !id || (kind !== 'live' && kind !== 'movie' && kind !== 'series')) {
        return NextResponse.json({ error: 'Invalid stream request' }, { status: 400 });
    }

    const ext = defaultStreamExtension(providerId, kind, req.nextUrl.searchParams.get('ext'));

    const parsedAccount = getProviderAccount(providerId);
    if (!parsedAccount) {
        return NextResponse.json({ error: 'Provider is not configured on this server' }, { status: 404 });
    }

    try {
        const account = await resolveWorkingAccount(parsedAccount);
        const sourceUrl = buildStreamUrl(account, kind, id, ext);
        return proxyMediaResponse(sourceUrl, req.headers.get('range'));
    } catch (error: any) {
        return NextResponse.json(
            { error: error?.message || 'Provider stream failed' },
            { status: 424 }
        );
    }
}
