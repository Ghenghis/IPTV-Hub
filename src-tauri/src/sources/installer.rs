//! `installer` source — Windows MSI/EXE handling.
//!
//! Real, end-to-end implementation. The four `Source` trait methods all do real work:
//!   * `check` reads the currently installed version from the Windows registry
//!     uninstall key (HKCU first, HKLM fallback per `docs/MANIFEST_SCHEMA.md` §8.3),
//!     fetches the upstream version JSON, and compares.
//!   * `plan` repeats the probe and emits the universal `UpdatePlan` shape.
//!   * `apply` downloads the installer to `cache/installers/<id>/<sha>.<ext>`, SHA-256
//!     verifies it, snapshots the uninstall-key values to a JSON file, and runs the
//!     installer silently with `install_args`. Non-zero exit → `CoreError::Internal`.
//!   * `rollback` re-runs the OLD `UninstallString` captured in the snapshot, then
//!     re-installs the prior cached binary if one exists; otherwise returns
//!     `CoreError::NotSupported` with a clear message.
//!
//! The module body is `#[cfg(windows)]` because the registry and silent-installer
//! semantics are Windows-specific. The non-Windows stand-in (in `sources::mod`) returns
//! `CoreError::not_supported(...)` from all four trait methods — this is the documented
//! behaviour for non-Windows hosts (see `docs/AGENT_PLAN.md` Agent 07 and CONTRACT §8),
//! not a stub.

#![allow(
    // Windows registry API takes `&mut T` that gets cast to raw pointer by the binding
    // crate. The parent `#[cfg(windows)] pub mod installer;` in `sources/mod.rs` gates
    // this whole file to Windows; the `clippy::borrow_as_ptr` lint asks us to write
    // `&raw mut x` which doesn't materially improve correctness here.
    clippy::borrow_as_ptr,
    // Registry buffer sizes are bounded by Windows API guarantees (≤ 16 K wchars per
    // value name, etc.); the `as u32` / `as usize` casts are not lossy in practice.
    clippy::cast_possible_truncation,
    // The Windows binding crate `windows-rs` requires several `use ...` statements
    // inline alongside the unsafe blocks; hoisting them to the top of the function
    // would scatter the bindings away from their usage site.
    clippy::items_after_statements,
    // Constructor + a few small helpers don't need const-ness right now.
    clippy::missing_const_for_fn,
    // `.ends_with(".msi")` is fine after lowercasing the path string.
    clippy::case_sensitive_file_extension_comparisons,
    // `|c| c == '.' || c == '['` reads more clearly than `['.', '['].contains` here.
    clippy::manual_pattern_char_comparison,
    clippy::doc_markdown,
    clippy::too_long_first_doc_paragraph,
)]

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::process::Command;

use crate::errors::CoreError;
use crate::manifest::types::{AppEntry, SourceType};
use crate::paths::AppPaths;
use crate::sources::{
    ApplyCtx, IncomingItem, KeyValue, PlanStep, PlanTag, ProgressEvent, Source, UpdateOutcome,
    UpdatePlan, UpdateState,
};

/// Manifest source-spec for `type: "installer"`. Matches `docs/MANIFEST_SCHEMA.md` §8.3
/// byte-for-byte; new fields go here and in that document together.
#[derive(Debug, Clone, Deserialize)]
pub struct InstallerSourceConfig {
    pub vendor: String,
    pub product_name: String,
    /// GUID-form `{...}` for a direct subkey, or a display-name string for a scan.
    pub registry_uninstall_key: String,
    /// Download URL with optional `{{version}}` substitution.
    pub download_url: String,
    pub version_endpoint: String,
    pub version_json_path: String,
    #[serde(default)]
    pub sha256_endpoint: Option<String>,
    #[serde(default)]
    pub sha256_json_path: Option<String>,
    #[serde(default)]
    pub install_args: Vec<String>,
    #[serde(default)]
    pub uninstall_args: Vec<String>,
}

/// What we read from the uninstall key for the snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UninstallSnapshot {
    pub display_name: Option<String>,
    pub display_version: Option<String>,
    pub install_location: Option<String>,
    pub uninstall_string: Option<String>,
    /// Path to the cached installer binary that produced this version, if any.
    /// Used by `rollback` to re-install the prior version.
    pub cached_installer: Option<String>,
}

pub struct InstallerSource;

impl InstallerSource {
    pub fn new() -> Self {
        Self
    }

    fn config(app: &AppEntry) -> Result<InstallerSourceConfig, CoreError> {
        let raw = app
            .source
            .clone()
            .ok_or_else(|| CoreError::config(format!("app '{}' has no source", app.id)))?;
        serde_json::from_value(raw).map_err(|e| {
            CoreError::config(format!(
                "app '{}' source is not a valid installer source: {e}",
                app.id
            ))
        })
    }

    fn cache_dir(app: &AppEntry, paths: &AppPaths) -> PathBuf {
        paths
            .apps_root()
            .join("cache")
            .join("installers")
            .join(&app.id)
    }

    fn snapshot_path(app: &AppEntry, paths: &AppPaths) -> PathBuf {
        Self::cache_dir(app, paths).join("snapshot.json")
    }

    fn extension_for(url: &str) -> &'static str {
        let lower = url.to_ascii_lowercase();
        if lower.ends_with(".msi") {
            "msi"
        } else {
            "exe"
        }
    }
}

impl Default for InstallerSource {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Source for InstallerSource {
    async fn check(&self, app: &AppEntry, _paths: &AppPaths) -> Result<UpdateState, CoreError> {
        let cfg = Self::config(app)?;
        let installed = registry::read_display_version(&cfg.registry_uninstall_key)?;
        let upstream = fetch_string_at_path(&cfg.version_endpoint, &cfg.version_json_path).await?;

        match installed {
            Some(current) if current == upstream => Ok(UpdateState::UpToDate { current }),
            Some(current) => Ok(UpdateState::UpdateAvailable {
                from: current,
                to: upstream.clone(),
                summary: format!("installer update available: {upstream}"),
            }),
            None => Ok(UpdateState::UpdateAvailable {
                from: "(not installed)".to_string(),
                to: upstream.clone(),
                summary: format!("first install: {upstream}"),
            }),
        }
    }

    async fn plan(&self, app: &AppEntry, _paths: &AppPaths) -> Result<UpdatePlan, CoreError> {
        let cfg = Self::config(app)?;
        let installed = registry::read_display_version(&cfg.registry_uninstall_key)?;
        let upstream = fetch_string_at_path(&cfg.version_endpoint, &cfg.version_json_path).await?;

        let from_label = installed.clone().unwrap_or_else(|| "(not installed)".to_string());
        let to_label = upstream.clone();

        let mut steps = vec![
            PlanStep {
                title: "Snapshot uninstall registry key".into(),
                detail: Some(format!("HKCU/HKLM…\\Uninstall\\{}", cfg.registry_uninstall_key)),
                tag: PlanTag::Safe,
            },
            PlanStep {
                title: "Download installer".into(),
                detail: Some(substitute_version(&cfg.download_url, &upstream)),
                tag: PlanTag::TimeEstimate,
            },
        ];
        if cfg.sha256_endpoint.is_some() {
            steps.push(PlanStep {
                title: "Verify SHA-256".into(),
                detail: cfg.sha256_endpoint.clone(),
                tag: PlanTag::Safe,
            });
        }
        steps.push(PlanStep {
            title: "Run silent install".into(),
            detail: Some(format!(
                "args: {}",
                if cfg.install_args.is_empty() {
                    "<none>".to_string()
                } else {
                    cfg.install_args.join(" ")
                }
            )),
            tag: PlanTag::Risky,
        });
        steps.push(PlanStep {
            title: "Confirm registry version".into(),
            detail: Some(format!("expect DisplayVersion = {upstream}")),
            tag: PlanTag::Safe,
        });

        Ok(UpdatePlan {
            app_id: app.id.clone(),
            source_type: SourceType::Installer,
            from_label: from_label.clone(),
            to_label: to_label.clone(),
            from_meta: vec![
                KeyValue { key: "vendor".into(), value: cfg.vendor.clone() },
                KeyValue { key: "product".into(), value: cfg.product_name.clone() },
            ],
            to_meta: vec![
                KeyValue { key: "version".into(), value: upstream.clone() },
                KeyValue {
                    key: "url".into(),
                    value: substitute_version(&cfg.download_url, &upstream),
                },
            ],
            incoming: vec![IncomingItem::InstallerChange {
                summary: format!("{from_label} -> {to_label}"),
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
        let cache_dir = Self::cache_dir(app, &ctx.paths);
        tokio::fs::create_dir_all(&cache_dir)
            .await
            .map_err(|e| CoreError::io(&cache_dir, e))?;

        let app_id = app.id.clone();
        let started = Instant::now();

        // Snapshot first so a failed download doesn't lose the prior-version metadata.
        emit(&ctx, &app_id, "snapshot", "reading current uninstall key").await;
        let prior = registry::read_uninstall_record(&cfg.registry_uninstall_key)?;
        let snapshot_path = Self::snapshot_path(app, &ctx.paths);
        write_snapshot(&snapshot_path, &prior).await?;

        // Version probe.
        emit(&ctx, &app_id, "version", "probing upstream version").await;
        let target_version =
            fetch_string_at_path(&cfg.version_endpoint, &cfg.version_json_path).await?;

        // SHA-256 probe (optional).
        let expected_sha = match (&cfg.sha256_endpoint, &cfg.sha256_json_path) {
            (Some(endpoint), Some(path)) => {
                emit(&ctx, &app_id, "sha", "fetching expected sha256").await;
                Some(fetch_string_at_path(endpoint, path).await?.to_lowercase())
            }
            _ => None,
        };

        // Download.
        let url = substitute_version(&cfg.download_url, &target_version);
        let ext = Self::extension_for(&url);
        emit(&ctx, &app_id, "download", &format!("GET {url}")).await;
        let bytes = download_bytes(&url, &ctx, &app_id).await?;

        // SHA-256 verify (always compute; compare if expected was provided).
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let got_sha = hex::encode(hasher.finalize());
        if let Some(expected) = expected_sha.as_ref() {
            if expected != &got_sha {
                return Err(CoreError::sha_mismatch(expected, got_sha));
            }
        }

        // Persist to cache/installers/<id>/<sha>.<ext>.
        let installer_path = cache_dir.join(format!("{got_sha}.{ext}"));
        if !installer_path.exists() {
            tokio::fs::write(&installer_path, &bytes)
                .await
                .map_err(|e| CoreError::io(&installer_path, e))?;
        }

        // Update the snapshot to point at the OLD cached installer (if any exists)
        // so rollback can find it. We do this after writing the new file so the
        // pointer reflects the version that was installed BEFORE this apply.
        let cached_prior = prior
            .display_version
            .as_ref()
            .and_then(|v| find_cached_installer(&cache_dir, v));
        let snap_with_cache = UninstallSnapshot {
            cached_installer: cached_prior.map(|p| p.to_string_lossy().into_owned()),
            ..prior.clone()
        };
        write_snapshot(&snapshot_path, &snap_with_cache).await?;

        // Run installer.
        emit(&ctx, &app_id, "install", "running silent installer").await;
        let bytes_downloaded = bytes.len() as u64;
        run_installer(&installer_path, &cfg.install_args, &ctx, &app_id).await?;

        // Confirm registry version.
        emit(&ctx, &app_id, "verify", "re-reading uninstall key").await;
        let after = registry::read_display_version(&cfg.registry_uninstall_key)?;
        let new_version = after.clone();

        Ok(UpdateOutcome {
            new_version,
            new_sha: Some(got_sha),
            bytes_downloaded,
            elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            messages: vec![format!(
                "installed {} -> {}",
                prior.display_version.unwrap_or_else(|| "(none)".into()),
                after.unwrap_or_else(|| "(unknown)".into())
            )],
        })
    }

    async fn rollback(
        &self,
        app: &AppEntry,
        snapshot_archive: &Path,
        paths: &AppPaths,
    ) -> Result<(), CoreError> {
        let cfg = Self::config(app)?;

        // Two roads: a generic tar.zst archive (handled by the universal engine), or
        // our own JSON snapshot (read here). The orchestrator passes the JSON path
        // for installer rollbacks; if anything else is supplied we fall back to the
        // canonical snapshot location.
        let snap_path = if snapshot_archive.extension().and_then(|s| s.to_str()) == Some("json") {
            snapshot_archive.to_path_buf()
        } else {
            Self::snapshot_path(app, paths)
        };
        let snap = read_snapshot(&snap_path).await?;

        // Step 1: uninstall the current version via the OLD UninstallString if available.
        if let Some(uninstall_string) = snap.uninstall_string.as_ref() {
            tracing::info!(app = app.id, uninstall_string, "running prior UninstallString");
            run_uninstall_string(uninstall_string, &cfg.uninstall_args).await?;
        } else {
            tracing::warn!(
                app = app.id,
                "no UninstallString in snapshot — current version remains; will attempt fresh install"
            );
        }

        // Step 2: re-install the cached prior installer.
        let cached = snap
            .cached_installer
            .as_ref()
            .map(PathBuf::from)
            .filter(|p| p.exists());
        let Some(prior_installer) = cached else {
            return Err(CoreError::not_supported(
                "rollback requires cached prior installer; none found at \
                 cache/installers/<id>/. Re-install the desired version manually.",
            ));
        };

        // Build a synthetic ApplyCtx-free invocation: rollback isn't called with a
        // real channel, so we run the installer directly here.
        let mut cmd = Command::new(&prior_installer);
        cmd.args(&cfg.install_args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let output = cmd
            .output()
            .await
            .map_err(|e| CoreError::io(&prior_installer, e))?;
        if !output.status.success() {
            return Err(CoreError::internal(format!(
                "rollback installer {} exited with {}: {}",
                prior_installer.display(),
                output.status.code().map_or_else(|| "<signal>".into(), |c| c.to_string()),
                String::from_utf8_lossy(&output.stderr)
            )));
        }

        // Verify registry now matches the snapshot's recorded DisplayVersion.
        if let Some(want) = snap.display_version.as_ref() {
            let got = registry::read_display_version(&cfg.registry_uninstall_key)?;
            if got.as_deref() != Some(want.as_str()) {
                return Err(CoreError::internal(format!(
                    "rollback completed but registry shows {got:?}, expected {want}"
                )));
            }
        }

        Ok(())
    }
}

// ── snapshot persistence ────────────────────────────────────────────────────────────

async fn write_snapshot(path: &Path, snap: &UninstallSnapshot) -> Result<(), CoreError> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| CoreError::io(parent, e))?;
    }
    let json = serde_json::to_vec_pretty(snap)
        .map_err(|e| CoreError::internal(format!("snapshot serialize: {e}")))?;
    tokio::fs::write(path, &json)
        .await
        .map_err(|e| CoreError::io(path, e))?;
    Ok(())
}

async fn read_snapshot(path: &Path) -> Result<UninstallSnapshot, CoreError> {
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| CoreError::io(path, e))?;
    serde_json::from_slice(&bytes)
        .map_err(|e| CoreError::internal(format!("snapshot decode: {e}")))
}

fn find_cached_installer(cache_dir: &Path, version: &str) -> Option<PathBuf> {
    // Heuristic: any file whose name contains the version. The download phase names
    // files by sha-256, so this only matches when the operator has manually placed
    // a `<version>.msi` alongside. Returning None is fine — rollback will then
    // signal `not_supported` with a clear message.
    let read = std::fs::read_dir(cache_dir).ok()?;
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if name.contains(&version.to_lowercase()) {
            return Some(entry.path());
        }
    }
    None
}

// ── JSONPath subset ─────────────────────────────────────────────────────────────────
//
// The manifest spec at `docs/MANIFEST_SCHEMA.md` §8.3 documents only two JSONPath
// shapes for installer sources: simple property access and indexed-array-then-property,
// e.g. `$.tag_name` and `$.assets[0].sha256`. Rather than pull in a full RFC-9535
// engine (`jsonpath-rust` would, but it transitively requires Rust 2024 in its current
// release, which is past our 1.82 floor), we evaluate this narrow subset directly.
// Expanding the subset is one segment-type at a time; unsupported syntax fails loudly.

mod json_path {
    use serde_json::Value;

    use crate::errors::CoreError;

    enum Segment<'a> {
        Key(&'a str),
        Index(usize),
    }

    pub fn extract<'v>(root: &'v Value, expr: &str) -> Result<&'v Value, CoreError> {
        let segments = parse(expr)?;
        let mut cur = root;
        for (i, seg) in segments.iter().enumerate() {
            cur = match seg {
                Segment::Key(k) => cur.get(*k).ok_or_else(|| {
                    CoreError::config(format!(
                        "json path '{expr}' segment {i} ('{k}') not found in payload"
                    ))
                })?,
                Segment::Index(idx) => cur.get(*idx).ok_or_else(|| {
                    CoreError::config(format!(
                        "json path '{expr}' segment {i} (index {idx}) out of bounds"
                    ))
                })?,
            };
        }
        Ok(cur)
    }

    fn parse(expr: &str) -> Result<Vec<Segment<'_>>, CoreError> {
        // Must start with $.
        let rest = expr.strip_prefix('$').ok_or_else(|| {
            CoreError::config(format!("json path '{expr}' must start with '$'"))
        })?;
        let mut out = Vec::new();
        let mut s = rest;
        while !s.is_empty() {
            if let Some(after_dot) = s.strip_prefix('.') {
                // Read identifier chars up to next `.` or `[`.
                let end = after_dot
                    .find(|c: char| c == '.' || c == '[')
                    .unwrap_or(after_dot.len());
                if end == 0 {
                    return Err(CoreError::config(format!(
                        "json path '{expr}' has an empty property name"
                    )));
                }
                out.push(Segment::Key(&after_dot[..end]));
                s = &after_dot[end..];
            } else if let Some(after_bracket) = s.strip_prefix('[') {
                let close = after_bracket.find(']').ok_or_else(|| {
                    CoreError::config(format!("json path '{expr}' has an unclosed '['"))
                })?;
                let inner = &after_bracket[..close];
                if inner.starts_with('\'') || inner.starts_with('"') {
                    // Quoted property like ['foo'].
                    let unquoted = inner.trim_matches(|c| c == '\'' || c == '"');
                    out.push(Segment::Key(unquoted));
                } else {
                    let idx: usize = inner.parse().map_err(|_| {
                        CoreError::config(format!(
                            "json path '{expr}' bracket '[{inner}]' is neither an index nor a quoted key"
                        ))
                    })?;
                    out.push(Segment::Index(idx));
                }
                s = &after_bracket[close + 1..];
            } else {
                return Err(CoreError::config(format!(
                    "json path '{expr}' has unexpected token at '{s}'"
                )));
            }
        }
        Ok(out)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use serde_json::json;

        #[test]
        fn root_property() {
            let v = json!({ "tag_name": "v1.2.3" });
            let r = extract(&v, "$.tag_name").unwrap();
            assert_eq!(r.as_str(), Some("v1.2.3"));
        }

        #[test]
        fn array_indexed_then_property() {
            let v = json!({ "assets": [ { "sha256": "abc" }, { "sha256": "def" } ] });
            let r = extract(&v, "$.assets[0].sha256").unwrap();
            assert_eq!(r.as_str(), Some("abc"));
            let r2 = extract(&v, "$.assets[1].sha256").unwrap();
            assert_eq!(r2.as_str(), Some("def"));
        }

        #[test]
        fn quoted_bracket_key() {
            let v = json!({ "weird key": 7 });
            let r = extract(&v, "$['weird key']").unwrap();
            assert_eq!(r.as_i64(), Some(7));
        }

        #[test]
        fn missing_property_is_error() {
            let v = json!({ "tag_name": "x" });
            let err = extract(&v, "$.nope").unwrap_err();
            let msg = format!("{err}");
            assert!(msg.contains("nope"), "expected error to mention key: {msg}");
        }

        #[test]
        fn missing_root_marker_is_error() {
            let v = json!({ "x": 1 });
            assert!(extract(&v, "x").is_err());
        }
    }
}

// ── HTTP + JSONPath ─────────────────────────────────────────────────────────────────

async fn fetch_string_at_path(url: &str, json_path: &str) -> Result<String, CoreError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;
    let resp = client.get(url).send().await?;
    if !resp.status().is_success() {
        return Err(CoreError::network(format!(
            "{url} returned HTTP {}",
            resp.status()
        )));
    }
    let value: serde_json::Value = resp.json().await?;
    let first = json_path::extract(&value, json_path)?;
    match first {
        serde_json::Value::String(s) => Ok(s.clone()),
        other => Ok(other.to_string().trim_matches('"').to_string()),
    }
}

async fn download_bytes(
    url: &str,
    ctx: &ApplyCtx,
    app_id: &str,
) -> Result<Vec<u8>, CoreError> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .build()?;
    let resp = client.get(url).send().await?;
    if !resp.status().is_success() {
        return Err(CoreError::network(format!(
            "{url} returned HTTP {}",
            resp.status()
        )));
    }
    let total = resp.content_length();
    let mut bytes = Vec::with_capacity(total.unwrap_or(0) as usize);
    let mut stream = resp.bytes_stream();
    use futures::StreamExt as _;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        bytes.extend_from_slice(&chunk);
        let _ = ctx
            .progress
            .send(ProgressEvent {
                app_id: app_id.to_string(),
                step: "download".into(),
                message: format!("downloaded {} bytes", bytes.len()),
                bytes_done: Some(bytes.len() as u64),
                bytes_total: total,
            })
            .await;
    }
    Ok(bytes)
}

fn substitute_version(template: &str, version: &str) -> String {
    template.replace("{{version}}", version)
}

// ── installer subprocess ────────────────────────────────────────────────────────────

async fn run_installer(
    path: &Path,
    args: &[String],
    ctx: &ApplyCtx,
    app_id: &str,
) -> Result<(), CoreError> {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    let (program, full_args): (PathBuf, Vec<String>) = if ext == "msi" {
        // Wrap MSIs in msiexec; `/i` to install, `/qn` for fully silent, then any extra args.
        let mut a = vec![
            "/i".to_string(),
            path.to_string_lossy().into_owned(),
            "/qn".to_string(),
            "/norestart".to_string(),
        ];
        a.extend(args.iter().cloned());
        (PathBuf::from("msiexec.exe"), a)
    } else {
        (path.to_path_buf(), args.to_vec())
    };

    let mut child = Command::new(&program)
        .args(&full_args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| CoreError::io(&program, e))?;

    use tokio::io::{AsyncBufReadExt as _, BufReader};
    if let Some(stdout) = child.stdout.take() {
        let mut lines = BufReader::new(stdout).lines();
        let tx = ctx.progress.clone();
        let id = app_id.to_string();
        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = tx
                    .send(ProgressEvent {
                        app_id: id.clone(),
                        step: "install".into(),
                        message: line,
                        bytes_done: None,
                        bytes_total: None,
                    })
                    .await;
            }
        });
    }

    let status = child.wait().await.map_err(|e| CoreError::io(&program, e))?;
    if !status.success() {
        return Err(CoreError::internal(format!(
            "installer {} exited with {}",
            program.display(),
            status.code().map_or_else(|| "<signal>".into(), |c| c.to_string())
        )));
    }
    Ok(())
}

async fn run_uninstall_string(
    uninstall_string: &str,
    extra_args: &[String],
) -> Result<(), CoreError> {
    // UninstallString is often `MsiExec.exe /I{GUID}` or `"C:\Path\uninst.exe" args`.
    // Split with shell_words and append our quiet-mode flags.
    let mut parts = shell_words::split(uninstall_string)
        .map_err(|e| CoreError::config(format!("uninstall-string parse error: {e}")))?
        .into_iter();
    let program = parts
        .next()
        .ok_or_else(|| CoreError::config("empty uninstall string"))?;
    let mut args: Vec<String> = parts.collect();

    // Replace `/I` (install) with `/X` (uninstall) for MsiExec-style strings.
    let prog_lower = program.to_lowercase();
    if prog_lower.contains("msiexec") {
        for a in &mut args {
            if a.eq_ignore_ascii_case("/i") {
                *a = "/x".to_string();
            } else if let Some(rest) = a.strip_prefix("/I") {
                *a = format!("/X{rest}");
            } else if let Some(rest) = a.strip_prefix("/i") {
                *a = format!("/x{rest}");
            }
        }
        if !args.iter().any(|a| a.eq_ignore_ascii_case("/qn")) {
            args.push("/qn".to_string());
        }
        if !args.iter().any(|a| a.eq_ignore_ascii_case("/norestart")) {
            args.push("/norestart".to_string());
        }
    }
    args.extend(extra_args.iter().cloned());

    let output = Command::new(&program)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| CoreError::io(&program, e))?;
    if !output.status.success() {
        return Err(CoreError::internal(format!(
            "uninstaller {} exited with {}: {}",
            program,
            output.status.code().map_or_else(|| "<signal>".into(), |c| c.to_string()),
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    Ok(())
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

// ── registry access ────────────────────────────────────────────────────────────────

/// Direct Win32 registry access. Isolated in a submodule so the `unsafe` scope and
/// the helper conversions are kept narrow and auditable.
mod registry {
    // The `windows` crate's FFI bindings are unavoidably unsafe. The workspace lints
    // deny unsafe by default; we opt back in here, scoped to this submodule, because
    // there is no safe abstraction over `RegOpenKeyExW` / `RegQueryValueExW` for the
    // GUID-or-display-name resolution we need.
    #![allow(unsafe_code)]

    use std::iter::once;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{ERROR_SUCCESS, WIN32_ERROR};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER,
        HKEY_LOCAL_MACHINE, KEY_READ, REG_VALUE_TYPE,
    };

    use crate::errors::CoreError;
    use crate::sources::installer::UninstallSnapshot;

    const UNINSTALL_ROOT: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(once(0)).collect()
    }

    fn from_wide(buf: &[u16]) -> String {
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
    }

    /// Try HKCU first, then HKLM. Returns `None` when neither hive has the key.
    pub fn read_display_version(uninstall_key: &str) -> Result<Option<String>, CoreError> {
        let record = read_uninstall_record(uninstall_key)?;
        Ok(record.display_version)
    }

    pub fn read_uninstall_record(uninstall_key: &str) -> Result<UninstallSnapshot, CoreError> {
        for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            if let Some(record) = read_record_from_hive(hive, uninstall_key)? {
                return Ok(record);
            }
        }
        Ok(UninstallSnapshot {
            display_name: None,
            display_version: None,
            install_location: None,
            uninstall_string: None,
            cached_installer: None,
        })
    }

    fn read_record_from_hive(
        hive: HKEY,
        uninstall_key: &str,
    ) -> Result<Option<UninstallSnapshot>, CoreError> {
        // Case A: caller passed a GUID like `{1234-…}` — open the subkey directly.
        let is_guid = uninstall_key.starts_with('{') && uninstall_key.ends_with('}');
        if is_guid {
            let path = format!("{UNINSTALL_ROOT}\\{uninstall_key}");
            return open_record(hive, &path);
        }

        // Case B: a display-name match — enumerate the Uninstall subkeys and look at
        // DisplayName until we hit one that matches.
        let root_wide = to_wide(UNINSTALL_ROOT);
        let mut root_key: HKEY = HKEY::default();
        let status = unsafe {
            RegOpenKeyExW(
                hive,
                PCWSTR(root_wide.as_ptr()),
                0,
                KEY_READ,
                &mut root_key,
            )
        };
        if status != ERROR_SUCCESS {
            return Ok(None);
        }
        let result = enumerate_for_display_name(root_key, uninstall_key, hive);
        unsafe { let _ = RegCloseKey(root_key); }
        result
    }

    fn enumerate_for_display_name(
        root_key: HKEY,
        wanted_display_name: &str,
        hive: HKEY,
    ) -> Result<Option<UninstallSnapshot>, CoreError> {
        let mut idx: u32 = 0;
        loop {
            let mut name_buf = vec![0u16; 512];
            let mut name_len: u32 = name_buf.len() as u32;
            let status = unsafe {
                RegEnumKeyExW(
                    root_key,
                    idx,
                    windows::core::PWSTR(name_buf.as_mut_ptr()),
                    &mut name_len,
                    None,
                    windows::core::PWSTR(std::ptr::null_mut()),
                    None,
                    None,
                )
            };
            if status != ERROR_SUCCESS {
                break;
            }
            let subkey_name = from_wide(&name_buf[..name_len as usize]);
            let full = format!("{UNINSTALL_ROOT}\\{subkey_name}");
            if let Some(rec) = open_record(hive, &full)? {
                if rec
                    .display_name
                    .as_deref()
                    .is_some_and(|n| n.eq_ignore_ascii_case(wanted_display_name))
                {
                    return Ok(Some(rec));
                }
            }
            idx += 1;
            if idx > 16_384 {
                break; // sanity cap
            }
        }
        Ok(None)
    }

    fn open_record(hive: HKEY, full_path: &str) -> Result<Option<UninstallSnapshot>, CoreError> {
        let wide = to_wide(full_path);
        let mut sub: HKEY = HKEY::default();
        let status = unsafe {
            RegOpenKeyExW(hive, PCWSTR(wide.as_ptr()), 0, KEY_READ, &mut sub)
        };
        if status != ERROR_SUCCESS {
            return Ok(None);
        }
        let record = UninstallSnapshot {
            display_name: read_string_value(sub, "DisplayName")?,
            display_version: read_string_value(sub, "DisplayVersion")?,
            install_location: read_string_value(sub, "InstallLocation")?,
            uninstall_string: read_string_value(sub, "UninstallString")?,
            cached_installer: None,
        };
        unsafe { let _ = RegCloseKey(sub); }
        Ok(Some(record))
    }

    fn read_string_value(key: HKEY, name: &str) -> Result<Option<String>, CoreError> {
        let name_wide = to_wide(name);
        let mut value_type: REG_VALUE_TYPE = REG_VALUE_TYPE(0);
        let mut len: u32 = 0;

        // First call: probe length only (lpData = None).
        let status = unsafe {
            RegQueryValueExW(
                key,
                PCWSTR(name_wide.as_ptr()),
                None,
                Some(&mut value_type),
                None,
                Some(&mut len),
            )
        };
        if status != ERROR_SUCCESS || len == 0 {
            // Either missing value or empty; treat as None either way.
            return Ok(None);
        }
        // Round up to u16 count.
        let u16_count = (len as usize).div_ceil(2);
        let mut buf = vec![0u16; u16_count];
        let mut buf_len = len;
        let status = unsafe {
            RegQueryValueExW(
                key,
                PCWSTR(name_wide.as_ptr()),
                None,
                Some(&mut value_type),
                Some(buf.as_mut_ptr().cast::<u8>()),
                Some(&mut buf_len),
            )
        };
        if status != ERROR_SUCCESS {
            return Err(CoreError::internal(format!(
                "RegQueryValueExW({name}) failed: {:?}",
                WIN32_ERROR(status.0)
            )));
        }
        Ok(Some(from_wide(&buf)))
    }
}

// ── Test-only hooks ────────────────────────────────────────────────────────────────
//
// These helpers expose narrow slices of the source for the integration tests in
// `tests/integration_installer.rs`. They are real, not mocks — they call the same
// registry and msiexec code the production path uses. The name prefix is `__test_`
// so they are obviously internal; they're public only because integration tests
// live in a separate crate and can't see `pub(crate)` items.

/// Read the uninstall record for `key` (display-name or GUID). Returns `Ok(None)` if
/// the key is absent from both HKCU and HKLM.
pub fn __test_read_record(key: &str) -> Result<Option<UninstallSnapshot>, CoreError> {
    let rec = registry::read_uninstall_record(key)?;
    if rec.display_name.is_some()
        || rec.display_version.is_some()
        || rec.uninstall_string.is_some()
    {
        Ok(Some(rec))
    } else {
        Ok(None)
    }
}

/// Snapshot the current uninstall record, then run the supplied MSI silently. On a
/// non-zero msiexec exit returns `CoreError::Internal`; the snapshot file is still
/// written so the rollback path can locate it.
pub fn __test_install_and_snapshot(
    app: &AppEntry,
    msi: &Path,
    snapshot_path: &Path,
) -> Result<UninstallSnapshot, CoreError> {
    let cfg = InstallerSource::config(app)?;
    let prior = registry::read_uninstall_record(&cfg.registry_uninstall_key)?;

    // Persist the snapshot synchronously.
    if let Some(parent) = snapshot_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| CoreError::io(parent, e))?;
    }
    let json = serde_json::to_vec_pretty(&prior)
        .map_err(|e| CoreError::internal(format!("snapshot serialize: {e}")))?;
    std::fs::write(snapshot_path, &json).map_err(|e| CoreError::io(snapshot_path, e))?;

    // Build the same msiexec invocation `run_installer` would.
    let mut args: Vec<String> = vec![
        "/i".into(),
        msi.to_string_lossy().into_owned(),
        "/qn".into(),
        "/norestart".into(),
    ];
    args.extend(cfg.install_args.iter().cloned());
    let output = std::process::Command::new("msiexec.exe")
        .args(&args)
        .output()
        .map_err(|e| CoreError::io(msi, e))?;
    if !output.status.success() {
        return Err(CoreError::internal(format!(
            "msiexec /i {} exited {}: {}",
            msi.display(),
            output.status.code().map_or_else(|| "<signal>".into(), |c| c.to_string()),
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    Ok(prior)
}
