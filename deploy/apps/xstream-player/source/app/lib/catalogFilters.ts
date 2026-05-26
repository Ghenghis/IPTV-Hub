export type CatalogType = 'live' | 'movie' | 'series';

const ENGLISH_SIGNALS = [
    /\bENGLISH\b/i,
    /\bEN\b/i,
    /\bUSA?\b/i,
    /\bUNITED STATES\b/i,
    /\bAMERICAN\b/i,
    /\bUK\b/i,
    /\bUNITED KINGDOM\b/i,
    /\bBRITISH\b/i,
    /\bCANADA\b/i,
    /\bCANADIAN\b/i,
    /\bAUSTRALIA\b/i,
    /\bAUSTRALIAN\b/i,
    /\bNEW ZEALAND\b/i,
    /\bIRELAND\b/i,
    /\bIRISH\b/i,
];

const NON_ENGLISH_SIGNALS = [
    /\bARAB(IC)?\b/i,
    /\bBANGLA(DESH)?\b/i,
    /\bBRAZIL(IAN)?\b/i,
    /\bBRASIL\b/i,
    /\bPORTUG(U|UESE|UES)\b/i,
    /\bESPANOL\b/i,
    /\bESPA(N|Ñ)A\b/i,
    /\bSPANISH\b/i,
    /\bLATINO?\b/i,
    /\bLATAM\b/i,
    /\bMEXICO\b/i,
    /\bFRANCE\b/i,
    /\bFRENCH\b/i,
    /\bGERMAN(Y)?\b/i,
    /\bDEUTSCH\b/i,
    /\bDUTCH\b/i,
    /\bITAL(Y|IAN)\b/i,
    /\bRUSSIA(N)?\b/i,
    /\bHINDI\b/i,
    /\bINDIA(N)?\b/i,
    /\bPUNJABI\b/i,
    /\bTAMIL\b/i,
    /\bTELUGU\b/i,
    /\bMALAYALAM\b/i,
    /\bKANNADA\b/i,
    /\bMARATHI\b/i,
    /\bURDU\b/i,
    /\bPAKISTAN(I)?\b/i,
    /\bCHINA\b/i,
    /\bCHINESE\b/i,
    /\bMANDARIN\b/i,
    /\bKOREA(N)?\b/i,
    /\bJAPAN(ESE)?\b/i,
    /\bVIET(NAM|NAMESE)?\b/i,
    /\bTHAI(LAND)?\b/i,
    /\bTURK(ISH|EY)?\b/i,
    /\bGREE(K|CE)\b/i,
    /\bPOL(ISH|AND)\b/i,
    /\bROMANIA(N)?\b/i,
    /\bALBANIA(N)?\b/i,
    /\bAFGHAN\b/i,
    /\bPERSIAN\b/i,
];

const LIVE_NEUTRAL_ALLOW = [
    /\bNEWS\b/i,
    /\bSPORTS?\b/i,
    /\bENTERTAINMENT\b/i,
    /\bDOCUMENTAR(Y|IES)\b/i,
    /\bKIDS?\b/i,
    /\bMOVIES?\b/i,
    /\bSERIES\b/i,
    /\bMUSIC\b/i,
    /\bPREMIUM\b/i,
    /\bNETWORKS?\b/i,
    /\bLOCAL(S)?\b/i,
    /\bPPV\b/i,
    /\bEVENTS?\b/i,
    /\bNBA\b/i,
    /\bNFL\b/i,
    /\bMLB\b/i,
    /\bNHL\b/i,
    /\bUFC\b/i,
    /\bESPN\b/i,
    /\bFOX\b/i,
    /\bCBS\b/i,
    /\bNBC\b/i,
    /\bABC\b/i,
];

function normalizeText(value: string) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[_|()[\]{}:;,+/\\-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function hasSignal(value: string, patterns: RegExp[]) {
    return patterns.some((pattern) => pattern.test(value));
}

export function isEnglishCatalogName(name: string, type: CatalogType) {
    const normalized = normalizeText(name);
    if (!normalized) return false;

    const hasEnglishSignal = hasSignal(normalized, ENGLISH_SIGNALS);
    const hasNonEnglishSignal = hasSignal(normalized, NON_ENGLISH_SIGNALS);

    if (hasEnglishSignal) return true;
    if (hasNonEnglishSignal) return false;

    // Movie and series providers usually use genre/category names without a
    // language marker. Keep those unless the category is explicitly non-English.
    if (type === 'movie' || type === 'series') return true;

    return hasSignal(normalized, LIVE_NEUTRAL_ALLOW);
}

export function filterEnglishCategories<T extends { category_id: string | number; category_name?: string }>(
    categories: T[],
    type: CatalogType,
) {
    return categories.filter((category) => isEnglishCatalogName(category.category_name || '', type));
}

export function categoryIdSet(categories: Array<{ category_id: string | number }>) {
    return new Set(categories.map((category) => String(category.category_id)));
}

export function isAllowedCatalogItem(
    item: { category_id?: string | number; name?: string },
    type: CatalogType,
    allowedCategoryIds?: Set<string>,
) {
    const categoryId = String(item.category_id || '');
    if (allowedCategoryIds?.size) return allowedCategoryIds.has(categoryId);
    return isEnglishCatalogName(item.name || '', type);
}

export function safeImagePath(raw?: string | null) {
    const value = String(raw || '').trim();
    if (!value) return undefined;
    if (!/^https?:\/\//i.test(value)) return value;
    if (/[?&](username|user|password|pass|token|key)=/i.test(value)) return undefined;
    return `/api/provider-vault/image?src=${encodeURIComponent(value)}`;
}
