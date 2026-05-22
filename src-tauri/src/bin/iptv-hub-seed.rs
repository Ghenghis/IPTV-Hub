//! `iptv-hub-seed` — CLI wrapper around `iptv_hub_core::seed::scan_directory`.
//!
//! Given a directory, scans it with the heuristic classifier (`.git` / `package.json`
//! / `Program Files` / sibling `.ipk` / fallback executable) and prints the
//! proposed manifest as JSON on stdout. Designed to be called by
//! `scripts/seed-apps.{sh,ps1}` for the operator-side bootstrap workflow
//! documented in `AGENT_PLAN.md` §Agent 19 + §Agent 24.
//!
//! Exit codes:
//!     0  — scan succeeded; manifest printed to stdout as `SeedScanResult` JSON.
//!     1  — arg validation failure (missing / non-existent path).
//!     2  — scanner returned a `CoreError` (read details on stderr).
//!
//! Usage:
//!     iptv-hub-seed <path>
//!     iptv-hub-seed --help
//!
//! The output JSON is the same shape the Tauri command `seed_from_folder`
//! returns, so the CLI and the in-app wizard share their data contract.

use std::path::Path;
use std::process::ExitCode;

use iptv_hub_core::seed;

fn print_usage() {
    eprintln!("usage: iptv-hub-seed <path>");
    eprintln!();
    eprintln!("Scans <path> and prints the proposed manifest to stdout as JSON.");
    eprintln!("The heuristic classifier matches AGENT_PLAN.md §Agent 24:");
    eprintln!("  .git/ subdir         -> git source");
    eprintln!("  package.json, no .git -> web source");
    eprintln!("  Program Files / .lnk -> installer candidate");
    eprintln!("  sibling .ipk         -> tizen-ipk source");
    eprintln!("  otherwise            -> executable launch only");
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args.iter().any(|a| a == "-h" || a == "--help") {
        print_usage();
        return if args.is_empty() {
            ExitCode::from(1)
        } else {
            ExitCode::SUCCESS
        };
    }
    if args.len() > 1 {
        eprintln!("iptv-hub-seed: too many arguments (expected exactly one path)");
        print_usage();
        return ExitCode::from(1);
    }

    let path_arg = &args[0];
    let path = Path::new(path_arg);
    if !path.exists() {
        eprintln!("iptv-hub-seed: path does not exist: {path_arg}");
        return ExitCode::from(1);
    }
    if !path.is_dir() {
        eprintln!("iptv-hub-seed: path is not a directory: {path_arg}");
        return ExitCode::from(1);
    }

    let runtime = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(err) => {
            eprintln!("iptv-hub-seed: failed to start tokio runtime: {err}");
            return ExitCode::from(2);
        }
    };

    let scan_result = runtime.block_on(seed::scan_directory(path));
    let result = match scan_result {
        Ok(r) => r,
        Err(err) => {
            eprintln!("iptv-hub-seed: scan failed: {err}");
            return ExitCode::from(2);
        }
    };

    // Emit the result as pretty JSON on stdout for human / script consumption.
    match serde_json::to_string_pretty(&result) {
        Ok(json) => {
            println!("{json}");
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("iptv-hub-seed: serialise failed: {err}");
            ExitCode::from(2)
        }
    }
}
