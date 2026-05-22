//! Real Rust types corresponding to `schema/apps.schema.json`. Round-trip with
//! `serde_json` is asserted by the unit tests at the bottom of this file.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Manifest {
    pub schema_version: u32,
    pub apps_root: String,
    pub user_data_root: String,
    pub cache_root: String,
    pub apps: Vec<AppEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppEntry {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub source_type: SourceType,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub icon: Option<IconSpec>,
    #[serde(default)]
    pub polling: Option<PollingSpec>,
    pub launch: LaunchSpec,
    #[serde(default)]
    pub health: Option<WaitFor>,
    /// Kept as raw JSON; the dispatched `Source` decodes its own typed config from this.
    #[serde(default)]
    pub source: Option<serde_json::Value>,
    #[serde(default)]
    pub user_data: Option<UserDataLink>,
}

const fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum SourceType {
    Git,
    ReleaseBinary,
    Installer,
    Web,
    TizenIpk,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IconSpec {
    pub kind: IconKind,
    pub value: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum IconKind {
    Initials,
    File,
    Url,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PollingSpec {
    #[serde(default = "default_polling_enabled")]
    pub enabled: bool,
    #[serde(default = "default_interval_minutes")]
    pub interval_minutes: u32,
    #[serde(default = "default_jitter_seconds")]
    pub jitter_seconds: u32,
}

const fn default_polling_enabled() -> bool {
    true
}
const fn default_interval_minutes() -> u32 {
    15
}
const fn default_jitter_seconds() -> u32 {
    30
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LaunchSpec {
    pub kind: LaunchKind,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub wait_for: Option<WaitFor>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LaunchKind {
    Executable,
    Npm,
    TauriDev,
    ExeShortcut,
    WebUrl,
    TizenDeploy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WaitFor {
    Port { value: u16, timeout_ms: u32 },
    Process { value: String, timeout_ms: u32 },
    Http { value: String, timeout_ms: u32 },
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UserDataLink {
    pub path: String,
    pub mount_at: String,
    #[serde(default = "default_create_if_missing")]
    pub create_if_missing: bool,
}

const fn default_create_if_missing() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_git_example() {
        let json = include_str!("../../../schema/examples/example-git.json");
        let manifest: Manifest = serde_json::from_str(json).expect("parse");
        assert_eq!(manifest.schema_version, 1);
        assert_eq!(manifest.apps.len(), 1);
        let app = &manifest.apps[0];
        assert_eq!(app.id, "iptvnator");
        assert_eq!(app.source_type, SourceType::Git);
        assert!(app.favorite);
        assert!(app.user_data.is_some());

        let re = serde_json::to_value(&manifest).expect("serialize");
        let orig: serde_json::Value = serde_json::from_str(json).expect("re-parse");
        assert_eq!(re, orig, "round-trip changed the manifest");
    }

    #[test]
    fn round_trip_full_28_app_example() {
        let json = include_str!("../../../schema/examples/full-28-apps.json");
        let manifest: Manifest = serde_json::from_str(json).expect("parse");
        assert_eq!(manifest.apps.len(), 28);
    }

    #[test]
    fn defaults_are_applied() {
        let json = r#"{
            "schema_version": 1,
            "apps_root": "C:\\IPTV",
            "user_data_root": "C:\\IPTV\\user-data",
            "cache_root": "C:\\IPTV\\cache",
            "apps": [{
                "id": "x", "name": "X", "type": "git",
                "launch": { "kind": "executable" },
                "source": { "url": "https://example.com/x.git", "branch": "main" }
            }]
        }"#;
        let m: Manifest = serde_json::from_str(json).expect("parse");
        assert!(m.apps[0].enabled);
        assert!(!m.apps[0].favorite);
    }
}
