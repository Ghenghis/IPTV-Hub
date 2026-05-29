import { normalize } from "@/scripts/lib/text.js"
import { daveTvProviderFromCreds, isDaveTvVaultCreds } from "@/scripts/lib/creds.js"

const VAULT_PROFILE = "english"
const VAULT_CACHE_SENTINEL = "xt_davetv_vault_profile_cache_v2"

function runVaultCacheMigration() {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") return
  try {
    if (localStorage.getItem(VAULT_CACHE_SENTINEL) === "1") return
    localStorage.setItem(VAULT_CACHE_SENTINEL, "1")
    indexedDB.deleteDatabase("xt_cache")
  } catch {}
}

runVaultCacheMigration()

export function isVaultCreds(creds) {
  return isDaveTvVaultCreds(creds)
}

export function vaultProviderId(creds) {
  return daveTvProviderFromCreds(creds)
}

export function vaultStreamUrl(providerId, kind, id, ext = "") {
  const search = new URLSearchParams({
    provider: providerId,
    kind,
    id: String(id),
  })
  if (ext) search.set("ext", String(ext).replace(/^\.+/, ""))
  return `/api/provider-vault/stream?${search.toString()}`
}

export function vaultApiUrl(providerId, action = "", params = {}) {
  const search = new URLSearchParams({ provider: providerId })
  if (action) search.set("action", action)
  for (const [key, value] of Object.entries(params || {})) {
    if (value != null && value !== "") search.set(key, String(value))
  }
  return `/api/provider-vault/xtream-api?${search.toString()}`
}

export async function vaultApiFetch(providerId, action = "", params = {}, opts = {}) {
  return fetch(vaultApiUrl(providerId, action, params), {
    credentials: "same-origin",
    ...opts,
  })
}

export async function fetchVaultCatalog(providerId, limits = {}) {
  const search = new URLSearchParams({
    provider: providerId,
    profile: limits.profile || VAULT_PROFILE,
    liveLimit: String(limits.liveLimit ?? 1800),
    movieLimit: String(limits.movieLimit ?? 1200),
    seriesLimit: String(limits.seriesLimit ?? 1200),
  })
  const response = await fetch(`/api/provider-vault/catalog?${search.toString()}`, {
    credentials: "same-origin",
  })
  if (!response.ok) throw new Error(`DaveTV vault catalog ${response.status}`)
  return response.json()
}

function vaultLogo(item) {
  return String(item?.tvg?.logo || item?.logo || "")
}

function isMarkerName(name) {
  return /^#{2,}/.test(String(name || "").trim())
}

function normalizeLiveUrl(url) {
  const raw = String(url || "")
  if (!raw.includes("/api/provider-vault/aac-hls?")) return raw
  try {
    const parsed = new URL(raw, "https://davetv.local")
    const sourceExt = parsed.searchParams.get("sourceExt") || parsed.searchParams.get("ext") || "ts"
    parsed.searchParams.set("ext", "m3u8")
    parsed.searchParams.set("sourceExt", sourceExt)
    parsed.searchParams.set("video", "h264")
    parsed.searchParams.set("segment", "ts")
    return `${parsed.pathname}${parsed.search}`
  } catch {
    const joiner = raw.includes("?") ? "&" : "?"
    return `${raw}${joiner}ext=m3u8&sourceExt=ts&video=h264&segment=ts`
  }
}

export function vaultLiveItems(catalog) {
  return (Array.isArray(catalog?.live) ? catalog.live : [])
    .map((item, index) => {
      const id = Number(new URLSearchParams(String(item.url || "").split("?")[1] || "").get("id")) || index + 1
      const name = String(item.name || item.tvg?.name || `Channel ${id}`)
      const category = String(item.group?.title || "Live TV")
      return {
        id,
        name,
        category,
        logo: vaultLogo(item),
        tvgId: String(item.tvg?.id || id) || undefined,
        norm: normalize(`${name} ${category}`),
        url: normalizeLiveUrl(item.url),
      }
    })
    .filter((item) => item.id && item.name && !isMarkerName(item.name) && item.url.startsWith("/api/provider-vault/"))
}

export function vaultMovieItems(catalog) {
  return (Array.isArray(catalog?.movies) ? catalog.movies : [])
    .map((item, index) => {
      const params = new URLSearchParams(String(item.url || "").split("?")[1] || "")
      const id = Number(params.get("id")) || index + 1
      const name = String(item.name || item.tvg?.name || `Movie ${id}`)
      const category = String(item.group?.title || "Movies")
      return {
        id,
        name,
        logo: vaultLogo(item),
        year: "",
        rating: "",
        duration: "",
        category,
        plot: "",
        added: 0,
        container_extension: params.get("ext") || "mp4",
        norm: normalize(`${name} ${category}`),
      }
    })
    .filter((item) => item.id && item.name && !isMarkerName(item.name))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }))
}

export function vaultSeriesItems(catalog) {
  return (Array.isArray(catalog?.series) ? catalog.series : [])
    .map((item, index) => {
      const marker = String(item.url || "")
      const markerId = marker.startsWith("davetv-series://")
        ? marker.slice("davetv-series://".length).split(":").pop()
        : ""
      const id = Number(markerId) || index + 1
      const name = String(item.name || item.tvg?.name || `Series ${id}`)
      const category = String(item.group?.title || "Series")
      return {
        id,
        name,
        logo: vaultLogo(item),
        year: "",
        rating: "",
        category,
        plot: "",
        added: 0,
        norm: normalize(`${name} ${category}`),
      }
    })
    .filter((item) => item.id && item.name && !isMarkerName(item.name))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }))
}
