import { normalize } from "@/scripts/lib/text.js"
import { daveTvProviderFromCreds, isDaveTvVaultCreds } from "@/scripts/lib/creds.js"

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
        logo: "",
        tvgId: String(item.tvg?.id || id) || undefined,
        norm: normalize(`${name} ${category}`),
        url: String(item.url || ""),
      }
    })
    .filter((item) => item.id && item.name && item.url.startsWith("/api/provider-vault/"))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }))
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
        logo: "",
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
    .filter((item) => item.id && item.name)
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
        logo: "",
        year: "",
        rating: "",
        category,
        plot: "",
        added: 0,
        norm: normalize(`${name} ${category}`),
      }
    })
    .filter((item) => item.id && item.name)
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }))
}
