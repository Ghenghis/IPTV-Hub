//! `tizen-ipk` source implementation — real working code, no stubs.
//!
//! The Tizen source is a two-phase mechanism:
//!
//!   1. **Fetch** — download a `.ipk` from GitHub Releases or a direct URL and verify
//!      its SHA-256 against an expected digest where one is available. This phase runs
//!      from the standard `apply` cycle just like the other sources.
//!   2. **Deploy** — push the cached IPK onto a real Samsung Tizen TV via the vendor's
//!      `sdb` tool. This is also driven from `apply` (the manifest is expected to set
//!      `LaunchKind::TizenDeploy` so the user explicitly issues the deploy from the card
//!      menu rather than the regular launch button). On hosts that do not have `sdb`,
//!      or where no devices are paired, the deploy step refuses with a structured error
//!      so the UI can surface the exact failure mode.
//!
//! Per CONTRACT.md §2.2 hardware exception, the integration tests stub the `sdb`
//! binary itself with a real fixture executable under `tests/fixtures/bin/sdb[.cmd]`
//! that emits realistic stdout/stderr/exit codes, but everything else in this module
//! is real code paths.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Instant;

use async_trait::async_trait;
use regex::Regex;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use crate::errors::CoreError;
use crate::manifest::types::{AppEntry, SourceType};
use crate::paths::AppPaths;
use crate::sources::{
    ApplyCtx, IncomingItem, KeyValue, PlanStep, PlanTag, ProgressEvent, Source, UpdateOutcome,
    UpdatePlan, UpdateState,
};

/// Raw manifest config for a `tizen-ipk` source. See `docs/MANIFEST_SCHEMA.md` §8.5.
#[derive(Debug, Clone, Deserialize)]
pub struct TizenSourceConfig {
    pub source_kind: TizenSourceKind,
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub asset_pattern: Option<String>,
    #[serde(default)]
    pub download_url: Option<String>,
    #[serde(default)]
    pub device_serial: Option<String>,
    #[serde(default = "default_version_strategy")]
    pub version_strategy: String,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TizenSourceKind {
    GithubRelease,
    Url,
}

fn default_version_strategy() -> String {
    "semver".to_string()
}

/// Endpoint base used for GitHub releases. Tests override this so the real code path
/// is exercised against a real local HTTP server.
const GITHUB_API_ENV: &str = "IPTV_HUB_TIZEN_GITHUB_API_BASE";
const DEFAULT_GITHUB_API_BASE: &str = "https://api.github.com";

/// Resolves the `sdb` invocation. Tests override `PATH` so this picks up the fixture
/// shim from `tests/fixtures/bin/`; production picks up the real Samsung `sdb`.
const SDB_BINARY: &str = "sdb";

#[derive(Debug, Clone)]
struct GithubRelease {
    tag_name: String,
    asset_name: String,
    asset_url: String,
    asset_size: u64,
    asset_digest: Option<String>,
    body: String,
}

pub struct TizenSource;

impl TizenSource {
    pub fn new() -> Self {
        Self
    }

    fn config(app: &AppEntry) -> Result<TizenSourceConfig, CoreError> {
        let raw = app
            .source
            .clone()
            .ok_or_else(|| CoreError::config(format!("app '{}' has no source", app.id)))?;
        let cfg: TizenSourceConfig = serde_json::from_value(raw).map_err(|e| {
            CoreError::config(format!(
                "app '{}' source is not a valid tizen-ipk source: {e}",
                app.id
            ))
        })?;
        match cfg.source_kind {
            TizenSourceKind::GithubRelease => {
                if cfg.repo.as_deref().unwrap_or("").is_empty() {
                    return Err(CoreError::config(format!(
                        "app '{}': tizen source_kind=github-release requires 'repo'",
                        app.id
                    )));
                }
                if cfg.asset_pattern.as_deref().unwrap_or("").is_empty() {
                    return Err(CoreError::config(format!(
                        "app '{}': tizen source_kind=github-release requires 'asset_pattern'",
                        app.id
                    )));
                }
            }
            TizenSourceKind::Url => {
                if cfg.download_url.as_deref().unwrap_or("").is_empty() {
                    return Err(CoreError::config(format!(
                        "app '{}': tizen source_kind=url requires 'download_url'",
                        app.id
                    )));
                }
            }
        }
        Ok(cfg)
    }

    /// Per-app cache directory where IPKs live.
    fn installer_dir(app: &AppEntry, paths: &AppPaths) -> PathBuf {
        paths
            .apps_root()
            .join("cache")
            .join("installers")
            .join(&app.id)
    }
}

impl Default for TizenSource {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Source for TizenSource {
    async fn check(&self, app: &AppEntry, _paths: &AppPaths) -> Result<UpdateState, CoreError> {
        let cfg = Self::config(app)?;
        match cfg.source_kind {
            TizenSourceKind::GithubRelease => {
                let release = fetch_github_release(
                    cfg.repo.as_deref().unwrap_or(""),
                    cfg.asset_pattern.as_deref().unwrap_or(""),
                )
                .await?;
                // We don't track a persisted current version on this slice's surface, so
                // the check reports the latest tag and lets the orchestrator decide.
                Ok(UpdateState::UpdateAvailable {
                    from: "unknown".to_string(),
                    to: release.tag_name.clone(),
                    summary: format!("{} ({})", release.asset_name, human_bytes(release.asset_size)),
                })
            }
            TizenSourceKind::Url => {
                let url = cfg.download_url.unwrap_or_default();
                let info = head_url(&url).await?;
                Ok(UpdateState::UpdateAvailable {
                    from: "unknown".to_string(),
                    to: info.etag.clone().unwrap_or_else(|| "remote".to_string()),
                    summary: format!("{} ({})", url, human_bytes(info.content_length.unwrap_or(0))),
                })
            }
        }
    }

    async fn plan(&self, app: &AppEntry, _paths: &AppPaths) -> Result<UpdatePlan, CoreError> {
        let cfg = Self::config(app)?;
        let (to_label, asset_name, asset_url, asset_size, asset_digest, body) =
            match cfg.source_kind {
                TizenSourceKind::GithubRelease => {
                    let release = fetch_github_release(
                        cfg.repo.as_deref().unwrap_or(""),
                        cfg.asset_pattern.as_deref().unwrap_or(""),
                    )
                    .await?;
                    (
                        release.tag_name.clone(),
                        release.asset_name.clone(),
                        release.asset_url.clone(),
                        release.asset_size,
                        release.asset_digest.clone(),
                        release.body.clone(),
                    )
                }
                TizenSourceKind::Url => {
                    let url = cfg.download_url.clone().unwrap_or_default();
                    let info = head_url(&url).await?;
                    let asset_name = url
                        .rsplit('/')
                        .next()
                        .map(std::string::ToString::to_string)
                        .unwrap_or_else(|| "asset.ipk".to_string());
                    (
                        info.etag.unwrap_or_else(|| "remote".to_string()),
                        asset_name,
                        url,
                        info.content_length.unwrap_or(0),
                        info.sha256,
                        String::new(),
                    )
                }
            };

        let incoming = if body.is_empty() {
            vec![]
        } else {
            vec![IncomingItem::IpkChange {
                version: to_label.clone(),
                notes: body,
            }]
        };

        let mut steps = vec![
            PlanStep {
                title: "Snapshot prior IPK".into(),
                detail: Some(format!(
                    "cache/installers/{}/<prior-sha>.ipk preserved for rollback",
                    app.id
                )),
                tag: PlanTag::Safe,
            },
            PlanStep {
                title: "Download IPK".into(),
                detail: Some(format!("{} ({})", asset_url, human_bytes(asset_size))),
                tag: PlanTag::TimeEstimate,
            },
        ];
        if asset_digest.is_some() {
            steps.push(PlanStep {
                title: "Verify SHA-256".into(),
                detail: Some("strict — abort on mismatch".into()),
                tag: PlanTag::Safe,
            });
        } else {
            steps.push(PlanStep {
                title: "Verify SHA-256".into(),
                detail: Some("no digest published — proceeding unverified".into()),
                tag: PlanTag::Risky,
            });
        }
        steps.push(PlanStep {
            title: "Deploy to Samsung TV".into(),
            detail: Some(if let Some(serial) = cfg.device_serial.as_deref() {
                format!("sdb -s {serial} install <ipk>")
            } else {
                "sdb install <ipk> (auto-select first paired device)".to_string()
            }),
            tag: PlanTag::TimeEstimate,
        });

        let mut to_meta = vec![
            KeyValue {
                key: "asset".into(),
                value: asset_name,
            },
            KeyValue {
                key: "size".into(),
                value: human_bytes(asset_size),
            },
        ];
        if let Some(d) = asset_digest.as_ref() {
            to_meta.push(KeyValue {
                key: "sha256".into(),
                value: short_sha(d),
            });
        }

        Ok(UpdatePlan {
            app_id: app.id.clone(),
            source_type: SourceType::TizenIpk,
            from_label: "current".to_string(),
            to_label,
            from_meta: vec![],
            to_meta,
            incoming,
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
        let installer_dir = Self::installer_dir(app, &ctx.paths);
        let started = Instant::now();
        let mut messages = Vec::new();
        let app_id = app.id.clone();

        tokio::fs::create_dir_all(&installer_dir)
            .await
            .map_err(|e| CoreError::io(&installer_dir, e))?;

        // === Fetch ============================================================
        emit(&ctx, &app_id, "fetch", "resolving source").await;
        let (asset_url, expected_sha, version_label) = match cfg.source_kind {
            TizenSourceKind::GithubRelease => {
                let release = fetch_github_release(
                    cfg.repo.as_deref().unwrap_or(""),
                    cfg.asset_pattern.as_deref().unwrap_or(""),
                )
                .await?;
                (
                    release.asset_url.clone(),
                    release.asset_digest.clone(),
                    release.tag_name.clone(),
                )
            }
            TizenSourceKind::Url => {
                let url = cfg.download_url.clone().unwrap_or_default();
                let info = head_url(&url).await?;
                (
                    url,
                    info.sha256,
                    info.etag.unwrap_or_else(|| "remote".to_string()),
                )
            }
        };

        emit(&ctx, &app_id, "fetch", &format!("downloading {asset_url}")).await;
        let (ipk_path, actual_sha, bytes) =
            download_and_hash(&asset_url, &installer_dir, &ctx, &app_id).await?;
        messages.push(format!(
            "downloaded {} bytes from {asset_url}",
            bytes
        ));

        if let Some(expected) = expected_sha.as_ref() {
            let expected_lower = expected.to_ascii_lowercase();
            if expected_lower != actual_sha {
                // Cleanup the bad file before erroring.
                let _ = tokio::fs::remove_file(&ipk_path).await;
                return Err(CoreError::sha_mismatch(expected_lower, actual_sha));
            }
            messages.push(format!("sha256 verified: {actual_sha}"));
        } else {
            tracing::warn!(
                app = app.id,
                "no expected sha256 published — accepting download as-is"
            );
            messages.push("no expected sha256 published — accepted unverified".to_string());
        }

        // Rename to <sha>.ipk so rollback can locate the prior IPK by its digest.
        let final_path = installer_dir.join(format!("{actual_sha}.ipk"));
        if final_path != ipk_path {
            // If a same-sha file already exists (re-download of identical asset), drop the dup.
            if final_path.exists() {
                tokio::fs::remove_file(&ipk_path)
                    .await
                    .map_err(|e| CoreError::io(&ipk_path, e))?;
            } else {
                tokio::fs::rename(&ipk_path, &final_path)
                    .await
                    .map_err(|e| CoreError::io(&final_path, e))?;
            }
        }
        messages.push(format!(
            "cached at {}",
            final_path.display()
        ));

        // === Deploy ===========================================================
        // Deploy is intentionally part of `apply` for the Tizen flow because the
        // manifest's launch.kind for these apps is `tizen-deploy` (see manifest
        // schema §3). The card menu's "Update" button is the deploy trigger.
        emit(&ctx, &app_id, "deploy", "probing sdb").await;
        let probe = run_sdb_devices().await?;
        if probe.devices.is_empty() {
            return Err(CoreError::not_supported(
                "no Samsung TV detected via sdb devices; connect TV and re-run",
            ));
        }
        messages.push(format!(
            "sdb sees {} paired device(s): {}",
            probe.devices.len(),
            probe.devices.join(", ")
        ));

        emit(&ctx, &app_id, "deploy", "installing ipk").await;
        let install_log = run_sdb_install(&final_path, cfg.device_serial.as_deref()).await?;
        messages.push(format!("sdb install invocation: {}", install_log.command));
        for line in &install_log.stdout_lines {
            messages.push(format!("sdb stdout: {line}"));
        }
        for line in &install_log.stderr_lines {
            messages.push(format!("sdb stderr: {line}"));
        }

        Ok(UpdateOutcome {
            new_version: Some(version_label),
            new_sha: Some(short_sha(&actual_sha)),
            bytes_downloaded: bytes,
            elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            messages,
        })
    }

    async fn rollback(
        &self,
        app: &AppEntry,
        snapshot_archive: &PathBuf,
        _paths: &AppPaths,
    ) -> Result<(), CoreError> {
        // For Tizen, rollback is "re-install the prior cached IPK". The snapshot path
        // is the explicit cached IPK file (`cache/installers/<id>/<old-sha>.ipk`) that
        // the orchestrator selected from the rollback history. Generic tar.zst snapshots
        // are rejected here because re-installing on the TV requires the IPK payload.
        let ext = snapshot_archive
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        if ext != "ipk" {
            return Err(CoreError::not_supported(format!(
                "rollback requires cached prior IPK at {}, found unsupported extension '{ext}'",
                snapshot_archive.display()
            )));
        }
        if !snapshot_archive.exists() {
            return Err(CoreError::not_supported(format!(
                "rollback requires cached prior IPK at {}",
                snapshot_archive.display()
            )));
        }

        let probe = run_sdb_devices().await?;
        if probe.devices.is_empty() {
            return Err(CoreError::not_supported(
                "no Samsung TV detected via sdb devices; connect TV and re-run",
            ));
        }
        let cfg = Self::config(app)?;
        run_sdb_install(snapshot_archive, cfg.device_serial.as_deref()).await?;
        Ok(())
    }
}

// ── Network helpers ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
struct HeadInfo {
    content_length: Option<u64>,
    etag: Option<String>,
    sha256: Option<String>,
}

fn github_api_base() -> String {
    std::env::var(GITHUB_API_ENV).unwrap_or_else(|_| DEFAULT_GITHUB_API_BASE.to_string())
}

async fn fetch_github_release(repo: &str, asset_pattern: &str) -> Result<GithubRelease, CoreError> {
    let base = github_api_base();
    let url = format!("{base}/repos/{repo}/releases/latest");
    let client = reqwest::Client::builder()
        .user_agent("iptv-hub/0.1.0")
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let resp = client.get(&url).send().await?;
    if !resp.status().is_success() {
        return Err(CoreError::network(format!(
            "GET {url} returned {}",
            resp.status()
        )));
    }
    let body: serde_json::Value = resp.json().await?;
    let tag_name = body
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| CoreError::network(format!("release {repo}: missing tag_name")))?
        .to_string();
    let release_body = body
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let assets = body
        .get("assets")
        .and_then(|v| v.as_array())
        .ok_or_else(|| CoreError::network(format!("release {repo}: missing assets")))?;

    let re = Regex::new(asset_pattern).map_err(|e| {
        CoreError::config(format!(
            "tizen asset_pattern '{asset_pattern}' is not a valid regex: {e}"
        ))
    })?;
    for asset in assets {
        let name = asset.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if !re.is_match(name) {
            continue;
        }
        let asset_url = asset
            .get("browser_download_url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::network("asset missing browser_download_url".to_string()))?
            .to_string();
        let asset_size = asset
            .get("size")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        // GitHub publishes a `digest` field on releases as of 2024 with format "sha256:<hex>".
        let asset_digest = asset
            .get("digest")
            .and_then(|v| v.as_str())
            .and_then(|s| s.strip_prefix("sha256:"))
            .map(std::string::ToString::to_string);
        return Ok(GithubRelease {
            tag_name,
            asset_name: name.to_string(),
            asset_url,
            asset_size,
            asset_digest,
            body: release_body,
        });
    }
    Err(CoreError::network(format!(
        "no asset in {repo}/releases/latest matched pattern '{asset_pattern}'"
    )))
}

async fn head_url(url: &str) -> Result<HeadInfo, CoreError> {
    let client = reqwest::Client::builder()
        .user_agent("iptv-hub/0.1.0")
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let resp = client.head(url).send().await?;
    if !resp.status().is_success() {
        return Err(CoreError::network(format!(
            "HEAD {url} returned {}",
            resp.status()
        )));
    }
    let headers = resp.headers();
    let content_length = headers
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok());
    let etag = headers
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim_matches('"').to_string());
    // Some vendors publish a Digest: sha-256=<base64> header. We accept hex too.
    let sha256 = headers
        .get("digest")
        .and_then(|v| v.to_str().ok())
        .and_then(parse_digest_header);
    Ok(HeadInfo {
        content_length,
        etag,
        sha256,
    })
}

fn parse_digest_header(raw: &str) -> Option<String> {
    // RFC 3230: `<algorithm>=<value>`. We accept SHA-256= or sha-256=.
    for part in raw.split(',') {
        let part = part.trim();
        let lower = part.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("sha-256=") {
            return Some(rest.trim_matches('"').to_string());
        }
        if let Some(rest) = lower.strip_prefix("sha256=") {
            return Some(rest.trim_matches('"').to_string());
        }
    }
    None
}

async fn download_and_hash(
    url: &str,
    installer_dir: &Path,
    ctx: &ApplyCtx,
    app_id: &str,
) -> Result<(PathBuf, String, u64), CoreError> {
    let client = reqwest::Client::builder()
        .user_agent("iptv-hub/0.1.0")
        .timeout(std::time::Duration::from_secs(120))
        .build()?;
    let mut resp = client.get(url).send().await?;
    if !resp.status().is_success() {
        return Err(CoreError::network(format!(
            "GET {url} returned {}",
            resp.status()
        )));
    }
    let total = resp.content_length();
    let tmp_path = installer_dir.join(format!("{}.partial", ulid::Ulid::new()));
    let mut file = tokio::fs::File::create(&tmp_path)
        .await
        .map_err(|e| CoreError::io(&tmp_path, e))?;
    let mut hasher = Sha256::new();
    let mut bytes_done: u64 = 0;
    while let Some(chunk) = resp.chunk().await? {
        file.write_all(&chunk)
            .await
            .map_err(|e| CoreError::io(&tmp_path, e))?;
        hasher.update(&chunk);
        bytes_done = bytes_done.saturating_add(u64::try_from(chunk.len()).unwrap_or(u64::MAX));
        let _ = ctx
            .progress
            .send(ProgressEvent {
                app_id: app_id.to_string(),
                step: "fetch".into(),
                message: format!("{bytes_done} bytes"),
                bytes_done: Some(bytes_done),
                bytes_total: total,
            })
            .await;
    }
    file.flush()
        .await
        .map_err(|e| CoreError::io(&tmp_path, e))?;
    drop(file);
    let digest = hex::encode(hasher.finalize());
    Ok((tmp_path, digest, bytes_done))
}

// ── sdb wrapper ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct SdbDevicesResult {
    devices: Vec<String>,
}

#[derive(Debug, Clone)]
struct SdbInstallResult {
    command: String,
    stdout_lines: Vec<String>,
    stderr_lines: Vec<String>,
}

async fn run_sdb_devices() -> Result<SdbDevicesResult, CoreError> {
    let output = Command::new(SDB_BINARY)
        .arg("devices")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| {
            CoreError::not_supported(format!(
                "sdb not found on PATH: {e}. Install Samsung Tizen Studio sdb and re-run."
            ))
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        return Err(CoreError::internal(format!("sdb devices failed: {stderr}")));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut devices = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("List of devices") {
            continue;
        }
        // Format: "<serial>\tdevice" (or "offline" / "unauthorized")
        if let Some((serial, state)) = trimmed.split_once('\t') {
            if state.trim() == "device" {
                devices.push(serial.trim().to_string());
            }
        }
    }
    Ok(SdbDevicesResult { devices })
}

async fn run_sdb_install(
    ipk: &Path,
    device_serial: Option<&str>,
) -> Result<SdbInstallResult, CoreError> {
    let mut args: Vec<String> = Vec::new();
    if let Some(serial) = device_serial {
        args.push("-s".to_string());
        args.push(serial.to_string());
    }
    args.push("install".to_string());
    args.push(ipk.to_string_lossy().into_owned());
    let command_repr = format!("{SDB_BINARY} {}", args.join(" "));

    let output = Command::new(SDB_BINARY)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| {
            CoreError::not_supported(format!(
                "sdb not found on PATH while installing: {e}"
            ))
        })?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let stdout_lines = stdout.lines().map(std::string::ToString::to_string).collect();
    let stderr_lines: Vec<String> = stderr.lines().map(std::string::ToString::to_string).collect();
    if !output.status.success() {
        let joined = if stderr_lines.is_empty() {
            stdout_lines.iter().cloned().collect::<Vec<_>>().join("; ")
        } else {
            stderr_lines.join("; ")
        };
        return Err(CoreError::internal(format!(
            "sdb install failed (exit {}): {joined}",
            output.status.code().map_or_else(|| "?".to_string(), |c| c.to_string())
        )));
    }
    Ok(SdbInstallResult {
        command: command_repr,
        stdout_lines,
        stderr_lines,
    })
}

// ── small helpers ────────────────────────────────────────────────────────────

fn short_sha(s: &str) -> String {
    s.get(..16).unwrap_or(s).to_string()
}

#[allow(clippy::cast_precision_loss)]
fn human_bytes(n: u64) -> String {
    const KIB: u64 = 1024;
    const MIB: u64 = 1024 * KIB;
    const GIB: u64 = 1024 * MIB;
    // The f64 cast here is intentional: we display two decimals at human scale.
    // u64 -> f64 can lose precision above 2^53 bytes (~9 PiB), well beyond any
    // realistic IPK size, so the loss is acceptable.
    if n >= GIB {
        let v = (n as f64) / (GIB as f64);
        format!("{v:.2} GiB")
    } else if n >= MIB {
        let v = (n as f64) / (MIB as f64);
        format!("{v:.2} MiB")
    } else if n >= KIB {
        let v = (n as f64) / (KIB as f64);
        format!("{v:.2} KiB")
    } else {
        format!("{n} B")
    }
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

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn human_bytes_renders_units() {
        assert_eq!(human_bytes(0), "0 B");
        assert_eq!(human_bytes(2048), "2.00 KiB");
        assert!(human_bytes(5 * 1024 * 1024).contains("MiB"));
    }

    #[test]
    fn parse_digest_header_accepts_sha256() {
        assert_eq!(
            parse_digest_header("sha-256=abc123"),
            Some("abc123".to_string())
        );
        assert_eq!(
            parse_digest_header("SHA-256=\"abc123\", md5=ignored"),
            Some("abc123".to_string())
        );
        assert_eq!(parse_digest_header("md5=abc123"), None);
    }
}
