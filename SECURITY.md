# IPTV Hub — Security

## Threat model

IPTV Hub is a **local-only desktop app** that downloads, installs, and runs **third-party
code** on the user's machine. The threat surface is mostly the supply chain and the local
file system.

### Assets

| Asset | Why it matters |
| --- | --- |
| `apps.json` manifest | Tells the app what to download and run. If forged, attacker chooses the binary. |
| `cache/installers/` | Holds downloaded MSI/EXE before install. If swapped, attacker controls install. |
| `user-data/` | Personal IPTV configs, may contain provider credentials. |
| GitHub PAT (if set) | Could be exfiltrated and used against the user's GitHub account. |
| Windows registry write access | Installer-source updates write per-user uninstall keys. |

### Adversaries

1. **Compromised upstream repo** — an app the user tracks gets backdoored.
2. **Network attacker** — MITM between user and GitHub / vendor.
3. **Local malware on the same box** — wants to read user-data or the keychain.
4. **Malicious manifest entry** — user is tricked into adding a source pointing at a bad URL.

## Mitigations

### Supply-chain integrity

- **SHA-256 verification** of every release artifact against the digest published in the
  GitHub release metadata, where available. Apps without a published digest are marked
  `verified: false` in the UI and require manual confirmation per update.
- **HTTPS-only** for all sources. Plain `http://` URLs in the manifest fail validation.
- **Fast-forward-only** for git sources. A force-push from upstream is detected and the
  update is refused, with a clear UI warning. The user must explicitly choose
  "Reset to upstream" to proceed.
- **No `curl | sh`-style execution.** Downloaded binaries are stored, hashed, recorded in
  the database, and only then executed.

### Filesystem isolation

- The Tauri `fs` allowlist restricts access to four roots:
  `cache/`, `upstream/`, `user-data/`, and the binary's own data dir.
- Anything outside these roots is rejected by the Tauri allowlist before the Rust handler
  is reached.
- Each source's `apply` step runs in a working dir owned by that source; no source can
  write to another source's `upstream/<otherapp>/` directory.

### Process execution

- Spawning a process is funneled through `src-tauri/src/launcher.rs`, which:
  - Resolves the binary path against a per-app allowlist declared in the manifest.
  - Rejects any argument starting with `-` that wasn't declared in `manifest.launch.args`.
  - Sets `CREATE_NO_WINDOW` for non-UI helpers on Windows.
  - Captures stdout/stderr to the activity log; never echoes them into a shell.
- No shell interpolation. `cmd.exe` and `powershell.exe` are never invoked for arbitrary
  strings; we use `tokio::process::Command::new(...)` with separate args.

### Secrets

- GitHub personal access tokens are stored via `keyring-rs` in the Windows Credential
  Manager. They are read on demand for the duration of a single API call.
- Tokens are **never** written to `apps.json`, log files, the activity log, or telemetry.
- Tokens are **never** passed to subprocesses via environment unless the manifest explicitly
  declares `requires_github_auth: true`, in which case the token is passed only to that
  specific subprocess.

### Manifest validation

- Every `apps.json` write is preceded by JSON Schema validation against
  [`schema/apps.schema.json`](./schema/apps.schema.json).
- The manifest cannot reference paths outside the configured `apps-root`.
- Source URLs are constrained by an allowlist of hosts in `config.toml`:
  `["github.com", "gitlab.com", "raw.githubusercontent.com", ...]`. The user can extend the
  list explicitly.

### Rollback

- Every update writes a snapshot **before** any destructive action. If anything fails before
  `commit`, rollback is automatic.
- Snapshots are tar.zst archives under `cache/rollback/<app-id>/`. Retention is configurable
  (default 7 days), enforced by a daily sweep.

## What we do not protect against

These are explicitly out of scope for v1. They are documented so the user can make their
own risk decision.

- **A malicious app installed via the launcher.** If the user adds a manifest entry pointing
  at a malicious source and confirms the install, the malware runs. IPTV Hub is a launcher,
  not an antivirus.
- **Local-root attackers.** A process running as the user can read the user's files and
  spoof the keychain. Defence is OS-level.
- **Side-channel timing attacks** on the sha256 verification path. The library used is the
  standard `sha2` crate; if a stronger constant-time comparison is needed in future, it
  will be added.

## Reporting

Email security reports to `<owner-email>` (replace at first publish). Do not file public
issues for security bugs.

## Dependency hygiene

- `cargo audit` runs in CI on every PR; CI fails on any unaddressed `critical` or `high`
  advisory.
- `npm audit --omit=dev` runs in CI for the frontend; same gate.
- Dependabot is configured in `.github/dependabot.yml` (Agent 20).

## Code-signing

- v1 ships unsigned MSIs with a SHA-256 published next to each release. Users verify
  manually.
- Code-signing certificates are on the roadmap (v0.3). Until then, the release pipeline
  prints the SHA-256 of every artifact at the end of the build.
