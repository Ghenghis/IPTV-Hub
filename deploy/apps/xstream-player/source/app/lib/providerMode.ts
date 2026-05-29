export type VaultProviderId = 'apollo' | 'xtremehd';
export type ProviderMode = 'separated' | 'combined-tagged';
export type CatalogType = 'live' | 'movie' | 'series';

export const PROVIDER_LABELS: Record<VaultProviderId, string> = {
    apollo: 'Apollo Group TV',
    xtremehd: 'XtremeHD',
};

const PROVIDER_IDS: VaultProviderId[] = ['apollo', 'xtremehd'];

export function isVaultProviderId(value: unknown): value is VaultProviderId {
    return value === 'apollo' || value === 'xtremehd';
}

export function isCombinedProviderSelection(value: unknown) {
    return value === 'combined-tagged' || value === 'combined';
}

export function isCombinedCredentials(credentials: any) {
    return (
        credentials?.providerMode === 'combined-tagged' ||
        isCombinedProviderSelection(credentials?.providerId)
    );
}

export function selectedProviderIds(credentials: any): VaultProviderId[] {
    if (isCombinedCredentials(credentials)) {
        const providerIds: VaultProviderId[] = Array.isArray(credentials?.providerIds)
            ? credentials.providerIds.filter(isVaultProviderId)
            : PROVIDER_IDS;
        return providerIds.length ? Array.from(new Set<VaultProviderId>(providerIds)) : PROVIDER_IDS;
    }
    return isVaultProviderId(credentials?.providerId) ? [credentials.providerId] : [];
}

export function providerLabel(providerId?: string | null) {
    return isVaultProviderId(providerId) ? PROVIDER_LABELS[providerId] : 'Manual';
}

export function compositeId(providerId: VaultProviderId, type: CatalogType, rawId: string | number) {
    return `${providerId}:${type}:${String(rawId)}`;
}

export function decodeRouteId(value: string | number | null | undefined) {
    const raw = String(value || '');
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

export function parseCompositeId(value: string | number | null | undefined) {
    const raw = decodeRouteId(value);
    const match = raw.match(/^(apollo|xtremehd):(live|movie|series):(.+)$/);
    if (!match) return null;
    return {
        providerId: match[1] as VaultProviderId,
        type: match[2] as CatalogType,
        rawId: match[3],
    };
}

export function itemProviderId(credentials: any, itemId: string | number | null | undefined) {
    const parsed = parseCompositeId(itemId);
    if (parsed) return parsed.providerId;
    return isVaultProviderId(credentials?.providerId) ? credentials.providerId : null;
}

export function rawItemId(itemId: string | number | null | undefined) {
    return parseCompositeId(itemId)?.rawId || String(itemId || '');
}

export function categoryIdForStorage(
    rawCategoryId: string | number,
    type: CatalogType,
    providerId?: VaultProviderId,
    combinedMode = false,
) {
    return combinedMode && providerId ? compositeId(providerId, type, rawCategoryId) : String(rawCategoryId);
}

export function streamIdForStorage(
    rawStreamId: string | number,
    type: CatalogType,
    providerId?: VaultProviderId,
    combinedMode = false,
) {
    return combinedMode && providerId ? compositeId(providerId, type, rawStreamId) : String(rawStreamId);
}

export function categoryProviderContext(credentials: any, categoryId: string | number | null | undefined) {
    const parsed = parseCompositeId(categoryId);
    if (parsed) {
        return {
            providerId: parsed.providerId,
            rawCategoryId: parsed.rawId,
            combinedMode: true,
        };
    }
    return {
        providerId: isVaultProviderId(credentials?.providerId) ? credentials.providerId : null,
        rawCategoryId: String(categoryId || ''),
        combinedMode: false,
    };
}

export function tagCategoryName(name: string, providerId?: VaultProviderId, combinedMode = false) {
    const clean = String(name || '').trim();
    if (!combinedMode || !providerId) return clean;
    return `${providerLabel(providerId)} / ${clean}`;
}

export function cleanDisplayTitle(name: string) {
    return String(name || '')
        .replace(/^\s*\d+(?:\.\d+)?\s*(?=\|?[A-Z]{2}\||\|EN\||[A-Z][a-z])/i, '')
        .replace(/^\s*[A-Z]{2,4}\|US\|\s*/i, '')
        .replace(/^\s*\|(?:EN|US|UK)\|\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim();
}
