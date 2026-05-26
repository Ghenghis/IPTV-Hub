import { NextResponse } from 'next/server';
import {
    getProviderAccount,
    providerIdFromSearch,
    resolveWorkingAccount,
    sanitizeServerInfo,
    sanitizeUserInfo,
} from '@/app/lib/server/providerVault';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const providerId = providerIdFromSearch(body.providerId);
        const { username, password, hostUrl } = body;

        if (providerId) {
            const parsedAccount = getProviderAccount(providerId);
            if (!parsedAccount) {
                return NextResponse.json(
                    { error: 'Provider is not configured on this server' },
                    { status: 404 }
                );
            }

            const account = await resolveWorkingAccount(parsedAccount);
            const apiUrl = `${account.server}/player_api.php?username=${encodeURIComponent(account.username)}&password=${encodeURIComponent(account.password)}`;
            const response = await fetch(apiUrl, {
                headers: { 'User-Agent': 'IPTV Smarters Pro' },
                signal: AbortSignal.timeout(25_000),
            });

            if (!response.ok) {
                return NextResponse.json(
                    { error: `Failed to connect to provider: ${response.statusText}` },
                    { status: response.status }
                );
            }

            const data = await response.json();
            if (data.user_info && String(data.user_info.auth) === '0') {
                return NextResponse.json({ error: 'Authentication failed' }, { status: 401 });
            }

            const authData = {
                credentials: { providerId },
                user: sanitizeUserInfo(data, account.name),
                server: sanitizeServerInfo(data, account.name),
            };

            return NextResponse.json({
                user_info: authData.user,
                server_info: authData.server,
                credentials: authData.credentials,
            });
        }

        if (!username || !password || !hostUrl) {
            return NextResponse.json(
                { error: 'Missing credentials or host URL' },
                { status: 400 }
            );
        }

        // Normalized URL: remove trailing slash
        const baseUrl = hostUrl.replace(/\/$/, '');
        const apiUrl = `${baseUrl}/player_api.php?username=${username}&password=${password}`;

        console.log(`Attempting manual login to configured Xtream server`);

        const response = await fetch(apiUrl);

        if (!response.ok) {
            return NextResponse.json(
                { error: `Failed to connect to server: ${response.statusText}` },
                { status: response.status }
            );
        }

        const data = await response.json();

        if (data.user_info && data.user_info.auth === 0) {
            return NextResponse.json(
                { error: 'Authentication failed' },
                { status: 401 }
            );
        }

        return NextResponse.json(data);

    } catch (error: any) {
        console.error('Auth Error:', error?.message || error);
        return NextResponse.json(
            { error: 'Internal Server Error', details: error.message },
            { status: 500 }
        );
    }
}
