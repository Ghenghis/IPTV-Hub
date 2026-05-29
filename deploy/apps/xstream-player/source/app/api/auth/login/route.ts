import { NextResponse } from 'next/server';
import {
    getProviderAccount,
    listVaultProviders,
    providerIdFromSearch,
    resolveWorkingAccount,
    sanitizeServerInfo,
    sanitizeUserInfo,
} from '@/app/lib/server/providerVault';
import { isCombinedProviderSelection } from '@/app/lib/providerMode';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const providerId = providerIdFromSearch(body.providerId);
        const { username, password, hostUrl } = body;

        if (isCombinedProviderSelection(body.providerId)) {
            const providers = listVaultProviders().filter((provider) => provider.configured);
            const providerIds = providers
                .map((provider) => provider.id)
                .filter((id) => id === 'apollo' || id === 'xtremehd');

            if (providerIds.length < 2) {
                return NextResponse.json(
                    { error: 'Both Apollo Group TV and XtremeHD must be configured for Combined Tagged mode' },
                    { status: 424 }
                );
            }

            return NextResponse.json({
                user_info: {
                    username: 'Combined Tagged',
                    status: 'Active',
                    exp_date: '',
                    active_cons: '',
                    max_connections: '',
                },
                server_info: {
                    url: 'DaveTV Combined Tagged',
                    port: '',
                    https_port: '',
                    server_protocol: 'vault',
                    rtmp_port: '',
                    timezone: '',
                    timestamp_now: 0,
                    time_now: '',
                },
                credentials: {
                    providerId: 'combined-tagged',
                    providerMode: 'combined-tagged',
                    providerIds,
                },
            });
        }

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
