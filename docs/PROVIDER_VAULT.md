# Provider Vault — design and current DaveAI rollout

> **Status: partially implemented for DaveAI-hosted web apps.** The original
> keychain/Tauri launcher design below is still the long-term contract, but
> `apps.daveai.tech` now uses a server-side DaveTV provider vault and
> same-origin `/api/provider-vault/*` endpoints for selected web players.
> Browser apps must store only provider references or safe proxy URLs; they
> must not persist raw Apollo Group TV or XtremeHD credentials.
>
> **Scope of policy framing:** IPTV-Hub is provider-agnostic. The vault stores
> credentials that **the user already owns and is legally entitled to use**
> (paid subscription, self-hosted M3U, etc.). The catalogue does not embed
> any provider's credentials, does not distribute any provider's streams,
> and does not interpret provider terms-of-service. Examples below use the
> form `<your-provider-host>` / `USERNAME` / `PASSWORD` so this file is
> safe to commit; nothing in the repo carries an actual credential.

## Motivation

The IPTV-Hub catalogue ships 25–28 web/native players. Each one consumes a
provider in a slightly different shape:

| Consumption pattern | Examples | What the player wants |
|---|---|---|
| **Xtream Codes API** | iptvnator, iptv-restream, smart-iptv-web | `host`, `username`, `password` (the player computes M3U + EPG URLs from these) |
| **M3U URL** | nuvioweb, tvapp, xstream-player | A pre-signed URL like `https://<host>/get.php?username=...&password=...&type=m3u_plus` |
| **Stalker portal** | stalker-ui | MAC address + portal base URL |
| **Provider-vault web** | xstream-player, smart-iptv-web, iptv-stream, iptv-player-zero, nuvioweb, iptvnator, extreme-infinitv, wizju-iptv-player, stalker-ui, iptv-restream, open-tv, ynotv | DaveTV server-side vault endpoints and safe same-origin stream/catalog URLs |
| **No provider / preview only** | visual demos still marked preview-only in the launcher | static demo content; no creds needed |

Current DaveTV web rollout also sanitizes provider logo/poster URLs. Safe
non-secret HTTP/HTTPS image URLs are exposed to browser apps as same-origin
`/api/provider-vault/image?src=...`; URLs with embedded credentials or
credential-shaped query keys are rejected server-side.

Today every player has its own settings UI. Setting up two paid providers
(say *XtremeHD* and *Apollo Group TV*) across 8 players means **16
credential entries** typed by hand, often on a TV remote. Each one is a
chance to type a password into a UI that may log it, send it to a third
party, or store it in plaintext local storage.

The Provider Vault makes the user enter each provider **once**. IPTV-Hub
holds the credentials in the OS keychain, and the launcher injects the
right shape into each app at launch time.

## Threat model

| Threat | Defense |
|---|---|
| Credentials at rest on disk in plaintext | Stored only in the OS keychain via the `keyring` crate (Windows Credential Manager, macOS Keychain, Secret Service on Linux). The on-disk `apps.json` manifest holds only a `ref:<id>` pointer, never the secret. |
| Credentials read by another process on the same machine | OS keychain ACL: only processes running as the same user with the same calling identity can read the entry. IPTV-Hub uses a dedicated service name (`com.iptvhub.provider`). |
| Credentials logged to disk or shipped to telemetry | All log macros that touch a Provider value go through `Provider::display_redacted()` which masks the credential. No `Debug` impl on `ProviderCreds`; `Display` is forbidden. |
| Credentials leaked to a hostile player (one of the 25-28 apps is compromised) | Per-app **adapter** scoping. The launcher injects credentials **only** for the apps the user has opted in for that provider (`AppEntry.provider_uses`). A new/unverified player never sees any credential by default. |
| QR-code import phishing (a malicious QR code masquerades as an Xtream import) | The QR payload uses the `iptvhub://provider/v1` custom scheme. The frontend's QR scanner refuses any other scheme; the import dialog shows the decoded host/username and requires explicit user confirmation before persisting. No background auto-import. |
| Replay of a QR code captured by a screen-recorder | Provider QR codes are intended for one-time entry; users are expected to print/scan them once and destroy the QR. Future hardening: optional rotating one-time-import tokens issued by a companion mobile app. |
| Stalker portal MAC-spoofing | MAC address is treated as a credential, not an identifier. Same keychain storage; never logged. |
| Cross-app credential reuse | Provider entries are scoped per-provider; players that share a provider see only the per-launch synthesised URL/env (never the underlying secret). |

## Data model

```text
                ┌──────────────────────────────────────┐
                │           OS keychain                │
                │   service = com.iptvhub.provider     │
                │   account = <provider.id>            │
                │   secret  = JSON-encoded ProviderCreds│
                └────────────┬─────────────────────────┘
                             │ resolved at launch only
                             ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│   apps.json      │    │   Provider       │    │   Adapter        │
│   AppEntry       ├───►│   metadata only  ├───►│   per-AppEntry   │
│   provider_uses  │    │   (id, host,     │    │   (kind +        │
│   adapter_kind   │    │   kind, name)    │    │   template)      │
└──────────────────┘    └──────────────────┘    └──────────────────┘
```

### `Provider` (manifest-side, NO secrets)

```rust
/// Metadata for a provider the user has registered. Persisted to apps.json.
/// Contains NO credentials — the credential is in the OS keychain under
/// service `com.iptvhub.provider`, account `<provider.id>`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Provider {
    /// kebab-case slug. Stable across renames of the display name.
    /// Example: "xtremehd-primary", "apollo-group-secondary".
    pub id: String,

    /// Human-readable label for the settings UI. May be edited.
    pub name: String,

    /// Discriminates which `ProviderCreds` shape lives in the keychain.
    pub kind: ProviderKind,

    /// Provider base URL (without credentials). Example:
    /// `https://<your-provider-host>:8080`. Used by adapters that need to
    /// construct per-launch URLs.
    pub host: String,

    /// ISO 8601 timestamp of last-known-good probe. The poller may opt to
    /// hit `<host>/player_api.php?action=get_account_info` periodically;
    /// failures are surfaced in the settings UI but never block launches.
    pub last_validated_at: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderKind {
    /// Xtream Codes API. Creds = { username, password }.
    XtreamCodes,
    /// Direct M3U URL. Creds = { url }. URL may already carry credentials;
    /// IPTV-Hub never parses them out.
    M3u,
    /// Stalker portal. Creds = { mac, portal_url }.
    Stalker,
}
```

### `ProviderCreds` (keychain-side, NEVER in manifest, NEVER in DB)

```rust
/// Secret. Read only inside the launcher's secure-injection path.
/// Never `Debug`-printed; never `Display`-printed; never serialised
/// outside the keychain entry.
#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ProviderCreds {
    XtreamCodes { username: String, password: String },
    M3u { url: String },
    Stalker { mac: String, portal_url: String },
}

// Hand-rolled Debug that redacts:
impl std::fmt::Debug for ProviderCreds {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::XtreamCodes { username, .. } => {
                write!(f, "XtreamCodes {{ username: {username:?}, password: <redacted> }}")
            }
            Self::M3u { .. } => write!(f, "M3u {{ url: <redacted> }}"),
            Self::Stalker { mac, .. } => {
                write!(f, "Stalker {{ mac: {mac:?}, portal_url: <redacted> }}")
            }
        }
    }
}
```

### Adapter (per-`AppEntry`, manifest-side)

Each catalogue app declares **how** it wants the credential injected. The
adapter is a small enum so the launcher knows what to do with the resolved
`ProviderCreds`.

```rust
/// Added to `AppEntry`. None means "this app does not consume a provider"
/// — the launcher passes through with no credential injection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderAdapter {
    /// The provider this app should be launched against. References a
    /// `Provider.id`. If the referenced provider is absent at launch time,
    /// the launcher records an activity-log entry and the launch proceeds
    /// without credentials (the app will surface its own "no provider" UI).
    pub uses_provider: String,

    /// How to inject the resolved creds. The launcher fills in placeholders
    /// like `{xtream.username}` from the resolved `ProviderCreds` value.
    pub injection: Injection,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Injection {
    /// Set environment variables on the spawned process / container.
    /// Used for web apps that read M3U/EPG URLs from env.
    EnvVar { vars: BTreeMap<String, String> },

    /// Seed `localStorage` before the page navigates. Tauri webview only.
    /// Used by browser-based players whose existing settings page already
    /// reads from `localStorage`.
    LocalStorageSeed { keys: BTreeMap<String, String> },

    /// Append URL query parameters to the launch URL.
    UrlQuery { params: BTreeMap<String, String> },

    /// Generate an M3U file at a known path inside the cache dir and let
    /// the player read it. The file is written 0600 and deleted when the
    /// player exits.
    M3uFile { template: String, mount_path: String },
}
```

### Placeholder syntax

Inside any `Injection` value string, the launcher recognises:

| Placeholder | Resolved to |
|---|---|
| `{xtream.username}` | `ProviderCreds::XtreamCodes.username` |
| `{xtream.password}` | `ProviderCreds::XtreamCodes.password` |
| `{xtream.host}` | The provider's `host` field (no credential) |
| `{xtream.m3u_url}` | Synthesised: `{host}/get.php?username={u}&password={p}&type=m3u_plus` |
| `{xtream.xmltv_url}` | Synthesised: `{host}/xmltv.php?username={u}&password={p}` |
| `{m3u.url}` | `ProviderCreds::M3u.url` |
| `{stalker.mac}` | `ProviderCreds::Stalker.mac` |
| `{stalker.portal_url}` | `ProviderCreds::Stalker.portal_url` |

A placeholder that references a kind that doesn't match the provider's
actual `kind` is a manifest validation error. The schema lists the legal
placeholders so the JSON-Schema validator can catch mismatches at
load-time, not at launch-time.

## QR-code import format

The QR payload is a URI under a custom scheme. The frontend's scanner
refuses any other scheme.

```
iptvhub://provider/v1?
  type=<xtream|m3u|stalker>&
  name=<URL-encoded display name>&
  host=<URL-encoded base URL, e.g. https://example.com:8080>&
  user=<URL-encoded username>&            (xtream only)
  pass=<URL-encoded password>&            (xtream only)
  url=<URL-encoded M3U URL>&              (m3u only)
  mac=<MAC, e.g. 00:1A:79:XX:XX:XX>&      (stalker only)
  portal=<URL-encoded portal URL>          (stalker only)
```

Examples (safe to print/commit — placeholders only):

```
# Xtream Codes
iptvhub://provider/v1?type=xtream&name=My%20Xtream&host=https%3A%2F%2Fexample.com%3A8080&user=USER&pass=PASS

# M3U URL
iptvhub://provider/v1?type=m3u&name=My%20Playlist&url=https%3A%2F%2Fexample.com%2Fplaylist.m3u

# Stalker
iptvhub://provider/v1?type=stalker&name=My%20Stalker&portal=https%3A%2F%2Fexample.com%2Fc%2F&mac=00:1A:79:XX:XX:XX
```

### Import flow

1. User opens **Settings → Providers → Import QR**.
2. The frontend opens a camera modal (Tauri's `tauri-plugin-camera` —
   added as a dep in the impl PR).
3. The scanner decodes the QR locally (via `jsqr` shipped in the frontend
   bundle — no network round-trip). The decoded URI never leaves the
   process until the user confirms.
4. The modal renders a confirmation pane showing:
   - Provider `name`
   - Provider `kind`
   - `host` (full)
   - `username` (full) **OR** redacted preview for `m3u`/`stalker`
   - **The password / URL is NEVER shown back to the user. The display says "Password: ●●●●● (will be stored in keychain)".**
5. User clicks **Save**. The frontend invokes `provider_add`. The backend:
   - Validates schema (required fields per `kind`).
   - Probes the provider (Xtream Codes: `<host>/player_api.php?action=get_account_info` — read-only, no streams fetched).
   - Writes `Provider` to manifest (with `last_validated_at` if probe passes).
   - Writes `ProviderCreds` to keychain under
     `service=com.iptvhub.provider`, `account=<provider.id>`.
   - Returns success / probe-error to the frontend.

A QR code from any other source (`https://`, `mailto:`, plain text)
triggers the scanner's error toast: *"QR doesn't look like an IPTV-Hub
provider"*. The decoded string is not surfaced verbatim.

### Manual import

For users without a phone-issued QR, the same modal has a **Paste URI**
tab that accepts a literal `iptvhub://provider/v1?...` string. The same
validation pipeline runs. This is what most users will use first; QR is
for "I have it on my phone and want to migrate to the desktop".

## Backend Tauri commands (added by the impl PR)

```rust
#[tauri::command]
async fn provider_list(state: State<'_, AppState>) -> Result<Vec<Provider>, CoreError>;

/// Decodes a `iptvhub://provider/v1?...` URI, validates, probes, persists
/// metadata to manifest and secret to keychain. Errors if the URI is
/// malformed or the probe fails (when probe is requested).
#[tauri::command]
async fn provider_add(
    state: State<'_, AppState>,
    uri: String,
    probe: bool,
) -> Result<Provider, CoreError>;

#[tauri::command]
async fn provider_delete(state: State<'_, AppState>, id: String) -> Result<(), CoreError>;

/// Re-runs the probe against the stored credentials. Returns
/// `last_validated_at` on success.
#[tauri::command]
async fn provider_validate(state: State<'_, AppState>, id: String)
    -> Result<String, CoreError>;
```

There is intentionally NO `provider_get_creds` IPC command. The frontend
cannot read credentials back. The only consumer is the launcher's
internal `resolve_creds_for_app` function, which lives in the Rust binary
and is not exposed via IPC.

## Launcher integration (the e2e flow)

When the user clicks **Launch** on an app card:

1. `commands::launch::launch(app_id)` resolves the `AppEntry` from the
   manifest.
2. If `app_entry.provider_adapter` is `None`, the launcher proceeds as
   today (no credential injection). Existing 25-28 apps continue to work.
3. If present:
   1. Look up `provider_adapter.uses_provider` in `manifest.providers`.
      Missing → log an activity-log warning, proceed without creds.
   2. Pull the `ProviderCreds` from keychain via the `keyring` crate.
      Missing → same as above.
   3. Resolve every placeholder in the injection template.
   4. Apply the injection:
      - `EnvVar`  → merge into the spawned process's env.
      - `LocalStorageSeed` → on Tauri webview, `window.localStorage.setItem`
        each key right after navigation (before any app script runs).
      - `UrlQuery` → append to the launch URL.
      - `M3uFile` → write the resolved template to the per-launch cache,
        return its path via env var, register a `Drop` guard that deletes
        the file when the launcher's child handle exits.
4. The resolved cred values are kept in memory only for the duration of
   `launch()`. The launcher does not stash them in any long-lived state.

## Per-app adapter examples (real catalogue entries)

```jsonc
// frontend/src/lib/api.ts type extension, mirrored on the Rust side via serde.
// Example: iptvnator wants Xtream credentials as env vars at compose level.
{
  "id": "iptvnator",
  "name": "IPTVnator",
  "type": "web",
  // ... existing fields ...
  "provider_adapter": {
    "uses_provider": "xtremehd-primary",
    "injection": {
      "kind": "env-var",
      "vars": {
        "DEFAULT_M3U_URL": "{xtream.m3u_url}",
        "DEFAULT_EPG_URL": "{xtream.xmltv_url}"
      }
    }
  }
}

// Example: tvapp wants the M3U URL pasted into localStorage so its existing
// "Add playlist" UI is pre-populated.
{
  "id": "tvapp",
  "provider_adapter": {
    "uses_provider": "xtremehd-primary",
    "injection": {
      "kind": "local-storage-seed",
      "keys": {
        "playlist_url": "{xtream.m3u_url}",
        "epg_url":      "{xtream.xmltv_url}"
      }
    }
  }
}

// Example: stalker-ui needs the Stalker portal and MAC.
{
  "id": "stalker-ui",
  "provider_adapter": {
    "uses_provider": "apollo-group-secondary",
    "injection": {
      "kind": "env-var",
      "vars": {
        "PORTAL_URL": "{stalker.portal_url}",
        "MAC":        "{stalker.mac}"
      }
    }
  }
}
```

The current `schema/examples/full-28-apps.json` will be updated by the
impl PR to demonstrate each adapter kind on at least one real entry.

## Schema additions

`schema/apps.schema.json` gets two new top-level keys plus a per-app key:

```jsonc
{
  // ...
  "properties": {
    "providers": {
      "type": "array",
      "items": { "$ref": "#/$defs/Provider" },
      "uniqueItems": true,
      "default": []
    },
    "apps": {
      "type": "array",
      "items": {
        // existing AppEntry schema, plus:
        "properties": {
          "provider_adapter": { "$ref": "#/$defs/ProviderAdapter" }
        }
      }
    }
  },
  "$defs": {
    "Provider": { /* schema for the Provider struct above */ },
    "ProviderAdapter": { /* schema for the ProviderAdapter struct above */ }
  }
}
```

Manifest schema version bumps to `2`. The existing v0→v1 migration runner
in `src-tauri/src/manifest/migrations/` gets a v1→v2 module that:
- Adds an empty `providers: []` to existing manifests.
- Leaves `provider_adapter` absent on every existing AppEntry (so existing
  apps continue to launch without credential injection).

## Frontend UI

`Settings → Providers` tab (new). Component sketch:

```text
┌────────────────────────────────────────────────────────────────┐
│ Providers                                          [+ Add]     │
├────────────────────────────────────────────────────────────────┤
│ ╭─────────────────────────────────────────────────────────────╮│
│ │ ★  XtremeHD                                  [Validate] [×] ││
│ │    Xtream Codes · https://<your-provider-host>:8080         ││
│ │    Last validated: 2 hours ago                              ││
│ ╰─────────────────────────────────────────────────────────────╯│
│ ╭─────────────────────────────────────────────────────────────╮│
│ │    Apollo Group                              [Validate] [×] ││
│ │    Stalker · portal.example.com                             ││
│ │    Last validated: never                                    ││
│ ╰─────────────────────────────────────────────────────────────╯│
│                                                                │
│ Apps using XtremeHD (8):                                       │
│ • iptvnator        • tvapp         • smart-iptv-web ...        │
└────────────────────────────────────────────────────────────────┘
```

**+ Add** opens the import modal with two tabs: **Scan QR** (camera) and
**Paste URI** (textarea). Save → `provider_add` IPC. Errors render inline.

The list never exposes a "show password" affordance. The only path to
read a credential is via the launcher's internal injection, which the
user never sees.

## Implementation plan (sequenced PRs)

| Phase | Scope | Branch | Acceptance |
|---|---|---|---|
| 1 | Schema additions + Rust types + v1→v2 migration | `feat/provider-vault-schema` | `cargo test`; `JSON schema + examples` CI green |
| 2 | Backend `provider_*` commands + keyring integration | `feat/provider-vault-backend` | New `tests/integration_provider.rs` exercising add → list → validate → delete against a stub local Xtream server. Real keyring writes on the test runner. |
| 3 | Frontend Providers tab + paste-URI flow (no camera yet) | `feat/provider-vault-frontend` | Playwright spec drives the add/list/delete flow; screenshot added to `docs/screenshots/` |
| 4 | QR scanner integration | `feat/provider-vault-qr` | Manual demo screenshot of camera modal; jsqr dep added; no regressions |
| 5 | Launcher integration + adapter resolution | `feat/provider-vault-launcher` | New integration test that launches an app with a stub provider and asserts the right env vars / localStorage seeds are present |
| 6 | Per-app adapter entries in the catalogue + docs update | `feat/provider-vault-catalogue` | `schema/examples/full-28-apps.json` updated for every Xtream / M3U / Stalker capable app; tests still green |

Each phase ships as a separate PR with its own proof bundle. No phase
short-circuits — Phase 5 cannot land without Phase 1's schema, etc.

## What this design explicitly does NOT do

- Does not store any provider credential outside the OS keychain.
- Does not show passwords back to the user in any UI.
- Does not ship any provider's credentials in the catalogue.
- Does not auto-discover or auto-import providers from the network.
- Does not implement any DRM workarounds, premium-channel unlocking,
  or content-scraping logic.
- Does not interpret any provider's terms of service. It assumes the
  user has the legal right to use the credentials they enter.
- Does not support sharing of credentials between machines (the keychain
  binding is per-OS-user; cross-device sync is intentionally out of
  scope).
