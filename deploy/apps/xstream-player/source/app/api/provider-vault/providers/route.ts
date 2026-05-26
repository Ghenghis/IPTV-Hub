import { NextResponse } from 'next/server';
import { listVaultProviders } from '@/app/lib/server/providerVault';

export const dynamic = 'force-dynamic';

export async function GET() {
    return NextResponse.json({ providers: listVaultProviders() });
}
