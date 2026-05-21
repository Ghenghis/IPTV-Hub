//! Atomic manifest writer.
//!
//! Writes to `<path>.tmp`, renames the previous file to `<path>.bak`, then renames
//! `<path>.tmp` to `<path>`. On any error before the final rename the original file is
//! untouched.
//!
//! ## Concurrency
//!
//! Multiple processes (or multiple tokio tasks on the same process) may legitimately
//! attempt to update `apps.json` at the same time — for example a poller writing back a
//! cached SHA at the same moment the user toggles the favourite flag from the UI. To
//! prevent the rename dance from interleaving, every write takes a cross-process
//! advisory file lock on `<path>.lock` via [`fs2::FileExt::try_lock_exclusive`] before
//! it touches any temp file, and releases the lock after the final rename.
//!
//! The lock is acquired with a short retry loop (5 tries, 100ms apart) so that two
//! near-simultaneous writes complete in series instead of one of them failing. If the
//! lock is still held after all retries, the call returns a `CoreError::Io` with the
//! message `"another writer holds the manifest lock"` so the caller can report it.

use std::path::Path;
use std::time::Duration;

use fs2::FileExt;

use crate::errors::CoreError;
use crate::manifest::types::Manifest;

/// Number of times to retry the exclusive lock before giving up.
const LOCK_RETRIES: u32 = 5;

/// Delay between lock retries.
const LOCK_RETRY_DELAY: Duration = Duration::from_millis(100);

/// Write `manifest` to `path` atomically.
///
/// Acquires `<path>.lock` (advisory, cross-process), writes `<path>.tmp`, renames any
/// existing `<path>` to `<path>.bak`, then renames `<path>.tmp` to `<path>`. The lock is
/// released before the function returns.
pub async fn write_atomic(path: &Path, manifest: &Manifest) -> Result<(), CoreError> {
    let parent = path.parent().ok_or_else(|| {
        CoreError::config(format!("manifest path {} has no parent", path.display()))
    })?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| CoreError::io(parent, e))?;

    let lock_path = path.with_extension("json.lock");
    let tmp = path.with_extension("json.tmp");
    let bak = path.with_extension("json.bak");

    let _guard = acquire_lock(&lock_path).await?;

    let mut value = serde_json::to_value(manifest)
        .map_err(|e| CoreError::config(format!("serialize manifest: {e}")))?;
    // `Option<T>` fields on `Manifest`/`AppEntry`/`LaunchSpec` serialize as JSON `null` by
    // default; the schema treats those fields as typed objects/strings and rejects null.
    // Stripping null leaves are equivalent to "field absent" which is what the schema
    // wants for unset optionals.
    strip_null_fields(&mut value);
    let json = serde_json::to_vec_pretty(&value)
        .map_err(|e| CoreError::config(format!("serialize manifest: {e}")))?;
    tokio::fs::write(&tmp, &json)
        .await
        .map_err(|e| CoreError::io(&tmp, e))?;

    if path.exists() {
        // Best-effort backup; if this fails, abort.
        tokio::fs::rename(path, &bak)
            .await
            .map_err(|e| CoreError::io(path, e))?;
    }
    tokio::fs::rename(&tmp, path)
        .await
        .map_err(|e| CoreError::io(path, e))?;

    // _guard drops here and releases the advisory lock.
    Ok(())
}

/// Owns the locked sentinel file for the lifetime of a single write.
///
/// Dropping the guard releases the OS advisory lock; the file itself is left in place so
/// future writes can reuse it without paying the cost of creating it from scratch.
struct LockGuard {
    file: std::fs::File,
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        // Releasing the lock can fail only if the file handle is bogus, which would be a
        // bug in this module. There is no meaningful recovery here: the OS releases the
        // lock when the file handle closes regardless, so we deliberately swallow the
        // result. We do not log because dropping happens on the success path of every
        // write and noisy logs are worse than a one-line drop.
        let _ = FileExt::unlock(&self.file);
    }
}

/// Try to acquire the exclusive lock with [`LOCK_RETRIES`] retries. Returns the guard
/// on success; returns `CoreError::Io { message: "another writer holds the manifest lock" }`
/// when every retry sees the lock held.
async fn acquire_lock(lock_path: &Path) -> Result<LockGuard, CoreError> {
    // The lock file is opened with read+write+create so callers running as different
    // users on the same machine still share the same advisory primitive.
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)
        .map_err(|e| CoreError::io(lock_path, e))?;

    for attempt in 0..LOCK_RETRIES {
        match FileExt::try_lock_exclusive(&file) {
            Ok(()) => return Ok(LockGuard { file }),
            Err(e) => {
                // `WouldBlock` (Unix) and `ERROR_LOCK_VIOLATION` (Windows) both surface
                // through fs2 as a non-fatal error kind we should retry. Any other
                // error is fatal.
                let kind = e.kind();
                if !is_lock_held_error(&e) {
                    return Err(CoreError::Io {
                        path: lock_path.to_string_lossy().into_owned(),
                        message: format!("lock acquire ({kind:?}): {e}"),
                    });
                }
                if attempt + 1 < LOCK_RETRIES {
                    tokio::time::sleep(LOCK_RETRY_DELAY).await;
                }
            }
        }
    }

    Err(CoreError::Io {
        path: lock_path.to_string_lossy().into_owned(),
        message: "another writer holds the manifest lock".to_string(),
    })
}

/// True if the error indicates the lock is currently held by another process, in which
/// case retrying is meaningful. False for genuine failures like a missing parent dir or
/// a permission error, where retrying is pointless.
///
/// `fs2` returns a platform-specific raw OS code on contention:
/// * Unix — `EWOULDBLOCK` (33 on some, 11 on Linux, 35 on macOS), surfaced as
///   `ErrorKind::WouldBlock` by `std::io`.
/// * Windows — `ERROR_LOCK_VIOLATION` (33), surfaced as `ErrorKind::Uncategorized`.
///
/// `fs2::lock_contended_error()` returns the canonical contention error for the current
/// platform, so we compare against its raw OS code to stay portable.
fn is_lock_held_error(e: &std::io::Error) -> bool {
    let canonical = fs2::lock_contended_error();
    matches!(e.kind(), std::io::ErrorKind::WouldBlock)
        || e.raw_os_error().is_some() && e.raw_os_error() == canonical.raw_os_error()
}

/// Recursively remove keys whose values are JSON `null` from every object in `value`.
///
/// The Rust manifest types use `Option<T>` for genuinely optional fields and serde
/// emits `Some(_) => <value>` and `None => null`. The JSON Schema treats every named
/// property as either an object, a string, or a typed sub-schema — never nullable — so
/// the `null` form fails validation. We could ask the type owner to add
/// `#[serde(skip_serializing_if = "Option::is_none")]` to every optional field, but that
/// crosses an agent boundary; doing it here keeps the manifest module's invariant local.
///
/// Arrays are walked element-wise so optional fields nested inside `apps[*]` are also
/// cleaned. Non-null primitives are left exactly as-is.
fn strip_null_fields(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            map.retain(|_, v| !v.is_null());
            for v in map.values_mut() {
                strip_null_fields(v);
            }
        }
        serde_json::Value::Array(items) => {
            for v in items.iter_mut() {
                strip_null_fields(v);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strip_null_fields_removes_top_level_nulls() {
        let mut v = json!({ "a": 1, "b": null });
        strip_null_fields(&mut v);
        assert_eq!(v, json!({ "a": 1 }));
    }

    #[test]
    fn strip_null_fields_recurses_through_arrays_and_objects() {
        let mut v = json!({
            "outer": null,
            "list": [
                { "keep": "yes", "drop": null },
                { "nested": { "drop": null, "keep": 42 } }
            ]
        });
        strip_null_fields(&mut v);
        assert_eq!(
            v,
            json!({
                "list": [
                    { "keep": "yes" },
                    { "nested": { "keep": 42 } }
                ]
            })
        );
    }
}
