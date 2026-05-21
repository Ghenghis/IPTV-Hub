# IPTV Hub — Security Audit Baseline

Snapshot taken 2026-05-21 (post-Phase 3). Re-run by CI on every push via
[.github/workflows/security.yml](./.github/workflows/security.yml).

CONTRACT.md §3 ("Security" Definition of Done) requires:

> `cargo audit` and `npm audit --omit=dev`: no unaddressed `critical` or `high` advisories.

This baseline documents what each tool returns today and why each entry is
either resolved, acknowledged, or out-of-scope.

## 1. `cargo audit` — 1 advisory, 18 unmaintained warnings

### Advisory: RUSTSEC-2023-0071 — Marvin Attack (rsa 0.9.10)

| Field | Value |
| --- | --- |
| Severity | **5.9 (medium)** — does not breach the contract's critical/high bar. |
| Type | Timing sidechannel; theoretical key-recovery against RSA private keys via repeated, observed decryption operations. |
| Status upstream | **No fixed upgrade available.** Waiting on the `rsa` crate maintainer; tracked at <https://github.com/RustCrypto/RSA/issues/19>. |
| Path into our tree | `rsa` ← `sqlx-mysql` ← `sqlx-macros-core` ← `sqlx-macros` ← `sqlx` ← `iptv-hub`. |
| Why we are exposed | `sqlx`'s `mysql` feature is part of the macro infrastructure even when our binary only uses the `sqlite` feature. The vulnerable code is only reached when an `RsaPrivateKey` is used to decrypt MySQL caching_sha2 passwords — IPTV Hub does **not** do this. |
| Mitigation | The IPTV Hub runtime never instantiates `RsaPrivateKey` or any path that calls into the vulnerable `pkcs1v15_decrypt` code. The advisory is a build-time dependency only; runtime is unaffected. |
| Action | **Accept** as a low-impact transitive advisory until sqlx adopts the fixed `rsa` version. Re-evaluate at every Cargo.lock bump. |
| Suppression for CI | `cargo audit --ignore RUSTSEC-2023-0071` (config in `.cargo/audit.toml` if/when added). |

### 18 unmaintained warnings — gtk-rs GTK3 bindings

Crates: `atk`, `atk-sys`, `gdk`, `gdk-sys`, `gdkx11`, `gdkx11-sys`, `gdk-pixbuf`,
`gdk-pixbuf-sys`, `gio`, `gio-sys`, `glib`, `glib-sys`, `gobject-sys`, `gtk`,
`gtk-sys`, `pango`, `pango-sys`, `cairo-rs` — all flagged `RUSTSEC-2024-04xx` as
"gtk-rs GTK3 bindings — no longer maintained".

Path into our tree: `wry` → `tauri-runtime-wry` → `tauri` → IPTV Hub. These are
the GTK3 bindings Tauri's WebView uses on Linux. **They are not compiled on
Windows** (`#[cfg(target_os = "linux")]` in wry). Since the CONTRACT (§1) names
Windows 11 as the primary platform and `cargo tauri build --target
x86_64-pc-windows-msvc` does not pull these crates into the actual MSI, the
warnings are effectively no-ops for our shipped artifact.

When Tauri 3 switches Linux webview to GTK4 the warnings disappear upstream.
**Acknowledged, no action.**

## 2. `npm audit --omit=dev` — clean

```
found 0 vulnerabilities
```

The only production dependency under `frontend/package.json` is
`@tauri-apps/api`. Everything else (eslint, prettier, typescript, vite,
lefthook, etc.) is a devDependency and outside the `--omit=dev` scope.

## 3. Operating posture

- **Secrets**: never on disk in tracked files. `G:\private\.env.deploy` (operator
  workstation) and a sibling at `C:\Users\Admin\Downloads\VPS\.env.deploy` hold
  the VPS credentials; both are excluded from git and from any chat transcript
  per the memory rule [`reference_hostinger_vps.md`](C:/Users/Admin/.claude/projects/G--Github-IPTV-Hub/memory/reference_hostinger_vps.md).
  GitHub tokens for the release source go through the OS keychain via the
  `keyring` crate (see `src-tauri/Cargo.toml`).
- **Shell allowlist**: every subprocess we spawn is from a fixed list — `git`,
  `npm`/`npm.cmd`, `msiexec.exe`, `tizen`, `cmd`/`open`/`xdg-open`, `tasklist`,
  `pgrep`, `sdb`. Verified by audit on 2026-05-21.
- **Filesystem scope**: every `tokio::fs` / `std::fs` write is rooted at
  `cache/`, `upstream/`, `user-data/`, `apps_root/`, or `logs/`. See
  `src-tauri/src/paths.rs`.
- **Network downloads**: SHA-256 verified by every source that has a published
  digest. See `src-tauri/src/sources/{release,installer,tizen}.rs`.
- **VPS deployment**: nginx fragments are validated with a sandboxed `nginx -t`
  against a mirror conf.d before being copied into `/etc/nginx/conf.d/`. If
  validation fails, the new fragments are not installed. See
  `deploy/scripts/deploy.py`.

## 4. Re-audit schedule

- On every `Cargo.lock` change → `cargo audit` runs in CI.
- On every `package-lock.json` change → `npm audit` runs in CI.
- Monthly: dependabot opens PRs for cargo + npm + github-actions, which trigger
  the same gate.

If a new advisory appears at `high` or `critical` severity for a crate we pull
into the **runtime** binary, the build fails until the advisory is either
suppressed (with documented justification here) or fixed.
