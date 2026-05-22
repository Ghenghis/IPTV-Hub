//! Unified error type for the core. Sources convert their domain errors into [`CoreError`];
//! the orchestration layer maps these to user-facing strings for the activity log.

use std::path::Path;

use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CoreError {
    #[error("config: {message}")]
    Config { message: String },

    #[error("io at {path}: {message}")]
    Io { path: String, message: String },

    #[error("git: {message}")]
    Git { message: String },

    #[error("not fast-forward: {message}")]
    NotFastForward { message: String },

    #[error("network: {message}")]
    Network { message: String },

    #[error("sha mismatch (expected {expected}, got {got})")]
    ShaMismatch { expected: String, got: String },

    #[error("not supported: {message}")]
    NotSupported { message: String },

    #[error("post-update command failed: {message}")]
    PostUpdateFailed { message: String },

    #[error("smoke test failed: {message}")]
    SmokeFailed { message: String },

    #[error("internal: {message}")]
    Internal { message: String },
}

impl CoreError {
    pub fn config(message: impl Into<String>) -> Self {
        Self::Config {
            message: message.into(),
        }
    }

    // `source` is taken by value because callers always have an owned `io::Error` they
    // are not going to reuse. Passing by reference would force them all to write `&e`.
    #[allow(clippy::needless_pass_by_value)]
    pub fn io(path: impl AsRef<Path>, source: std::io::Error) -> Self {
        Self::Io {
            path: path.as_ref().to_string_lossy().into_owned(),
            message: source.to_string(),
        }
    }

    pub fn git(message: impl Into<String>) -> Self {
        Self::Git {
            message: message.into(),
        }
    }

    pub fn not_fast_forward(message: impl Into<String>) -> Self {
        Self::NotFastForward {
            message: message.into(),
        }
    }

    pub fn network(message: impl Into<String>) -> Self {
        Self::Network {
            message: message.into(),
        }
    }

    pub fn sha_mismatch(expected: impl Into<String>, got: impl Into<String>) -> Self {
        Self::ShaMismatch {
            expected: expected.into(),
            got: got.into(),
        }
    }

    pub fn not_supported(message: impl Into<String>) -> Self {
        Self::NotSupported {
            message: message.into(),
        }
    }

    pub fn post_update_failed(message: impl Into<String>) -> Self {
        Self::PostUpdateFailed {
            message: message.into(),
        }
    }

    pub fn smoke_failed(message: impl Into<String>) -> Self {
        Self::SmokeFailed {
            message: message.into(),
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::Internal {
            message: message.into(),
        }
    }
}

impl From<git2::Error> for CoreError {
    fn from(e: git2::Error) -> Self {
        Self::Git {
            message: e.message().to_string(),
        }
    }
}

impl From<sqlx::Error> for CoreError {
    fn from(e: sqlx::Error) -> Self {
        Self::Internal {
            message: format!("sqlx: {e}"),
        }
    }
}

impl From<reqwest::Error> for CoreError {
    fn from(e: reqwest::Error) -> Self {
        Self::Network {
            message: e.to_string(),
        }
    }
}

impl From<std::io::Error> for CoreError {
    fn from(e: std::io::Error) -> Self {
        Self::Io {
            path: "<unknown>".into(),
            message: e.to_string(),
        }
    }
}
