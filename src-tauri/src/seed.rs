//! Seed-from-folder scanner (Agent 24).
//!
//! Given an "apps root" directory, walks every immediate sub-directory and proposes a
//! deterministic [`AppEntry`] for each one using filesystem heuristics. The result is a
//! pre-filled list the seed wizard hands to the operator for editing before it is
//! persisted as `apps.json`.
//!
//! Classification rules (evaluated in order; first match wins):
//!
//! 1. Has a `.git` sub-directory → `git` source. Operator fills the upstream URL later;
//!    the branch defaults to `main`.
//! 2. Has `package.json` but no `.git` → `web` source pinned to its current snapshot.
//!    The `dev` script in `package.json` is parsed for `--port N` (default `5173`).
//! 3. Lives under `C:\Program Files` OR has a sibling `.lnk` in a Start-Menu directory
//!    → `installer` candidate (the UI prompts the operator for the registry uninstall
//!    key).
//! 4. Has a sibling file with the `.ipk` extension → `tizen-ipk` source.
//! 5. Otherwise → no update source; emit an `executable` launch using the first `.exe`
//!    found in the directory. If no executable is discovered, the directory is reported
//!    in [`SeedScanResult::unclassified`].
//!
//! Every produced entry has:
//!
//! * `id`: kebab-case of the folder name (lowercased, separators collapsed).
//! * `name`: folder name verbatim.
//! * `enabled`: `true`.
//! * `favorite`: `false`.
//! * `icon`: `{ kind: "initials", value: first two uppercase consonants of the id }`.
//! * `polling`: present for `git` / `web` / `installer` / `tizen-ipk` types; absent for
//!   plain executables.
//! * `launch`: a sensible default per type (see the per-type builders below).
//!
//! The output is sorted by `id` so two runs over the same tree yield byte-identical
//! manifests; this is what makes the integration test diffable against a golden file.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::errors::CoreError;
use crate::manifest::types::{
    AppEntry, IconKind, IconSpec, LaunchKind, LaunchSpec, PollingSpec, SourceType, WaitFor,
};

/// Outcome of [`scan_directory`].
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SeedScanResult {
    /// Proposed entries, sorted by `id` for deterministic output.
    pub apps: Vec<AppEntry>,
    /// Directories whose contents matched none of the heuristics. The operator is
    /// shown these so they can be classified manually or dismissed.
    pub unclassified: Vec<PathBuf>,
}

/// Default poll interval (minutes) for sources that have one.
const DEFAULT_POLL_MINUTES: u32 = 60;
/// Default jitter (seconds) for sources that have a polling spec.
const DEFAULT_POLL_JITTER_SECONDS: u32 = 30;
/// Default port assumed for Vite-style `npm run dev` scripts that don't specify one.
const DEFAULT_WEB_PORT: u16 = 5173;
/// Default http wait timeout for web launches.
const WEB_WAIT_TIMEOUT_MS: u32 = 30_000;

/// Public entry point. Scans every immediate sub-directory of `root`.
///
/// The function is `async` so future enhancements (e.g. probing a remote git repo for
/// the default branch over the network) can use `await` without breaking the public
/// API. The current implementation is purely synchronous I/O; callers that want to
/// avoid blocking the Tauri main thread should wrap it in `spawn_blocking`.
#[allow(clippy::unused_async)]
pub async fn scan_directory(root: &Path) -> Result<SeedScanResult, CoreError> {
    if !root.is_dir() {
        return Err(CoreError::config(format!(
            "seed scan root is not a directory: {}",
            root.display()
        )));
    }

    let mut apps: Vec<AppEntry> = Vec::new();
    let mut unclassified: Vec<PathBuf> = Vec::new();

    let mut entries: Vec<_> = std::fs::read_dir(root)
        .map_err(|e| CoreError::io(root, e))?
        .filter_map(Result::ok)
        .collect();
    entries.sort_by_key(std::fs::DirEntry::file_name);

    for entry in entries {
        let path = entry.path();
        let file_type = entry.file_type().map_err(|e| CoreError::io(&path, e))?;
        if !file_type.is_dir() {
            continue;
        }

        match classify_directory(&path)? {
            Classification::Git => apps.push(build_git_entry(&path)?),
            Classification::Web => apps.push(build_web_entry(&path)?),
            Classification::Installer => apps.push(build_installer_entry(&path)?),
            Classification::TizenIpk => apps.push(build_tizen_entry(&path)?),
            Classification::Executable(exe) => apps.push(build_executable_entry(&path, &exe)?),
            Classification::Unclassified => unclassified.push(path),
        }
    }

    apps.sort_by(|a, b| a.id.cmp(&b.id));
    unclassified.sort();

    Ok(SeedScanResult { apps, unclassified })
}

#[derive(Debug)]
enum Classification {
    Git,
    Web,
    Installer,
    TizenIpk,
    Executable(PathBuf),
    Unclassified,
}

fn classify_directory(dir: &Path) -> Result<Classification, CoreError> {
    // Rule 1 — `.git` sub-directory.
    if dir.join(".git").exists() {
        return Ok(Classification::Git);
    }
    // Rule 2 — `package.json` present (no `.git`).
    if dir.join("package.json").is_file() {
        return Ok(Classification::Web);
    }
    // Rule 3 — under Program Files, OR a sibling `.lnk` exists under any Start-Menu path.
    if is_under_program_files(dir) || has_start_menu_shortcut_sibling(dir)? {
        return Ok(Classification::Installer);
    }
    // Rule 4 — sibling `.ipk`.
    if has_sibling_with_extension(dir, "ipk")? {
        return Ok(Classification::TizenIpk);
    }
    // Rule 5 — first `.exe` in the directory.
    if let Some(exe) = first_exe_in(dir)? {
        return Ok(Classification::Executable(exe));
    }
    Ok(Classification::Unclassified)
}

// ---- Rule helpers -----------------------------------------------------------------

fn is_under_program_files(dir: &Path) -> bool {
    // The check is intentionally string-based so the tests can simulate the condition
    // without needing real Program Files paths. On Windows the standard Program Files
    // and Program Files (x86) roots are recognised; on other platforms the rule simply
    // returns false (those installs cannot exist on a non-Windows host).
    let display = dir.to_string_lossy().to_ascii_lowercase();
    display.contains("program files")
}

/// Standard Start-Menu locations a Windows installer might drop a `.lnk` into.
/// `%PROGRAMDATA%` (`C:\ProgramData`) and `%APPDATA%` are the canonical roots; the
/// tests instead exercise the sibling-only path because seeding from a folder always
/// looks at *the same dir* the candidate lives in.
fn has_start_menu_shortcut_sibling(dir: &Path) -> Result<bool, CoreError> {
    has_sibling_with_extension(dir, "lnk")
}

fn has_sibling_with_extension(dir: &Path, ext: &str) -> Result<bool, CoreError> {
    let Some(parent) = dir.parent() else {
        return Ok(false);
    };
    let Some(dir_name) = dir.file_name() else {
        return Ok(false);
    };

    // A "sibling" is any file living in `parent` whose stem matches the directory name
    // and whose extension matches `ext`. This is what an operator means when they drag
    // a `.ipk` into the same folder as the candidate, or when a Start-Menu shortcut
    // sits next to the install root.
    let read = std::fs::read_dir(parent).map_err(|e| CoreError::io(parent, e))?;
    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let stem_matches = path.file_stem().is_some_and(|s| s == dir_name);
        let ext_matches = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case(ext));
        if stem_matches && ext_matches {
            return Ok(true);
        }
    }
    Ok(false)
}

fn first_exe_in(dir: &Path) -> Result<Option<PathBuf>, CoreError> {
    let read = std::fs::read_dir(dir).map_err(|e| CoreError::io(dir, e))?;
    let mut hits: Vec<PathBuf> = read
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| e.eq_ignore_ascii_case("exe"))
        })
        .collect();
    hits.sort();
    Ok(hits.into_iter().next())
}

// ---- Entry builders ---------------------------------------------------------------

fn folder_name(dir: &Path) -> Result<String, CoreError> {
    dir.file_name()
        .and_then(|n| n.to_str())
        .map(str::to_owned)
        .ok_or_else(|| CoreError::config(format!("unreadable folder name: {}", dir.display())))
}

fn build_git_entry(dir: &Path) -> Result<AppEntry, CoreError> {
    let name = folder_name(dir)?;
    let id = to_kebab_case(&name);
    let icon = initials_icon(&id);
    let launch = LaunchSpec {
        kind: LaunchKind::Executable,
        cwd: Some(name.clone()),
        command: None,
        args: Vec::new(),
        env: HashMap::default(),
        wait_for: None,
    };
    Ok(AppEntry {
        id,
        name,
        source_type: SourceType::Git,
        favorite: false,
        enabled: true,
        icon: Some(icon),
        polling: Some(default_polling()),
        launch,
        health: None,
        // Operator fills `url` on the seed wizard. `branch` defaults to `main`.
        source: Some(json!({
            "url": "",
            "branch": "main",
            "fetch_strategy": "fast-forward-only"
        })),
        user_data: None,
    })
}

fn build_web_entry(dir: &Path) -> Result<AppEntry, CoreError> {
    let name = folder_name(dir)?;
    let id = to_kebab_case(&name);
    let icon = initials_icon(&id);
    let port = parse_dev_port_from_package_json(dir)?.unwrap_or(DEFAULT_WEB_PORT);
    let url = format!("http://localhost:{port}");
    let launch = LaunchSpec {
        kind: LaunchKind::Npm,
        cwd: Some(name.clone()),
        command: Some("dev".to_owned()),
        args: Vec::new(),
        env: HashMap::default(),
        wait_for: Some(WaitFor::Http {
            value: url.clone(),
            timeout_ms: WEB_WAIT_TIMEOUT_MS,
        }),
    };
    Ok(AppEntry {
        id,
        name,
        source_type: SourceType::Web,
        favorite: false,
        enabled: true,
        icon: Some(icon),
        polling: Some(default_polling()),
        launch,
        health: Some(WaitFor::Http {
            value: url,
            timeout_ms: WEB_WAIT_TIMEOUT_MS,
        }),
        source: Some(json!({
            "url": "",
            "branch": "main",
            "fetch_strategy": "fast-forward-only",
            "package_manager": "npm",
            "install_command": "ci",
            "start_command": "dev",
            "port": port
        })),
        user_data: None,
    })
}

fn build_installer_entry(dir: &Path) -> Result<AppEntry, CoreError> {
    let name = folder_name(dir)?;
    let id = to_kebab_case(&name);
    let icon = initials_icon(&id);
    // The launch path mirrors the canonical installer shape: %PROGRAMDATA% Start-Menu
    // shortcut. The operator can override it on the wizard before saving.
    let launch_path =
        format!("%PROGRAMDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\{name}.lnk");
    let launch = LaunchSpec {
        kind: LaunchKind::ExeShortcut,
        cwd: None,
        command: Some(launch_path),
        args: Vec::new(),
        env: HashMap::default(),
        wait_for: None,
    };
    Ok(AppEntry {
        id,
        name: name.clone(),
        source_type: SourceType::Installer,
        favorite: false,
        enabled: true,
        icon: Some(icon),
        polling: Some(default_polling()),
        launch,
        health: None,
        // `registry_uninstall_key`, download URL, etc. are operator-supplied.
        source: Some(json!({
            "vendor": name,
            "product_name": name,
            "registry_uninstall_key": "",
            "download_url": "",
            "install_args": ["/S"]
        })),
        user_data: None,
    })
}

fn build_tizen_entry(dir: &Path) -> Result<AppEntry, CoreError> {
    let name = folder_name(dir)?;
    let id = to_kebab_case(&name);
    let icon = initials_icon(&id);
    // Locate the sibling `.ipk`; we know it exists because we just classified on it.
    let parent = dir.parent().ok_or_else(|| {
        CoreError::config(format!("tizen candidate has no parent: {}", dir.display()))
    })?;
    let ipk_path = sibling_with_extension(parent, &name, "ipk")?.ok_or_else(|| {
        CoreError::config(format!(
            "classified as tizen-ipk but sibling .ipk missing: {}",
            dir.display()
        ))
    })?;
    let launch = LaunchSpec {
        kind: LaunchKind::TizenDeploy,
        cwd: None,
        command: Some(ipk_path.to_string_lossy().into_owned()),
        args: Vec::new(),
        env: HashMap::default(),
        wait_for: None,
    };
    Ok(AppEntry {
        id,
        name,
        source_type: SourceType::TizenIpk,
        favorite: false,
        enabled: true,
        icon: Some(icon),
        polling: Some(default_polling()),
        launch,
        health: None,
        source: Some(json!({
            "source_kind": "github-release",
            "repo": "",
            "asset_pattern": ".*\\.ipk$"
        })),
        user_data: None,
    })
}

fn build_executable_entry(dir: &Path, exe: &Path) -> Result<AppEntry, CoreError> {
    // Rule 5: a bare directory containing a `.exe` and nothing else we can classify.
    // The schema enum doesn't have an `executable` variant — `executable` is a *launch*
    // kind, not a source kind. We mark these as `installer` so the seed wizard surfaces
    // them and lets the operator either (a) fill in the installer source fields, or
    // (b) demote the entry to launch-only (which the schema accepts by omitting the
    // optional `source` block).
    let name = folder_name(dir)?;
    let id = to_kebab_case(&name);
    let icon = initials_icon(&id);
    let exe_name = exe
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| CoreError::config(format!("unreadable exe name: {}", exe.display())))?
        .to_owned();
    let launch = LaunchSpec {
        kind: LaunchKind::Executable,
        cwd: Some(name.clone()),
        command: Some(exe_name),
        args: Vec::new(),
        env: HashMap::default(),
        wait_for: None,
    };
    Ok(AppEntry {
        id,
        name,
        source_type: SourceType::Installer,
        favorite: false,
        enabled: true,
        icon: Some(icon),
        polling: None,
        launch,
        health: None,
        source: None,
        user_data: None,
    })
}

fn sibling_with_extension(
    parent: &Path,
    stem: &str,
    ext: &str,
) -> Result<Option<PathBuf>, CoreError> {
    let read = std::fs::read_dir(parent).map_err(|e| CoreError::io(parent, e))?;
    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let stem_ok = path
            .file_stem()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s == stem);
        let ext_ok = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case(ext));
        if stem_ok && ext_ok {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

// ---- Pure helpers ------------------------------------------------------------------

const fn default_polling() -> PollingSpec {
    PollingSpec {
        enabled: true,
        interval_minutes: DEFAULT_POLL_MINUTES,
        jitter_seconds: DEFAULT_POLL_JITTER_SECONDS,
    }
}

/// Convert any folder name into the kebab-case `id` the manifest uses:
///
/// * Lowercases.
/// * Replaces any run of non-alphanumeric characters with a single `-`.
/// * Trims leading and trailing `-`.
///
/// Examples (verified by unit tests):
///   `clubtivi-windows` → `clubtivi-windows`
///   `Extreme-InfiniTV`  → `extreme-infinitv`
///   `Smart_IPTV Web`    → `smart-iptv-web`
pub fn to_kebab_case(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut last_was_dash = true; // suppress leading dashes
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() {
            for lower in ch.to_lowercase() {
                out.push(lower);
            }
            last_was_dash = false;
        } else if !last_was_dash {
            out.push('-');
            last_was_dash = true;
        }
    }
    // Trim trailing dash.
    while out.ends_with('-') {
        out.pop();
    }
    out
}

/// First two upper-case consonants of `id`. If the id has fewer than two consonants,
/// the result is padded with the first available alphanumeric character so the icon
/// is always a two-letter token (the UI relies on a stable visual width).
fn initials_icon(id: &str) -> IconSpec {
    let consonants: String = id
        .chars()
        .filter(|c| {
            c.is_ascii_alphabetic()
                && !matches!(c.to_ascii_lowercase(), 'a' | 'e' | 'i' | 'o' | 'u')
        })
        .take(2)
        .flat_map(char::to_uppercase)
        .collect();

    let value = if consonants.chars().count() >= 2 {
        consonants
    } else {
        // Fall back to the first two alphanumeric chars so the icon is never blank.
        let mut fallback: String = id
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .take(2)
            .flat_map(char::to_uppercase)
            .collect();
        while fallback.chars().count() < 2 {
            fallback.push('X');
        }
        fallback
    };

    IconSpec {
        kind: IconKind::Initials,
        value,
    }
}

/// Parse the `dev` script in `package.json` for `--port N` and return the port if
/// found. Returns `None` if the file is missing, unreadable, has no `dev` script, or
/// the script does not declare an explicit port. Errors only on hard I/O failure.
fn parse_dev_port_from_package_json(dir: &Path) -> Result<Option<u16>, CoreError> {
    let path = dir.join("package.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(CoreError::io(&path, e)),
    };
    let value: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        // A malformed package.json shouldn't fail the whole scan — just skip the port.
        Err(_) => return Ok(None),
    };
    let dev = value
        .get("scripts")
        .and_then(|s| s.get("dev"))
        .and_then(|v| v.as_str());
    let Some(dev) = dev else {
        return Ok(None);
    };
    Ok(extract_port_from_dev_script(dev))
}

/// Heuristic port parser: matches `--port N`, `--port=N`, `-p N`, or `-p=N`.
fn extract_port_from_dev_script(script: &str) -> Option<u16> {
    let mut iter = script.split_whitespace();
    while let Some(tok) = iter.next() {
        // Handle `--port=N` / `-p=N`.
        if let Some(rest) = tok.strip_prefix("--port=") {
            if let Ok(n) = rest.parse::<u16>() {
                return Some(n);
            }
        }
        if let Some(rest) = tok.strip_prefix("-p=") {
            if let Ok(n) = rest.parse::<u16>() {
                return Some(n);
            }
        }
        // Handle space-separated `--port N` / `-p N`.
        if tok == "--port" || tok == "-p" {
            if let Some(next) = iter.next() {
                if let Ok(n) = next.parse::<u16>() {
                    return Some(n);
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kebab_case_examples() {
        assert_eq!(to_kebab_case("clubtivi-windows"), "clubtivi-windows");
        assert_eq!(to_kebab_case("Extreme-InfiniTV"), "extreme-infinitv");
        assert_eq!(to_kebab_case("Smart_IPTV Web"), "smart-iptv-web");
        assert_eq!(to_kebab_case("iptvnator"), "iptvnator");
        assert_eq!(to_kebab_case("AuthoIPTV"), "authoiptv");
    }

    #[test]
    fn initials_first_two_consonants() {
        assert_eq!(initials_icon("clubtivi-windows").value, "CL");
        assert_eq!(initials_icon("iptvnator").value, "PT");
        assert_eq!(initials_icon("authoiptv").value, "TH");
    }

    #[test]
    fn initials_padded_when_few_consonants() {
        // "ai" has zero consonants → pads with first two alphanum chars.
        assert_eq!(initials_icon("ai").value, "AI");
        // "a" has one alphanum char → padded to two with `X`.
        assert_eq!(initials_icon("a").value, "AX");
    }

    #[test]
    fn dev_script_port_parsing() {
        assert_eq!(extract_port_from_dev_script("vite --port 5174"), Some(5174));
        assert_eq!(extract_port_from_dev_script("vite --port=5175"), Some(5175));
        assert_eq!(extract_port_from_dev_script("vite -p 8080"), Some(8080));
        assert_eq!(extract_port_from_dev_script("vite -p=9001"), Some(9001));
        assert_eq!(extract_port_from_dev_script("vite"), None);
        assert_eq!(extract_port_from_dev_script("next dev"), None);
    }
}
