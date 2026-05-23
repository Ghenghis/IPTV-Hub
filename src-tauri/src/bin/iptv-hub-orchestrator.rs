//! `iptv-hub-orchestrator` — P1 CLI for the VPS orchestrator's storage layer.
//!
//! Phase 1 of `docs/VPS_IMPLEMENTATION_PLAN.md` ships exactly one subcommand:
//!
//! ```text
//! iptv-hub-orchestrator probe --root <PATH> [--app <ID>]...
//! ```
//!
//! It creates the directory tree under `<PATH>`, exercises the per-app
//! advisory lock subsystem for every `--app <ID>` passed, runs the §6 disk
//! preflight, and prints a JSON [`iptv_hub_core::orchestrator::ProbeReport`]
//! to stdout. Future phases will add `serve`, `update`, `rollback`, etc.
//! subcommands to the same binary; argv parsing is intentionally hand-rolled
//! here so the surface stays under one screen until clap pulls its weight.
//!
//! Exit codes:
//!     0 — probe ran end-to-end and disk preflight passed
//!     1 — argv validation failure (missing --root, unknown subcommand, etc.)
//!     2 — probe failed (path / lock / IO / disk-query error)
//!     3 — probe ran but disk preflight reported disk-low

use std::path::PathBuf;
use std::process::ExitCode;

use iptv_hub_core::orchestrator;

fn print_usage() {
    eprintln!("usage: iptv-hub-orchestrator <command> [args]");
    eprintln!();
    eprintln!("Commands:");
    eprintln!("  probe --root <PATH> [--app <ID>]...");
    eprintln!(
        "      Create the directory tree at <PATH>, exercise the per-app lock for each --app,"
    );
    eprintln!("      run the disk preflight, and print a JSON report on stdout.");
    eprintln!();
    eprintln!("Exit codes:");
    eprintln!("  0  ok");
    eprintln!("  1  arg validation failed");
    eprintln!("  2  probe failed (path / lock / IO / disk query)");
    eprintln!("  3  disk-low (preflight passed=false)");
}

#[derive(Debug)]
struct ProbeArgs {
    root: PathBuf,
    apps: Vec<String>,
}

fn parse_probe_args(rest: &[String]) -> Result<ProbeArgs, String> {
    let mut root: Option<PathBuf> = None;
    let mut apps: Vec<String> = Vec::new();
    let mut i = 0;
    while i < rest.len() {
        match rest[i].as_str() {
            "--root" => {
                let value = rest
                    .get(i + 1)
                    .ok_or_else(|| "--root requires a value".to_string())?;
                root = Some(PathBuf::from(value));
                i += 2;
            }
            "--app" => {
                let value = rest
                    .get(i + 1)
                    .ok_or_else(|| "--app requires a value".to_string())?;
                apps.push(value.clone());
                i += 2;
            }
            "-h" | "--help" => {
                print_usage();
                std::process::exit(0);
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    let root = root.ok_or_else(|| "--root is required".to_string())?;
    Ok(ProbeArgs { root, apps })
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.is_empty() || argv[0] == "-h" || argv[0] == "--help" {
        print_usage();
        return if argv.is_empty() {
            ExitCode::from(1)
        } else {
            ExitCode::SUCCESS
        };
    }

    let cmd = &argv[0];
    let rest = &argv[1..];

    match cmd.as_str() {
        "probe" => match parse_probe_args(rest) {
            Ok(parsed) => run_probe(parsed),
            Err(msg) => {
                eprintln!("iptv-hub-orchestrator: {msg}");
                print_usage();
                ExitCode::from(1)
            }
        },
        other => {
            eprintln!("iptv-hub-orchestrator: unknown command: {other}");
            print_usage();
            ExitCode::from(1)
        }
    }
}

fn run_probe(args: ProbeArgs) -> ExitCode {
    match orchestrator::probe(args.root, &args.apps) {
        Ok(report) => {
            match serde_json::to_string_pretty(&report) {
                Ok(json) => println!("{json}"),
                Err(err) => {
                    eprintln!("iptv-hub-orchestrator: failed to serialise report: {err}");
                    return ExitCode::from(2);
                }
            }
            if report.disk.passed {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(3)
            }
        }
        Err(err) => {
            eprintln!("iptv-hub-orchestrator: probe failed: {err}");
            ExitCode::from(2)
        }
    }
}
