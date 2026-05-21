//! Layered configuration: built-in defaults < shipped TOML < user TOML < environment.

use serde::{Deserialize, Serialize};

use crate::errors::CoreError;
use crate::paths::AppPaths;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub poll_concurrency: usize,
    pub default_poll_interval_minutes: u32,
    pub snapshot_retention_days: u32,
    pub activity_log_retention_days: u32,
    pub source_url_allowlist: Vec<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            poll_concurrency: 4,
            default_poll_interval_minutes: 15,
            snapshot_retention_days: 7,
            activity_log_retention_days: 30,
            source_url_allowlist: vec![
                "github.com".into(),
                "gitlab.com".into(),
                "raw.githubusercontent.com".into(),
                "objects.githubusercontent.com".into(),
                "api.github.com".into(),
            ],
        }
    }
}

impl AppConfig {
    pub fn load(paths: &AppPaths) -> Result<Self, CoreError> {
        let user_config = paths.data_dir().join("config.toml");

        let mut builder = config::Config::builder()
            .add_source(config::Config::try_from(&Self::default()).map_err(other)?);

        if user_config.exists() {
            builder = builder.add_source(config::File::from(user_config));
        }
        builder = builder.add_source(
            config::Environment::with_prefix("IPTV_HUB")
                .separator("__")
                .try_parsing(true),
        );

        let cfg: Self = builder.build().map_err(other)?.try_deserialize().map_err(other)?;
        Ok(cfg)
    }
}

fn other(e: impl std::fmt::Display) -> CoreError {
    CoreError::config(e.to_string())
}
