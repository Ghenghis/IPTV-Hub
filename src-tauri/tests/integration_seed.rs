//! Integration test for the seed-from-folder scanner (Agent 24).
//!
//! Per CONTRACT.md §2.2 (no mock-only test strategy) this test exercises the real
//! [`iptv_hub_core::seed::scan_directory`] API end-to-end against a real temporary
//! directory tree. The tree mirrors the 28-folder canonical input list from
//! `docs/AGENT_PLAN.md` §24 — every classifier branch is exercised by at least one
//! entry:
//!
//! * `.git` only                  → `git`
//! * `.git` + `package.json`       → `git` (rule 1 wins over rule 2)
//! * `package.json` with `dev`     → `web` (port parsed from the script)
//! * sibling `.lnk`                → `installer`
//! * sibling `.ipk`                → `tizen-ipk`
//! * `.exe` only                   → executable launch (no source)
//!
//! The expected output is checked into `tests/fixtures/seed/expected-apps.json`. The
//! test asserts byte-for-byte equality between the scanner's serialised output and
//! the golden file, after sorting both by `id` for determinism. The fixture tree is
//! built fresh in `tempfile::TempDir` on every run — we never ship 28 stub folders
//! in the repo.

use std::fs;
use std::path::{Path, PathBuf};

use iptv_hub_core::manifest::types::AppEntry;
use iptv_hub_core::seed::scan_directory;
use pretty_assertions::assert_eq;
use tempfile::TempDir;

/// Path to the shared workspace-level fixture file (the golden output).
fn expected_fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent")
        .join("tests")
        .join("fixtures")
        .join("seed")
        .join("expected-apps.json")
}

/// Build the canonical 28-folder fixture tree under `root`. Each helper creates only
/// the minimum sentinel files needed to trigger the right classifier branch:
///
/// * `git_repo` writes a `.git/HEAD` to satisfy `.git` is-directory check.
/// * `web_project` writes a `package.json` with a `dev` script.
/// * `exe_only` writes a single `.exe` (a zero-byte file is enough — the scanner
///   only inspects the extension).
/// * `installer_with_lnk` writes a sibling `.lnk` so rule 3 fires.
/// * `tizen_with_ipk` writes a sibling `.ipk` so rule 4 fires.
fn build_fixture_tree(root: &Path) {
    // Rule 1 — git repos.
    let git_only = [
        "cinexa",
        "Extreme-InfiniTV",
        "free-tv-iptv",
        "HarmonyIPTV",
        "IPTauriV",
        "iptv",
        "IPTV-Restream",
        "neptune-tv",
        "open-tv",
        "orbiscast",
        "stalker-ui",
        "TVapp",
        "xstream-player",
        "ynotv",
    ];
    for name in git_only {
        git_repo(root, name);
    }
    // Rule 1 wins over rule 2 when both are present — iptvnator has both.
    git_repo(root, "iptvnator");
    write_file(&root.join("iptvnator").join("package.json"), "{}");

    // Rule 2 — web projects (package.json, no .git).
    web_project(root, "NuvioWeb", "vite"); // no --port → default 5173
    web_project(root, "react-iptv", "vite --port 5174");
    web_project(root, "Smart-IPTV-Web", "vite --port=5175");

    // Rule 3 — sibling `.lnk` shortcuts.
    installer_with_lnk(root, "AuthoIPTV");
    installer_with_lnk(root, "Fred.TV");
    installer_with_lnk(root, "iptv-desktop");

    // Rule 4 — sibling `.ipk`.
    tizen_with_ipk(root, "crunchyroll-tizen");

    // Rule 5 — bare `.exe` (no other markers).
    exe_only(root, "clubtivi-windows", "clubtivi.exe");
    exe_only(root, "iptv-stream", "iptv-stream.exe");
    exe_only(root, "MaxVideoPlayer", "MaxVideoPlayer.exe");
    exe_only(root, "PiTV", "PiTV.exe");
    exe_only(root, "stremio", "stremio.exe");
    exe_only(root, "wizju-iptv-player", "wizju-player.exe");
}

fn git_repo(root: &Path, name: &str) {
    let dir = root.join(name);
    fs::create_dir_all(dir.join(".git")).expect("mkdir .git");
    // `.git/HEAD` makes the directory recognisable as a real git layout. The scanner
    // doesn't read it — the rule is purely "does `.git/` exist?" — but writing it
    // documents intent and would let other Git callers reuse the fixture.
    write_file(&dir.join(".git").join("HEAD"), "ref: refs/heads/main\n");
}

fn web_project(root: &Path, name: &str, dev_script: &str) {
    let dir = root.join(name);
    fs::create_dir_all(&dir).expect("mkdir web project");
    let pkg = format!(r#"{{ "name": "{name}", "scripts": {{ "dev": "{dev_script}" }} }}"#,);
    write_file(&dir.join("package.json"), &pkg);
}

fn installer_with_lnk(root: &Path, name: &str) {
    let dir = root.join(name);
    fs::create_dir_all(&dir).expect("mkdir installer");
    // Sibling .lnk lives in the *parent* (the apps root), not inside the dir itself.
    write_file(&root.join(format!("{name}.lnk")), "");
}

fn tizen_with_ipk(root: &Path, name: &str) {
    let dir = root.join(name);
    fs::create_dir_all(&dir).expect("mkdir tizen");
    write_file(&root.join(format!("{name}.ipk")), "");
}

fn exe_only(root: &Path, name: &str, exe_name: &str) {
    let dir = root.join(name);
    fs::create_dir_all(&dir).expect("mkdir exe-only");
    write_file(&dir.join(exe_name), "");
}

fn write_file(path: &Path, contents: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("mkdir parent");
    }
    fs::write(path, contents).expect("write file");
}

/// Strip the `command` field from any `tizen-deploy` launch entry. The deploy path
/// embeds the absolute tempdir path so it differs between runs; the golden fixture
/// records the *relative* sibling filename. We compare the launch command separately
/// against the expected basename.
fn normalise_for_diff(apps: &mut [AppEntry]) {
    for app in apps {
        if matches!(
            app.launch.kind,
            iptv_hub_core::manifest::types::LaunchKind::TizenDeploy
        ) {
            if let Some(cmd) = app.launch.command.take() {
                // Replace with just the file name so the golden fixture is portable.
                let path = std::path::Path::new(&cmd);
                let base = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or(cmd);
                app.launch.command = Some(base);
            }
        }
    }
}

#[tokio::test]
async fn scans_full_28_folder_tree_against_golden_fixture() {
    let tmp = TempDir::new().expect("tempdir");
    build_fixture_tree(tmp.path());

    let mut result = scan_directory(tmp.path()).await.expect("scan_directory");

    // 28 candidate folders → 28 entries. Nothing should land in `unclassified`.
    assert_eq!(
        result.apps.len(),
        28,
        "expected 28 entries, got {}: {:?}",
        result.apps.len(),
        result.apps.iter().map(|a| &a.id).collect::<Vec<_>>()
    );
    assert!(
        result.unclassified.is_empty(),
        "unexpected unclassified directories: {:?}",
        result.unclassified
    );

    normalise_for_diff(&mut result.apps);

    let expected_raw = fs::read_to_string(expected_fixture_path()).expect("read expected fixture");
    let expected_value: serde_json::Value =
        serde_json::from_str(&expected_raw).expect("parse expected fixture");
    let expected_apps: Vec<AppEntry> = serde_json::from_value(
        expected_value
            .get("apps")
            .cloned()
            .expect("fixture has apps field"),
    )
    .expect("decode expected apps");

    assert_eq!(
        result.apps.len(),
        expected_apps.len(),
        "fixture apps count mismatch"
    );

    // Compare entry-by-entry first so any diff prints the offending id, then assert
    // the full vector for a top-level equality check.
    for (got, want) in result.apps.iter().zip(expected_apps.iter()) {
        assert_eq!(got.id, want.id, "id order mismatch");
        assert_eq!(got, want, "entry mismatch for id={}", got.id);
    }
    assert_eq!(result.apps, expected_apps);
}

#[tokio::test]
async fn rejects_non_directory_root() {
    let tmp = TempDir::new().expect("tempdir");
    let file = tmp.path().join("not-a-dir.txt");
    fs::write(&file, "hi").expect("write");
    let err = scan_directory(&file).await.expect_err("should error");
    let msg = format!("{err}");
    assert!(msg.contains("seed scan root"), "unexpected error: {msg}");
}

#[tokio::test]
async fn empty_root_yields_empty_result() {
    let tmp = TempDir::new().expect("tempdir");
    let r = scan_directory(tmp.path()).await.expect("scan empty");
    assert!(r.apps.is_empty());
    assert!(r.unclassified.is_empty());
}
