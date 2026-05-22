//! Integration tests for the manifest loader/writer (Agent 15).
//!
//! Per CONTRACT.md §2.2 (no mock-only test strategy) these tests drive the real
//! [`iptv_hub_core::manifest`] API end-to-end against real fixtures on disk. Each test
//! copies a fixture file into a temp directory, then calls the public load/write API.
//! No mocking; no canned responses; the loader and writer are exercised in full.
//!
//! Coverage map (matches the error-path catalogue in `docs/MANIFEST_SCHEMA.md` §10):
//!
//! * `loads_well_formed_v1` — happy path, current schema.
//! * `migrates_v0_to_v1_and_persists` — legacy fixture migrates, the upgraded form is
//!   written back, the original is preserved at .bak.
//! * `rejects_malformed_json` — truncated brace → parse error.
//! * `rejects_duplicate_id` — two apps with the same id → config error.
//! * `rejects_missing_required` — entry without `name` → schema error.
//! * `rejects_unknown_source_type` — entry with bogus `type` → schema error.
//! * `concurrent_writes_serialized_by_lock` — two simultaneous writes complete without
//!   corrupting the on-disk file.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use iptv_hub_core::manifest::loader::load_and_validate;
use iptv_hub_core::manifest::types::Manifest;
use iptv_hub_core::manifest::writer::write_atomic;
use tempfile::TempDir;

/// Path to the workspace-level fixtures directory shared with other agents.
fn fixtures_dir() -> PathBuf {
    // CARGO_MANIFEST_DIR resolves to src-tauri/; the shared fixtures live one level up.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent")
        .join("tests")
        .join("fixtures")
        .join("manifests")
}

/// Copy `name` from the shared fixtures dir into a temp dir as `apps.json` and return
/// the destination path plus the temp dir handle (kept alive by the caller).
fn stage_fixture(name: &str) -> (TempDir, PathBuf) {
    let tmp = TempDir::new().expect("tempdir");
    let dest = tmp.path().join("apps.json");
    let src = fixtures_dir().join(name);
    std::fs::copy(&src, &dest)
        .unwrap_or_else(|e| panic!("copy {} → {}: {e}", src.display(), dest.display()));
    (tmp, dest)
}

/// Stage the well-formed v1 example shipped under `schema/examples/`.
fn stage_example_v1() -> (TempDir, PathBuf) {
    let tmp = TempDir::new().expect("tempdir");
    let dest = tmp.path().join("apps.json");
    let src = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent")
        .join("schema")
        .join("examples")
        .join("example-git.json");
    std::fs::copy(&src, &dest)
        .unwrap_or_else(|e| panic!("copy {} → {}: {e}", src.display(), dest.display()));
    (tmp, dest)
}

/// Sanity check: the fixture file exists on disk before we try to stage it.
fn assert_fixture_exists(name: &str) {
    let p = fixtures_dir().join(name);
    assert!(
        p.exists(),
        "fixture {} missing (expected at {})",
        name,
        p.display()
    );
}

#[tokio::test]
async fn loads_well_formed_v1() {
    let (_tmp, path) = stage_example_v1();
    let manifest = load_and_validate(&path).await.expect("load v1");
    assert_eq!(manifest.schema_version, 1);
    assert!(
        !manifest.apps.is_empty(),
        "well-formed example must contain at least one app"
    );
    assert_eq!(manifest.apps[0].id, "iptvnator");
}

#[tokio::test]
async fn migrates_v0_to_v1_and_persists() {
    assert_fixture_exists("v0_legacy.json");
    let (tmp, path) = stage_fixture("v0_legacy.json");

    // Capture the bytes of the original v0 file so we can compare against the .bak
    // produced by the in-place migration.
    let original_bytes = std::fs::read(&path).expect("read original v0");

    // 1) First load: migration runs, on-disk file is upgraded, .bak is created.
    let manifest = load_and_validate(&path).await.expect("load v0 (migrates)");
    assert_eq!(
        manifest.schema_version, 1,
        "loaded manifest must be v1 after migration"
    );
    assert_eq!(manifest.apps.len(), 1);
    assert_eq!(manifest.apps[0].id, "legacy-app");
    assert_eq!(
        manifest.apps[0].source_type,
        iptv_hub_core::manifest::types::SourceType::Git
    );

    // 2) The on-disk file was rewritten in v1 shape.
    let on_disk_after: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).expect("read post-migration"))
            .expect("on-disk is JSON");
    assert_eq!(on_disk_after["schema_version"], 1);
    assert_eq!(on_disk_after["apps"][0]["type"], "git");
    assert!(
        on_disk_after["apps"][0].get("source_type").is_none(),
        "v0 field 'source_type' must be gone after migration"
    );

    // 3) Original is preserved at <path>.bak.
    let bak_path = path.with_extension("json.bak");
    assert!(
        bak_path.exists(),
        "atomic write must leave a .bak at {}",
        bak_path.display()
    );
    let bak_bytes = std::fs::read(&bak_path).expect("read .bak");
    assert_eq!(
        bak_bytes, original_bytes,
        ".bak must hold the verbatim pre-migration file"
    );

    // 4) Second load is a no-op migration (the file is already v1).
    let again = load_and_validate(&path).await.expect("reload v1");
    assert_eq!(again.schema_version, 1);
    assert_eq!(again, manifest);

    drop(tmp);
}

#[tokio::test]
async fn rejects_malformed_json() {
    assert_fixture_exists("bad_malformed.json");
    let (_tmp, path) = stage_fixture("bad_malformed.json");
    let err = load_and_validate(&path)
        .await
        .expect_err("malformed JSON must error");
    let msg = err.to_string();
    assert!(msg.contains("parse"), "expected parse error, got: {msg}");
}

#[tokio::test]
async fn rejects_duplicate_id() {
    assert_fixture_exists("bad_duplicate_id.json");
    let (_tmp, path) = stage_fixture("bad_duplicate_id.json");
    let err = load_and_validate(&path)
        .await
        .expect_err("duplicate id must error");
    let msg = err.to_string();
    assert!(
        msg.contains("duplicate") && msg.contains("foo"),
        "expected duplicate-id error mentioning 'foo', got: {msg}"
    );
}

#[tokio::test]
async fn rejects_missing_required() {
    assert_fixture_exists("bad_missing_required.json");
    let (_tmp, path) = stage_fixture("bad_missing_required.json");
    let err = load_and_validate(&path)
        .await
        .expect_err("missing-required must error");
    let msg = err.to_string();
    assert!(
        msg.contains("name") || msg.contains("required"),
        "expected error mentioning the missing 'name' field, got: {msg}"
    );
}

#[tokio::test]
async fn rejects_unknown_source_type() {
    assert_fixture_exists("bad_unknown_source_type.json");
    let (_tmp, path) = stage_fixture("bad_unknown_source_type.json");
    let err = load_and_validate(&path)
        .await
        .expect_err("unknown source type must error");
    let msg = err.to_string();
    assert!(
        msg.contains("carrier-pigeon") || msg.contains("enum"),
        "expected enum-violation message naming 'carrier-pigeon', got: {msg}"
    );
}

#[tokio::test]
async fn concurrent_writes_serialized_by_lock() {
    // Two concurrent writes against the same manifest path must both succeed without
    // corrupting the on-disk file. The advisory lock in writer.rs serialises them; the
    // last writer wins (either of the two valid manifests is an acceptable end state)
    // and the file always parses + validates.
    let tmp = TempDir::new().expect("tempdir");
    let path: Arc<PathBuf> = Arc::new(tmp.path().join("apps.json"));

    // Seed the initial file so the writer's rename-to-.bak path is exercised by both
    // concurrent writers.
    let seed = base_manifest("alpha");
    write_atomic(&path, &seed).await.expect("seed write");

    let path_a = Arc::clone(&path);
    let path_b = Arc::clone(&path);

    let task_a = tokio::spawn(async move {
        let m = base_manifest("alpha-updated");
        write_atomic(&path_a, &m).await.expect("writer A");
    });
    let task_b = tokio::spawn(async move {
        let m = base_manifest("beta-updated");
        write_atomic(&path_b, &m).await.expect("writer B");
    });

    let (ra, rb) = tokio::join!(task_a, task_b);
    ra.expect("task A joined");
    rb.expect("task B joined");

    // The final on-disk file must parse, validate, and be one of the two valid states.
    let reloaded = load_and_validate(path.as_path())
        .await
        .expect("post-concurrent load");
    assert_eq!(reloaded.apps.len(), 1);
    let id = reloaded.apps[0].id.as_str();
    assert!(
        id == "alpha-updated" || id == "beta-updated",
        "post-concurrent id was {id}; expected one of the two writers' values"
    );
}

/// Helper: build a minimal valid manifest with a single git app.
fn base_manifest(app_id: &str) -> Manifest {
    let raw = serde_json::json!({
        "schema_version": 1,
        "apps_root": "C:\\IPTV",
        "user_data_root": "C:\\IPTV\\user-data",
        "cache_root": "C:\\IPTV\\cache",
        "apps": [
            {
                "id": app_id,
                "name": app_id,
                "type": "git",
                "launch": { "kind": "executable" },
                "source": { "url": "https://example.com/x.git", "branch": "main" }
            }
        ]
    });
    serde_json::from_value(raw).expect("base manifest must deserialize")
}

// Keep this trait used so an unused-import lint does not fire if a later refactor stops
// calling load_and_validate directly. The function is referenced above; this assertion
// just keeps the symbol visible even when the test binary is re-cut.
#[allow(dead_code)]
fn _assert_path_traits<P: AsRef<Path>>(_: P) {}
