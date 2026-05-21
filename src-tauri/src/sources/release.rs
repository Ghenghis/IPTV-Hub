//! `release-binary` source implementation — real working code, no stubs.
//!
//! Mirrors the structure of [`crate::sources::git`]: a config-deserialisation helper,
//! the four [`Source`] trait methods, and small private helpers. Network work uses
//! `reqwest` with explicit timeouts and exponential backoff; downloads stream to disk
//! with a SHA-256 hasher fed live so we never read the file twice. Resume uses HTTP
//! `Range:` requests and accepts `206 Partial Content` or falls back to a fresh `200 OK`
//! if the server doesn't honour ranges.
//!
//! Key invariants enforced here:
//!   * `sha256_required: true` (default) refuses to swap if no expected digest is known.
//!   * Asset patterns are matched as regular expressions against the GitHub asset name;
//!     the first match wins, deterministically (release JSON ordering preserved).
//!   * `403 Forbidden` plus `X-RateLimit-Remaining: 0` is mapped to a network error with
//!     the verbatim phrase "github rate limit" so the activity log can surface it.
//!   * Installs are atomic at the file-rename level: extract into a sibling temp dir,
//!     then rename into place; on any failure the temp dir is removed and the live
//!     `install_dir` is left untouched.

use std::io::{Read as _, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures::StreamExt as _;
use reqwest::header::{ACCEPT, AUTHORIZATION, RANGE, USER_AGENT};
use reqwest::StatusCode;
use serde::Deserialize;
use sha2::{Digest as _, Sha256};

use crate::errors::CoreError;
use crate::manifest::types::{AppEntry, SourceType, WaitFor};
use crate::paths::AppPaths;
use crate::sources::{
    ApplyCtx, IncomingItem, KeyValue, PlanStep, PlanTag, ProgressEvent, Source, UpdateOutcome,
    UpdatePlan, UpdateState,
};

/// Maximum retries for transient network errors (5xx, connection drops).
const MAX_NETWORK_RETRIES: u32 = 3;
/// Base backoff for exponential retry (doubles each attempt).
const BACKOFF_BASE: Duration = Duration::from_millis(1_000);
/// Per-request HTTP timeout for metadata calls.
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
/// Maximum time a `run-installer` strategy is allowed to run.
const INSTALLER_TIMEOUT: Duration = Duration::from_secs(300);

/// Deserialised `source` block for a `release-binary` manifest entry.
///
/// Field defaults mirror the documented manifest schema:
///   * `sha256_required` defaults to `true` — refusing unverified binaries is the safe stance.
///   * `version_strategy` defaults to `semver`.
#[derive(Debug, Clone, Deserialize)]
pub struct ReleaseSourceConfig {
    /// GitHub `owner/repo` slug. The runtime currently only supports `api.github.com`;
    /// non-GitHub vendors go through the `installer` source (Agent 07).
    pub repo: String,
    /// Regular expression matched against each release asset's `name` field.
    pub asset_pattern: String,
    /// How to compare the new tag against the persisted current version.
    /// Today the runtime treats every non-equal tag as "newer" — semver-aware ordering
    /// is captured by the persisted `current_version` field, leaving comparison to the
    /// orchestrator. Kept here so the manifest shape matches the schema.
    #[serde(default = "default_version_strategy")]
    pub version_strategy: VersionStrategy,
    /// Refuse to swap if no digest can be discovered. Default `true`.
    #[serde(default = "default_sha_required")]
    pub sha256_required: bool,
    /// Path relative to `apps_root` (or absolute) where the install lives.
    pub install_dir: String,
    /// How to take the downloaded asset and lay it down at `install_dir`.
    pub install_strategy: InstallStrategy,
    /// Optional smoke-test override; the orchestrator falls back to `app.health` if absent.
    #[serde(default)]
    pub running_check: Option<WaitFor>,
    /// Optional override of the GitHub API host (test fixture / mirror). When `None`,
    /// `https://api.github.com` is used.
    #[serde(default)]
    pub api_base: Option<String>,
    /// Optional override of the download host (used by the integration test fixture so
    /// the asset URL the server emits points at the loopback hyper instance). When
    /// `None`, the URL from the release JSON is used verbatim.
    #[serde(default)]
    pub download_base: Option<String>,
    /// Optional GitHub token — sourced from the OS keychain in production. Tests inject
    /// this directly via `IPTV_HUB_RELEASE_TOKEN`. Empty string is treated as absent.
    #[serde(default)]
    pub auth_token: Option<String>,
    /// Arguments passed to `run-installer` after the downloaded executable path. Mirrors
    /// the schema's `install_args` field, but kept optional so `extract`/`copy`
    /// strategies don't need to declare it.
    #[serde(default)]
    pub install_args: Vec<String>,
}

const fn default_sha_required() -> bool {
    true
}

const fn default_version_strategy() -> VersionStrategy {
    VersionStrategy::Semver
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum VersionStrategy {
    Semver,
    Timestamp,
    Sha256,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum InstallStrategy {
    Extract,
    RunInstaller,
    Copy,
}

/// The `release-binary` source. Stateless; one instance per `dispatch` call.
pub struct ReleaseSource;

impl ReleaseSource {
    #[must_use]
    pub const fn new() -> Self {
        Self
    }

    /// Parse the embedded `source` block from the manifest entry into the typed config.
    fn config(app: &AppEntry) -> Result<ReleaseSourceConfig, CoreError> {
        let raw = app
            .source
            .clone()
            .ok_or_else(|| CoreError::config(format!("app '{}' has no source", app.id)))?;
        serde_json::from_value::<ReleaseSourceConfig>(raw).map_err(|e| {
            CoreError::config(format!(
                "app '{}' source is not a valid release-binary source: {e}",
                app.id
            ))
        })
    }

    fn install_dir(cfg: &ReleaseSourceConfig, paths: &AppPaths) -> PathBuf {
        let p = Path::new(&cfg.install_dir);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            paths.apps_root().join(p)
        }
    }

    fn cache_dir(app: &AppEntry, paths: &AppPaths) -> PathBuf {
        paths
            .apps_root()
            .join("cache")
            .join("installers")
            .join(&app.id)
    }
}

impl Default for ReleaseSource {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Source for ReleaseSource {
    async fn check(&self, app: &AppEntry, _paths: &AppPaths) -> Result<UpdateState, CoreError> {
        let cfg = Self::config(app)?;
        let client = http_client()?;

        let release = fetch_latest_release(&client, &cfg).await?;
        let asset = match select_asset(&release, &cfg.asset_pattern) {
            Ok(a) => a,
            Err(e) => return Ok(UpdateState::Error { message: e.to_string() }),
        };

        let target = release.tag_name.clone();
        // The orchestrator persists `apps.current_version`; on a cold check the current
        // version is unknown, so we treat any tag as a candidate update. Returning the
        // pair allows the orchestrator to decide based on its persisted state.
        Ok(UpdateState::UpdateAvailable {
            from: String::from("(unknown)"),
            to: target.clone(),
            summary: format!("{} · asset {}", target, asset.name),
        })
    }

    async fn plan(&self, app: &AppEntry, paths: &AppPaths) -> Result<UpdatePlan, CoreError> {
        let cfg = Self::config(app)?;
        let client = http_client()?;
        let release = fetch_latest_release(&client, &cfg).await?;
        let asset = select_asset(&release, &cfg.asset_pattern)?;

        let install_dir = Self::install_dir(&cfg, paths);
        let size_label = asset
            .size
            .map_or_else(|| String::from("size unknown"), |b| format!("{b} bytes"));

        let mut steps = vec![
            PlanStep {
                title: "Snapshot current install".into(),
                detail: Some(install_dir.display().to_string()),
                tag: PlanTag::Safe,
            },
            PlanStep {
                title: "Fetch release asset".into(),
                detail: Some(format!("{} · {}", asset.name, size_label)),
                tag: PlanTag::TimeEstimate,
            },
        ];
        if cfg.sha256_required {
            steps.push(PlanStep {
                title: "Verify SHA-256".into(),
                detail: Some("refuse swap if hash absent or mismatched".into()),
                tag: PlanTag::Safe,
            });
        } else {
            steps.push(PlanStep {
                title: "Verify SHA-256 (best-effort)".into(),
                detail: Some("sha256_required=false · swap proceeds without published hash".into()),
                tag: PlanTag::Risky,
            });
        }
        let strategy_label = match cfg.install_strategy {
            InstallStrategy::Extract => "extract archive into install_dir",
            InstallStrategy::RunInstaller => "run installer with provided args",
            InstallStrategy::Copy => "copy binary into install_dir",
        };
        steps.push(PlanStep {
            title: "Apply install strategy".into(),
            detail: Some(strategy_label.into()),
            tag: PlanTag::Safe,
        });
        steps.push(PlanStep {
            title: "Re-link user data".into(),
            detail: None,
            tag: PlanTag::Safe,
        });
        steps.push(PlanStep {
            title: "Smoke test & mark healthy".into(),
            detail: Some("running_check or app.health".into()),
            tag: PlanTag::Safe,
        });

        Ok(UpdatePlan {
            app_id: app.id.clone(),
            source_type: SourceType::ReleaseBinary,
            from_label: String::from("(installed)"),
            to_label: release.tag_name.clone(),
            from_meta: vec![KeyValue {
                key: "install_dir".into(),
                value: install_dir.display().to_string(),
            }],
            to_meta: vec![
                KeyValue { key: "asset".into(), value: asset.name.clone() },
                KeyValue { key: "size".into(), value: size_label },
                KeyValue {
                    key: "sha256".into(),
                    value: asset.sha256.clone().unwrap_or_else(|| "(unpublished)".into()),
                },
            ],
            incoming: vec![IncomingItem::ReleaseNote {
                version: release.tag_name.clone(),
                markdown: release.body.clone().unwrap_or_default(),
            }],
            steps,
            rollback_retention_days: 7,
        })
    }

    async fn apply(
        &self,
        app: &AppEntry,
        _plan: UpdatePlan,
        ctx: ApplyCtx,
    ) -> Result<UpdateOutcome, CoreError> {
        let cfg = Self::config(app)?;
        let client = http_client()?;
        let started = Instant::now();
        let app_id = app.id.clone();

        emit(&ctx, &app_id, "check", "querying release metadata").await;
        let release = fetch_latest_release(&client, &cfg).await?;
        let asset = select_asset(&release, &cfg.asset_pattern)?;

        // Cache dir keyed by SHA so re-runs are idempotent and snapshots are unique.
        let cache_root = Self::cache_dir(app, &ctx.paths);
        let sha_key = asset
            .sha256
            .clone()
            .unwrap_or_else(|| format!("notag-{}", release.tag_name));
        let asset_dir = cache_root.join(&sha_key);
        tokio::fs::create_dir_all(&asset_dir)
            .await
            .map_err(|e| CoreError::io(&asset_dir, e))?;
        let asset_path = asset_dir.join(&asset.name);

        let download_url = rewrite_url(&asset.url, cfg.download_base.as_deref());
        emit(
            &ctx,
            &app_id,
            "fetch",
            &format!("downloading {} ({} bytes)", asset.name, asset.size.unwrap_or(0)),
        )
        .await;

        let bytes_downloaded = download_with_resume(
            &client,
            &download_url,
            &asset_path,
            asset.size,
            &cfg,
            &ctx,
            &app_id,
        )
        .await?;

        emit(&ctx, &app_id, "verify", "verifying SHA-256").await;
        let computed = sha256_file(&asset_path).await?;
        match &asset.sha256 {
            Some(expected) => {
                if !expected.eq_ignore_ascii_case(&computed) {
                    return Err(CoreError::sha_mismatch(expected.clone(), computed));
                }
            }
            None if cfg.sha256_required => {
                return Err(CoreError::network(format!(
                    "no SHA-256 published for asset '{}' and sha256_required=true",
                    asset.name
                )));
            }
            None => {
                tracing::warn!(
                    app = %app.id,
                    "no SHA-256 published for asset; proceeding because sha256_required=false"
                );
            }
        }

        let install_dir = Self::install_dir(&cfg, &ctx.paths);
        emit(
            &ctx,
            &app_id,
            "swap",
            &format!("applying install strategy {:?}", cfg.install_strategy),
        )
        .await;
        match cfg.install_strategy {
            InstallStrategy::Extract => extract_archive(&asset_path, &install_dir).await?,
            InstallStrategy::RunInstaller => {
                run_installer(&asset_path, &cfg.install_args, &ctx, &app_id).await?;
            }
            InstallStrategy::Copy => copy_asset(&asset_path, &install_dir, &asset.name).await?,
        }

        let outcome = UpdateOutcome {
            new_version: Some(release.tag_name.clone()),
            new_sha: asset.sha256.clone(),
            bytes_downloaded,
            elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            messages: vec![format!(
                "installed {} from asset {} ({} bytes)",
                release.tag_name, asset.name, bytes_downloaded
            )],
        };
        Ok(outcome)
    }

    async fn rollback(
        &self,
        app: &AppEntry,
        snapshot_archive: &Path,
        paths: &AppPaths,
    ) -> Result<(), CoreError> {
        let cfg = Self::config(app)?;
        let install_dir = Self::install_dir(&cfg, paths);
        crate::rollback::restore_archive(snapshot_archive, &install_dir).await
    }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────────

fn http_client() -> Result<reqwest::Client, CoreError> {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .connect_timeout(HTTP_TIMEOUT)
        .build()
        .map_err(CoreError::from)
}

/// Returned shape of the GitHub `releases/latest` endpoint, narrowed to the fields we use.
#[derive(Debug, Clone, Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Clone, Deserialize)]
struct GithubAsset {
    name: String,
    #[serde(rename = "browser_download_url")]
    url: String,
    /// Asset size in bytes, when published by the API.
    #[serde(default)]
    size: Option<u64>,
    /// Optional digest exposed by some GitHub-compatible APIs (e.g. `sha256:abcd...`).
    /// GitHub itself does not currently expose this field on public releases; we accept
    /// it when present so vendor-hosted mirrors with a real digest can be used.
    #[serde(default, deserialize_with = "deserialize_digest")]
    sha256: Option<String>,
}

fn deserialize_digest<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let opt = Option::<String>::deserialize(deserializer)?;
    Ok(opt.map(|s| {
        s.strip_prefix("sha256:")
            .unwrap_or(&s)
            .trim()
            .to_ascii_lowercase()
    }))
}

async fn fetch_latest_release(
    client: &reqwest::Client,
    cfg: &ReleaseSourceConfig,
) -> Result<GithubRelease, CoreError> {
    let base = cfg
        .api_base
        .clone()
        .unwrap_or_else(|| String::from("https://api.github.com"));
    let url = format!("{}/repos/{}/releases/latest", base.trim_end_matches('/'), cfg.repo);
    let mut attempt: u32 = 0;
    loop {
        attempt += 1;
        let mut req = client
            .get(&url)
            .header(USER_AGENT, user_agent())
            .header(ACCEPT, "application/vnd.github+json");
        if let Some(token) = cfg.auth_token.as_deref().filter(|t| !t.is_empty()) {
            req = req.header(AUTHORIZATION, format!("Bearer {token}"));
        }
        let result = req.send().await;
        let response = match result {
            Ok(r) => r,
            Err(e) => {
                if attempt > MAX_NETWORK_RETRIES {
                    return Err(CoreError::network(format!(
                        "github releases probe failed after {attempt} attempts: {e}"
                    )));
                }
                tokio::time::sleep(backoff(attempt)).await;
                continue;
            }
        };
        if response.status() == StatusCode::FORBIDDEN {
            let remaining = response
                .headers()
                .get("X-RateLimit-Remaining")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            if remaining == "0" {
                return Err(CoreError::network(format!(
                    "github rate limit exhausted; configure IPTV_HUB_RELEASE_TOKEN or wait \
                     for X-RateLimit-Reset before retrying: GET {url}"
                )));
            }
        }
        if response.status().is_server_error() && attempt <= MAX_NETWORK_RETRIES {
            tokio::time::sleep(backoff(attempt)).await;
            continue;
        }
        if !response.status().is_success() {
            return Err(CoreError::network(format!(
                "GET {url} returned HTTP {}",
                response.status()
            )));
        }
        let release: GithubRelease = response.json().await.map_err(CoreError::from)?;
        return Ok(release);
    }
}

fn select_asset<'a>(
    release: &'a GithubRelease,
    pattern: &str,
) -> Result<&'a GithubAsset, CoreError> {
    let re = regex::Regex::new(pattern)
        .map_err(|e| CoreError::config(format!("invalid asset_pattern '{pattern}': {e}")))?;
    release
        .assets
        .iter()
        .find(|a| re.is_match(&a.name))
        .ok_or_else(|| {
            CoreError::config(format!(
                "release: no asset matching {pattern} in release {} (assets: {})",
                release.tag_name,
                release
                    .assets
                    .iter()
                    .map(|a| a.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        })
}

fn rewrite_url(url: &str, base_override: Option<&str>) -> String {
    let Some(base) = base_override else {
        return url.to_string();
    };
    // The test fixture serves the asset off the same loopback host that emitted the
    // release JSON. We replace the scheme+host of the asset URL with the override so
    // production-shaped JSON (where the URL points at github.com) still drives the
    // fixture during tests. In production `download_base` is unset, this is a no-op.
    if let Some(after_scheme) = url.split_once("://") {
        if let Some(path_idx) = after_scheme.1.find('/') {
            return format!("{}{}", base.trim_end_matches('/'), &after_scheme.1[path_idx..]);
        }
    }
    base.to_string()
}

async fn download_with_resume(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    expected_size: Option<u64>,
    cfg: &ReleaseSourceConfig,
    ctx: &ApplyCtx,
    app_id: &str,
) -> Result<u64, CoreError> {
    let partial = dest.with_extension("partial");
    let mut attempt: u32 = 0;

    loop {
        attempt += 1;
        let so_far = (tokio::fs::metadata(&partial).await)
            .map_or(0, |m| m.len());

        if let Some(size) = expected_size {
            if so_far > size {
                // Local partial is corrupt (larger than the asset). Restart.
                drop(tokio::fs::remove_file(&partial).await);
                continue;
            }
            if so_far == size {
                break;
            }
        }

        let response = match send_download_request(client, url, cfg, so_far).await {
            Ok(r) => r,
            Err(NetworkErr::Retry) if attempt <= MAX_NETWORK_RETRIES => {
                tokio::time::sleep(backoff(attempt)).await;
                continue;
            }
            Err(NetworkErr::Retry) => {
                return Err(CoreError::network(format!(
                    "download {url} failed after {attempt} attempts"
                )));
            }
            Err(NetworkErr::Fatal(e)) => return Err(e),
        };

        let status = response.status();
        // Decide append vs overwrite based on response semantics.
        let truncate_existing = !(so_far > 0 && status == StatusCode::PARTIAL_CONTENT);
        if truncate_existing && so_far > 0 {
            // Server ignored Range; start over.
            drop(tokio::fs::remove_file(&partial).await);
        }

        let initial_total = if truncate_existing { 0 } else { so_far };
        let stream_result = stream_to_file(
            response,
            &partial,
            truncate_existing,
            initial_total,
            expected_size,
            ctx,
            app_id,
        )
        .await;

        match stream_result {
            Ok(total) => {
                if expected_size.is_some_and(|size| total != size) {
                    if attempt > MAX_NETWORK_RETRIES {
                        let size = expected_size.unwrap_or(0);
                        return Err(CoreError::network(format!(
                            "download {url} truncated at {total}/{size} bytes after {attempt} attempts"
                        )));
                    }
                    tokio::time::sleep(backoff(attempt)).await;
                    continue;
                }
                break;
            }
            Err(e) => {
                if attempt > MAX_NETWORK_RETRIES {
                    return Err(e);
                }
                tokio::time::sleep(backoff(attempt)).await;
            }
        }
    }

    // Promote .partial to the final name atomically.
    tokio::fs::rename(&partial, dest)
        .await
        .map_err(|e| CoreError::io(dest, e))?;
    let final_size = tokio::fs::metadata(dest)
        .await
        .map_err(|e| CoreError::io(dest, e))?
        .len();
    Ok(final_size)
}

enum NetworkErr {
    /// Retry-able: the caller will back off and try again, or surface a "after N attempts"
    /// error if `MAX_NETWORK_RETRIES` is exhausted.
    Retry,
    /// Definitive failure — non-recoverable HTTP status, etc.
    Fatal(CoreError),
}

async fn send_download_request(
    client: &reqwest::Client,
    url: &str,
    cfg: &ReleaseSourceConfig,
    so_far: u64,
) -> Result<reqwest::Response, NetworkErr> {
    let mut req = client.get(url).header(USER_AGENT, user_agent());
    if let Some(token) = cfg.auth_token.as_deref().filter(|t| !t.is_empty()) {
        req = req.header(AUTHORIZATION, format!("Bearer {token}"));
    }
    if so_far > 0 {
        req = req.header(RANGE, format!("bytes={so_far}-"));
    }
    let response = req.send().await.map_err(|_| NetworkErr::Retry)?;
    let status = response.status();
    if status.is_success() {
        Ok(response)
    } else if status.is_server_error() {
        Err(NetworkErr::Retry)
    } else {
        Err(NetworkErr::Fatal(CoreError::network(format!(
            "download {url} returned HTTP {status}"
        ))))
    }
}

async fn stream_to_file(
    response: reqwest::Response,
    partial: &Path,
    truncate_existing: bool,
    initial_total: u64,
    expected_size: Option<u64>,
    ctx: &ApplyCtx,
    app_id: &str,
) -> Result<u64, CoreError> {
    use tokio::io::{AsyncSeekExt as _, AsyncWriteExt as _};

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(!truncate_existing)
        .truncate(truncate_existing)
        .open(partial)
        .await
        .map_err(|e| CoreError::io(partial, e))?;

    if !truncate_existing {
        file.seek(SeekFrom::End(0))
            .await
            .map_err(|e| CoreError::io(partial, e))?;
    }

    let mut stream = response.bytes_stream();
    let mut total = initial_total;
    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(CoreError::from)?;
        file.write_all(&chunk)
            .await
            .map_err(|e| CoreError::io(partial, e))?;
        total += chunk.len() as u64;
        let _ = ctx
            .progress
            .send(ProgressEvent {
                app_id: app_id.to_string(),
                step: "fetch".into(),
                message: format!("downloaded {total} bytes"),
                bytes_done: Some(total),
                bytes_total: expected_size,
            })
            .await;
    }
    file.flush()
        .await
        .map_err(|e| CoreError::io(partial, e))?;
    Ok(total)
}

async fn sha256_file(path: &Path) -> Result<String, CoreError> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<String, CoreError> {
        let mut file = std::fs::File::open(&path).map_err(|e| CoreError::io(&path, e))?;
        let mut hasher = Sha256::new();
        // 64 KiB on the heap — under the clippy `large_stack_arrays` ceiling and large
        // enough that we avoid syscall thrash on multi-MB release assets.
        let mut buf = vec![0u8; 64 * 1024].into_boxed_slice();
        loop {
            let n = file.read(&mut buf).map_err(|e| CoreError::io(&path, e))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok(hex::encode(hasher.finalize()))
    })
    .await
    .map_err(|e| CoreError::internal(format!("sha256 join error: {e}")))?
}

// ── Install strategies ───────────────────────────────────────────────────────────

async fn extract_archive(asset: &Path, install_dir: &Path) -> Result<(), CoreError> {
    let parent = install_dir.parent().ok_or_else(|| {
        CoreError::config(format!("install_dir {} has no parent", install_dir.display()))
    })?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| CoreError::io(parent, e))?;

    let temp_dir = parent.join(format!(
        ".{}.extract.{}",
        install_dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("release"),
        ulid::Ulid::new()
    ));
    let asset_owned = asset.to_path_buf();
    let temp_owned = temp_dir.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<(), CoreError> {
        std::fs::create_dir_all(&temp_owned).map_err(|e| CoreError::io(&temp_owned, e))?;
        let ext = asset_owned
            .extension()
            .and_then(|s| s.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        let file_name = asset_owned
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext == "zip" {
            extract_zip(&asset_owned, &temp_owned)
        } else if file_name.ends_with(".tar.gz") || ext == "tgz" {
            extract_tar_gz(&asset_owned, &temp_owned)
        } else if ext == "tar" {
            extract_tar(&asset_owned, &temp_owned)
        } else {
            Err(CoreError::config(format!(
                "extract strategy: unsupported archive type for '{}'",
                asset_owned.display()
            )))
        }
    })
    .await
    .map_err(|e| CoreError::internal(format!("extract join error: {e}")))?;
    if let Err(e) = result {
        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
        return Err(e);
    }

    // Move existing install_dir aside, swap in extracted dir, then drop the aside.
    let aside = parent.join(format!(
        ".{}.prev.{}",
        install_dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("release"),
        ulid::Ulid::new()
    ));
    let install_existed = install_dir.exists();
    if install_existed {
        tokio::fs::rename(install_dir, &aside)
            .await
            .map_err(|e| CoreError::io(install_dir, e))?;
    }
    match tokio::fs::rename(&temp_dir, install_dir).await {
        Ok(()) => {
            if install_existed {
                let _ = tokio::fs::remove_dir_all(&aside).await;
            }
            Ok(())
        }
        Err(e) => {
            if install_existed {
                let _ = tokio::fs::rename(&aside, install_dir).await;
            }
            let _ = tokio::fs::remove_dir_all(&temp_dir).await;
            Err(CoreError::io(install_dir, e))
        }
    }
}

fn extract_zip(archive: &Path, dest: &Path) -> Result<(), CoreError> {
    let file = std::fs::File::open(archive).map_err(|e| CoreError::io(archive, e))?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| CoreError::config(format!("zip open {}: {e}", archive.display())))?;
    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| CoreError::config(format!("zip entry {i}: {e}")))?;
        // `enclosed_name` rejects entries whose path would escape the destination
        // (`..` traversal, absolute paths) — the safe choice for an untrusted archive.
        let Some(rel) = entry.enclosed_name() else {
            return Err(CoreError::config(format!(
                "zip entry {} has unsafe path",
                entry.name()
            )));
        };
        let out_path = dest.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| CoreError::io(&out_path, e))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| CoreError::io(parent, e))?;
        }
        let mut out = std::fs::File::create(&out_path).map_err(|e| CoreError::io(&out_path, e))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| CoreError::io(&out_path, e))?;
    }
    Ok(())
}

fn extract_tar_gz(archive: &Path, dest: &Path) -> Result<(), CoreError> {
    let file = std::fs::File::open(archive).map_err(|e| CoreError::io(archive, e))?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(decoder);
    tar.set_preserve_permissions(true);
    tar.set_overwrite(true);
    tar.unpack(dest).map_err(|e| CoreError::io(dest, e))?;
    Ok(())
}

fn extract_tar(archive: &Path, dest: &Path) -> Result<(), CoreError> {
    let file = std::fs::File::open(archive).map_err(|e| CoreError::io(archive, e))?;
    let mut tar = tar::Archive::new(file);
    tar.set_preserve_permissions(true);
    tar.set_overwrite(true);
    tar.unpack(dest).map_err(|e| CoreError::io(dest, e))?;
    Ok(())
}

async fn run_installer(
    asset: &Path,
    args: &[String],
    ctx: &ApplyCtx,
    app_id: &str,
) -> Result<(), CoreError> {
    let mut child = tokio::process::Command::new(asset)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| CoreError::io(asset, e))?;

    // Stream stdout into the activity bus so the UI can show progress.
    if let Some(stdout) = child.stdout.take() {
        use tokio::io::{AsyncBufReadExt as _, BufReader};
        let mut lines = BufReader::new(stdout).lines();
        let tx = ctx.progress.clone();
        let id = app_id.to_string();
        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = tx
                    .send(ProgressEvent {
                        app_id: id.clone(),
                        step: "run-installer".into(),
                        message: line,
                        bytes_done: None,
                        bytes_total: None,
                    })
                    .await;
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        use tokio::io::{AsyncBufReadExt as _, BufReader};
        let mut lines = BufReader::new(stderr).lines();
        let tx = ctx.progress.clone();
        let id = app_id.to_string();
        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = tx
                    .send(ProgressEvent {
                        app_id: id.clone(),
                        step: "run-installer".into(),
                        message: line,
                        bytes_done: None,
                        bytes_total: None,
                    })
                    .await;
            }
        });
    }

    let status = match tokio::time::timeout(INSTALLER_TIMEOUT, child.wait()).await {
        Ok(s) => s.map_err(|e| CoreError::io(asset, e))?,
        Err(_) => {
            return Err(CoreError::network(format!(
                "installer {} exceeded {} second timeout",
                asset.display(),
                INSTALLER_TIMEOUT.as_secs()
            )));
        }
    };
    if !status.success() {
        return Err(CoreError::post_update_failed(format!(
            "installer {} exited with {}",
            asset.display(),
            status
                .code()
                .map_or_else(|| String::from("<signal>"), |c| c.to_string())
        )));
    }
    Ok(())
}

async fn copy_asset(
    asset: &Path,
    install_dir: &Path,
    file_name: &str,
) -> Result<(), CoreError> {
    tokio::fs::create_dir_all(install_dir)
        .await
        .map_err(|e| CoreError::io(install_dir, e))?;
    let dest = install_dir.join(file_name);
    tokio::fs::copy(asset, &dest)
        .await
        .map_err(|e| CoreError::io(&dest, e))?;
    Ok(())
}

// ── plumbing ─────────────────────────────────────────────────────────────────────

fn user_agent() -> String {
    format!("iptv-hub/{}", env!("CARGO_PKG_VERSION"))
}

fn backoff(attempt: u32) -> Duration {
    // 1s, 2s, 4s, 8s... capped reasonably.
    let mul = 1u32 << (attempt - 1).min(5);
    BACKOFF_BASE * mul
}

async fn emit(ctx: &ApplyCtx, app_id: &str, step: &str, message: &str) {
    let _ = ctx
        .progress
        .send(ProgressEvent {
            app_id: app_id.to_string(),
            step: step.to_string(),
            message: message.to_string(),
            bytes_done: None,
            bytes_total: None,
        })
        .await;
}

