//! Real integration tests for the `installer` source.
//!
//! These tests exercise the actual Windows Installer (msiexec) against tiny MSIs built
//! by `tests/fixtures/installers/build.ps1`. They write to the real per-user uninstall
//! registry hive (HKCU) — this is permitted by CONTRACT §2.2 (the MSIs are themselves
//! the fixtures; mocking the registry would defeat the test).
//!
//! Gated `#[cfg(windows)]`. If WiX Toolset is not on PATH the fixtures cannot be built
//! and every test in this file prints a clear skip line and returns Ok(()); there is no
//! silent pass.

#![cfg(windows)]
#![allow(
    clippy::missing_panics_doc,
    clippy::missing_errors_doc,
    clippy::match_wildcard_for_single_variants,
    clippy::uninlined_format_args,
    clippy::doc_markdown,
    clippy::missing_const_for_fn
)]

use std::path::{Path, PathBuf};
use std::process::Command as StdCommand;
use std::sync::OnceLock;

use iptv_hub_core::errors::CoreError;
use iptv_hub_core::manifest::types::{AppEntry, LaunchKind, LaunchSpec, SourceType};
use iptv_hub_core::sources::installer::UninstallSnapshot;

/// Unique uninstall-key display name shared by every fixture build.
const TEST_DISPLAY_NAME: &str = "IPTVHubTestApp";

/// Status returned by the fixture-build script. We probe it once per process.
enum FixtureStatus {
    Ready(FixturePaths),
    Skipped(String),
    Failed(String),
}

struct FixturePaths {
    v1: PathBuf,
    v2: PathBuf,
    broken: PathBuf,
    cache_dir: PathBuf,
}

static FIXTURE_STATUS: OnceLock<FixtureStatus> = OnceLock::new();

fn fixture_dir() -> PathBuf {
    // The test binary's cwd at runtime is the package's directory.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("installers")
}

fn build_fixtures() -> FixtureStatus {
    let dir = fixture_dir();
    let script = dir.join("build.ps1");
    if !script.exists() {
        return FixtureStatus::Failed(format!("fixture script missing at {}", script.display()));
    }

    let output = StdCommand::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&script)
        .output();
    let output = match output {
        Ok(o) => o,
        Err(e) => return FixtureStatus::Failed(format!("could not run build.ps1: {e}")),
    };

    let code = output.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    if code == 78 {
        return FixtureStatus::Skipped(stdout.trim().to_string());
    }
    if code != 0 {
        return FixtureStatus::Failed(format!(
            "build.ps1 exited with {code}\nstdout:\n{stdout}\nstderr:\n{stderr}"
        ));
    }

    let v1 = dir.join("IPTVHubTestApp_v1.0.0.msi");
    let v2 = dir.join("IPTVHubTestApp_v2.0.0.msi");
    let broken = dir.join("IPTVHubTestApp_broken.msi");
    for p in [&v1, &v2, &broken] {
        if !p.exists() {
            return FixtureStatus::Failed(format!("missing fixture: {}", p.display()));
        }
    }

    // Cache dir used by InstallerSource::apply.
    let cache_root = std::env::temp_dir().join("iptv-hub-agent-07-tests");
    let cache_dir = cache_root.join("cache").join("installers").join("test-app");
    let _ = std::fs::create_dir_all(&cache_dir);

    FixtureStatus::Ready(FixturePaths {
        v1,
        v2,
        broken,
        cache_dir: cache_root,
    })
}

fn ensure_fixtures() -> &'static FixtureStatus {
    FIXTURE_STATUS.get_or_init(build_fixtures)
}

fn skip(name: &str, reason: &str) {
    println!("WiX not detected -- test skipped: {name} ({reason})");
}

fn force_uninstall_test_app() {
    // Best-effort cleanup between tests. Searches HKCU for our display name and runs
    // the recorded UninstallString. Errors are ignored — leftover state is acceptable
    // because the next install replaces it.
    if let Ok(Some(snap)) = iptv_hub_core::sources::installer::__test_read_record(TEST_DISPLAY_NAME)
    {
        if let Some(unstr) = snap.uninstall_string {
            // Strip any quotes for parsing.
            let parts: Vec<String> = unstr
                .split('"')
                .enumerate()
                .flat_map(|(i, s)| {
                    if i % 2 == 1 {
                        vec![s.to_string()]
                    } else {
                        s.split_whitespace().map(str::to_string).collect()
                    }
                })
                .filter(|s| !s.is_empty())
                .collect();
            if let Some((prog, rest)) = parts.split_first() {
                let mut args: Vec<String> = rest
                    .iter()
                    .map(|a| {
                        if a.eq_ignore_ascii_case("/i") {
                            "/x".to_string()
                        } else if let Some(t) = a.strip_prefix("/I") {
                            format!("/X{t}")
                        } else if let Some(t) = a.strip_prefix("/i") {
                            format!("/x{t}")
                        } else {
                            a.clone()
                        }
                    })
                    .collect();
                if !args.iter().any(|a| a.eq_ignore_ascii_case("/qn")) {
                    args.push("/qn".into());
                }
                if !args.iter().any(|a| a.eq_ignore_ascii_case("/norestart")) {
                    args.push("/norestart".into());
                }
                let _ = StdCommand::new(prog).args(&args).status();
            }
        }
    }
}

fn fixture_app() -> AppEntry {
    let source_cfg = serde_json::json!({
        "vendor": "IPTV Hub Test Suite",
        "product_name": TEST_DISPLAY_NAME,
        "registry_uninstall_key": TEST_DISPLAY_NAME,
        "download_url": "file:///placeholder",
        "version_endpoint": "file:///placeholder",
        "version_json_path": "$.tag_name",
        "install_args": [],
        "uninstall_args": []
    });
    AppEntry {
        id: "test-app".into(),
        name: "Test App".into(),
        source_type: SourceType::Installer,
        favorite: false,
        enabled: true,
        icon: None,
        polling: None,
        launch: LaunchSpec {
            kind: LaunchKind::Executable,
            cwd: None,
            command: None,
            args: vec![],
            env: std::collections::HashMap::new(),
            wait_for: None,
        },
        health: None,
        source: Some(source_cfg),
        user_data: None,
    }
}

fn install_via_source(msi_path: &Path, cache_root: &Path) -> Result<UninstallSnapshot, CoreError> {
    // We bypass the network/download phase by writing the MSI into the cache and
    // calling the silent-install helper exported for tests. The end-to-end download
    // path is exercised by the release source's tests (Agent 06); for the installer
    // source we focus on the registry/snapshot/rollback half of the flow.
    let app = fixture_app();
    let cache_dir = cache_root.join("cache").join("installers").join(&app.id);
    std::fs::create_dir_all(&cache_dir).unwrap();
    // Copy the MSI to the cache with a deterministic name so rollback can find it.
    let staged = cache_dir.join("staged.msi");
    std::fs::copy(msi_path, &staged).unwrap();

    iptv_hub_core::sources::installer::__test_install_and_snapshot(
        &app,
        &staged,
        &cache_dir.join("snapshot.json"),
    )
}

#[test]
fn install_then_detect() {
    let status = ensure_fixtures();
    let FixtureStatus::Ready(paths) = status else {
        match status {
            FixtureStatus::Skipped(msg) => skip("install_then_detect", msg),
            FixtureStatus::Failed(msg) => panic!("fixture build failed: {msg}"),
            _ => unreachable!(),
        }
        return;
    };
    force_uninstall_test_app();

    install_via_source(&paths.v1, &paths.cache_dir).expect("install v1 should succeed");

    let after = iptv_hub_core::sources::installer::__test_read_record(TEST_DISPLAY_NAME).unwrap();
    let rec = after.expect("uninstall key should exist after install");
    assert_eq!(rec.display_name.as_deref(), Some(TEST_DISPLAY_NAME));
    assert_eq!(
        rec.display_version.as_deref(),
        Some("1.0.0"),
        "DisplayVersion in registry should be 1.0.0; got {:?}",
        rec.display_version
    );

    force_uninstall_test_app();
}

#[test]
fn upgrade_detects_new_version() {
    let status = ensure_fixtures();
    let FixtureStatus::Ready(paths) = status else {
        match status {
            FixtureStatus::Skipped(msg) => skip("upgrade_detects_new_version", msg),
            FixtureStatus::Failed(msg) => panic!("fixture build failed: {msg}"),
            _ => unreachable!(),
        }
        return;
    };
    force_uninstall_test_app();

    install_via_source(&paths.v1, &paths.cache_dir).expect("install v1 should succeed");
    install_via_source(&paths.v2, &paths.cache_dir).expect("upgrade to v2 should succeed");

    let after = iptv_hub_core::sources::installer::__test_read_record(TEST_DISPLAY_NAME).unwrap();
    let rec = after.expect("uninstall key should exist after upgrade");
    assert_eq!(
        rec.display_version.as_deref(),
        Some("2.0.0"),
        "DisplayVersion should be 2.0.0 after upgrade; got {:?}",
        rec.display_version
    );

    force_uninstall_test_app();
}

#[test]
fn broken_msi_rolls_back() {
    let status = ensure_fixtures();
    let FixtureStatus::Ready(paths) = status else {
        match status {
            FixtureStatus::Skipped(msg) => skip("broken_msi_rolls_back", msg),
            FixtureStatus::Failed(msg) => panic!("fixture build failed: {msg}"),
            _ => unreachable!(),
        }
        return;
    };
    force_uninstall_test_app();

    // Step 1: install v1 cleanly so we have a "prior version" to roll back to.
    install_via_source(&paths.v1, &paths.cache_dir).expect("install v1 should succeed");
    let before = iptv_hub_core::sources::installer::__test_read_record(TEST_DISPLAY_NAME)
        .unwrap()
        .expect("v1 should be installed");
    assert_eq!(before.display_version.as_deref(), Some("1.0.0"));

    // Step 2: attempting to install the broken MSI must fail (non-zero exit).
    let result = install_via_source(&paths.broken, &paths.cache_dir);
    assert!(
        result.is_err(),
        "broken MSI should fail to install; got {:?}",
        result
    );

    // Step 3: registry should still report 1.0.0 (the broken install didn't replace
    // the prior product because msiexec aborted before swapping).
    let after = iptv_hub_core::sources::installer::__test_read_record(TEST_DISPLAY_NAME)
        .unwrap()
        .expect("v1 should still be installed after failed broken install");
    assert_eq!(
        after.display_version.as_deref(),
        Some("1.0.0"),
        "rollback should leave v1 in place; got {:?}",
        after.display_version
    );

    force_uninstall_test_app();
}

#[test]
fn uninstall_cleans_registry() {
    let status = ensure_fixtures();
    let FixtureStatus::Ready(paths) = status else {
        match status {
            FixtureStatus::Skipped(msg) => skip("uninstall_cleans_registry", msg),
            FixtureStatus::Failed(msg) => panic!("fixture build failed: {msg}"),
            _ => unreachable!(),
        }
        return;
    };
    force_uninstall_test_app();

    install_via_source(&paths.v1, &paths.cache_dir).expect("install v1 should succeed");
    // Confirm presence first so the test fails clearly if install never landed.
    let pre = iptv_hub_core::sources::installer::__test_read_record(TEST_DISPLAY_NAME).unwrap();
    assert!(pre.is_some(), "v1 should be present before uninstall");

    // Run the recorded UninstallString.
    force_uninstall_test_app();

    let post = iptv_hub_core::sources::installer::__test_read_record(TEST_DISPLAY_NAME).unwrap();
    assert!(
        post.is_none()
            || post
                .as_ref()
                .and_then(|r| r.display_version.as_deref())
                .is_none(),
        "uninstall key should be absent or version cleared; got {:?}",
        post
    );
}
