//! Per-app repository manager for the orchestrator (P2).
//!
//! Clone-once-then-fetch semantics: a repo lives at `repos/<app>/` under the
//! VPS root for the lifetime of the orchestrator. First call to
//! [`fetch_or_clone`] clones the upstream; subsequent calls fast-forward the
//! working tree to `origin/<branch>` via `fetch` + hard reset. We never
//! re-clone (that would defeat the 27–30 GB raw catalogue storage policy
//! merged in PR #28).
//!
//! P2 deliberately stops short of:
//!
//! - reading the source URL from `apps.json` (manifest integration lands with
//!   the worker queue, P3+);
//! - authentication for private remotes (no credentials handler — adding one
//!   would couple this module to the OS keychain and the Provider Vault);
//! - merge / rebase / post-update hooks (the desktop `GitSource` covers those
//!   for the user-facing launcher; the orchestrator only needs a HEAD sha to
//!   feed the build worker).
//!
//! Callers pass an explicit [`RepoSource`] each call. Future phases will
//! resolve it from the manifest before invoking us.

use std::path::{Path, PathBuf};

use git2::{
    build::{CheckoutBuilder, RepoBuilder},
    AutotagOption, FetchOptions, Repository, ResetType,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::paths::{validate_app_id, AppIdError, Paths};

/// Where to clone or fetch from.
///
/// Borrowed `&str` rather than owned `String` so the caller does not need to
/// allocate when the URL came from a `&AppEntry` (future) or a CLI argument
/// (today). The lifetime is bound by the call site.
#[derive(Debug, Clone, Copy)]
pub struct RepoSource<'a> {
    pub url: &'a str,
    pub branch: &'a str,
}

/// Result of a successful [`fetch_or_clone`] call.
///
/// `head_sha` is the resolved commit on `origin/<branch>` after the call;
/// `was_cloned` distinguishes the initial-clone path from the
/// existing-repo-fetch path so callers / tests can assert which branch ran.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RepoOutcome {
    pub app: String,
    pub path: PathBuf,
    pub branch: String,
    pub head_sha: String,
    pub was_cloned: bool,
}

#[derive(Debug, Error)]
pub enum RepoError {
    #[error(transparent)]
    AppId(#[from] AppIdError),

    #[error("io error on `{path}`: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("git operation failed for app `{app}` at `{path}`: {source}")]
    Git {
        app: String,
        path: PathBuf,
        #[source]
        source: git2::Error,
    },

    #[error(
        "path `{path}` exists but is not a git repository — refusing to overwrite operator data"
    )]
    NotAGitRepo { path: PathBuf },

    #[error("repo path `{path}` does not exist — no prior clone for this app")]
    RepoMissing { path: PathBuf },

    #[error("remote branch `origin/{branch}` not found after fetch for app `{app}`")]
    BranchMissing { app: String, branch: String },

    #[error("repo HEAD at `{path}` is detached or unborn — cannot resolve a sha")]
    HeadUnresolvable { path: PathBuf },
}

/// Ensure `repos/<app>/` exists as a git working tree and fast-forward it to
/// `origin/<branch>`.
///
/// On the first call for a given `app`, clones `source.url` into
/// `repos/<app>/` and checks out `source.branch`. On every subsequent call,
/// opens the existing working tree, fetches `source.branch` from `origin`,
/// and hard-resets the working tree to `origin/<branch>`.
///
/// The hard reset is intentional and matches the orchestrator design:
/// `repos/<app>/` is owned by the orchestrator, never edited by the operator
/// (operator data lives under `data/<app>/`). Any local modifications under
/// `repos/<app>/` are lost on the next update — that's the documented
/// contract.
pub fn fetch_or_clone(
    paths: &Paths,
    app: &str,
    source: &RepoSource<'_>,
) -> Result<RepoOutcome, RepoError> {
    validate_app_id(app)?;
    let repo_path = paths.repo(app)?;

    ensure_repos_dir(paths)?;

    let was_cloned;
    let repo;
    if repo_path.exists() {
        repo = open_or_reject(&repo_path, app)?;
        fetch_branch(&repo, app, &repo_path, source)?;
        was_cloned = false;
    } else {
        repo = clone_fresh(&repo_path, app, source)?;
        was_cloned = true;
    }

    let head_sha = reset_to_origin_branch(&repo, app, &repo_path, source.branch)?;
    Ok(RepoOutcome {
        app: app.to_owned(),
        path: repo_path,
        branch: source.branch.to_owned(),
        head_sha,
        was_cloned,
    })
}

/// Read the current HEAD sha of `repos/<app>/` without touching the network.
///
/// Useful for the activity-log "no-op update" path: the worker can compare
/// `current_sha` (cheap, local) against `origin/<branch>` (after fetch) to
/// decide whether anything actually changed before kicking off a build.
pub fn current_sha(paths: &Paths, app: &str) -> Result<String, RepoError> {
    validate_app_id(app)?;
    let repo_path = paths.repo(app)?;
    let repo = open_or_reject(&repo_path, app)?;
    head_sha_of(&repo, &repo_path, app)
}

fn ensure_repos_dir(paths: &Paths) -> Result<(), RepoError> {
    let repos = paths.repos();
    std::fs::create_dir_all(&repos).map_err(|source| RepoError::Io {
        path: repos,
        source,
    })
}

fn clone_fresh(
    repo_path: &Path,
    app: &str,
    source: &RepoSource<'_>,
) -> Result<Repository, RepoError> {
    let mut builder = RepoBuilder::new();
    builder.branch(source.branch);
    // No remote callbacks / credentials yet — P2 is public-URL only. Anything
    // private will land in a later phase alongside the Provider Vault wiring.
    builder
        .clone(source.url, repo_path)
        .map_err(|source| RepoError::Git {
            app: app.to_owned(),
            path: repo_path.to_path_buf(),
            source,
        })
}

fn open_or_reject(repo_path: &Path, app: &str) -> Result<Repository, RepoError> {
    // Distinguish "no clone yet" from "directory exists but is not a git
    // repo" so callers (and operators reading errors) can act on the right
    // recovery path. Per Gemini code review on PR #30: NotAGitRepo must
    // ONLY fire when the directory exists but lacks `.git/`; a missing
    // `repos/<app>/` is its own error so a caller knows to fall back to a
    // first-time clone rather than reporting operator-data conflict.
    if !repo_path.exists() {
        return Err(RepoError::RepoMissing {
            path: repo_path.to_path_buf(),
        });
    }
    if !repo_path.join(".git").exists() {
        return Err(RepoError::NotAGitRepo {
            path: repo_path.to_path_buf(),
        });
    }
    Repository::open(repo_path).map_err(|source| RepoError::Git {
        app: app.to_owned(),
        path: repo_path.to_path_buf(),
        source,
    })
}

fn fetch_branch(
    repo: &Repository,
    app: &str,
    repo_path: &Path,
    source: &RepoSource<'_>,
) -> Result<(), RepoError> {
    // Re-point `origin` if the caller passed a different URL than the one
    // recorded in the existing clone. Per Gemini code review on PR #30:
    // silently fetching the old origin when the manifest source URL has
    // moved would leave operators stranded on a stale upstream. We update
    // the URL first, then re-open the remote so the fetch below uses the
    // new endpoint.
    let needs_url_update = {
        let existing = repo
            .find_remote("origin")
            .map_err(|err| git_err(app, repo_path, err))?;
        existing.url().is_none_or(|current| current != source.url)
    };
    if needs_url_update {
        repo.remote_set_url("origin", source.url)
            .map_err(|err| git_err(app, repo_path, err))?;
    }

    let mut remote = repo
        .find_remote("origin")
        .map_err(|err| git_err(app, repo_path, err))?;

    let mut fetch_opts = FetchOptions::new();
    fetch_opts.download_tags(AutotagOption::None);
    // Refspec mirrors the design doc's "fetch + hard reset to
    // origin/<branch>" rule — the `+` makes the local-tracking ref a
    // forced update so a remote rewrite still lands cleanly.
    let refspec = format!(
        "+refs/heads/{branch}:refs/remotes/origin/{branch}",
        branch = source.branch
    );
    remote
        .fetch(&[refspec.as_str()], Some(&mut fetch_opts), None)
        .map_err(|err| git_err(app, repo_path, err))?;
    Ok(())
}

/// Short-hand for the `RepoError::Git { app, path, source }` constructor that
/// every git2 call site needs. Keeps `fetch_branch` (with two extra git2 calls
/// for URL re-pointing) readable.
fn git_err(app: &str, repo_path: &Path, source: git2::Error) -> RepoError {
    RepoError::Git {
        app: app.to_owned(),
        path: repo_path.to_path_buf(),
        source,
    }
}

fn reset_to_origin_branch(
    repo: &Repository,
    app: &str,
    repo_path: &Path,
    branch: &str,
) -> Result<String, RepoError> {
    let refname = format!("refs/remotes/origin/{branch}");
    let oid = repo.refname_to_id(&refname).map_err(|source| {
        // If refname_to_id failed because the ref simply doesn't exist, the
        // operator probably misconfigured `branch`. Surface that as a
        // structured error rather than a raw git message.
        if source.code() == git2::ErrorCode::NotFound {
            RepoError::BranchMissing {
                app: app.to_owned(),
                branch: branch.to_owned(),
            }
        } else {
            RepoError::Git {
                app: app.to_owned(),
                path: repo_path.to_path_buf(),
                source,
            }
        }
    })?;

    let object = repo
        .find_object(oid, None)
        .map_err(|source| RepoError::Git {
            app: app.to_owned(),
            path: repo_path.to_path_buf(),
            source,
        })?;

    let mut checkout = CheckoutBuilder::new();
    checkout.force();
    repo.reset(&object, ResetType::Hard, Some(&mut checkout))
        .map_err(|source| RepoError::Git {
            app: app.to_owned(),
            path: repo_path.to_path_buf(),
            source,
        })?;

    head_sha_of(repo, repo_path, app)
}

fn head_sha_of(repo: &Repository, repo_path: &Path, app: &str) -> Result<String, RepoError> {
    let head = repo.head().map_err(|source| RepoError::Git {
        app: app.to_owned(),
        path: repo_path.to_path_buf(),
        source,
    })?;
    let oid = head.target().ok_or_else(|| RepoError::HeadUnresolvable {
        path: repo_path.to_path_buf(),
    })?;
    Ok(oid.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{IndexAddOption, Signature, Time};
    use std::path::Path;
    use tempfile::tempdir;

    /// Build a bare repo at `bare_path` and push one commit on `branch`.
    /// Returns the sha of that commit.
    fn build_bare_remote_with_one_commit(bare_path: &Path, branch: &str) -> String {
        // Bare repo on disk to serve as `origin`.
        Repository::init_bare(bare_path).expect("init bare");

        // Working tree elsewhere — we commit here, then push to the bare.
        let work_dir = tempdir().expect("tempdir for work tree");
        let work = Repository::init(work_dir.path()).expect("init work");

        // README -> stage -> commit.
        std::fs::write(work_dir.path().join("README.md"), b"hello\n").unwrap();
        let mut index = work.index().unwrap();
        index
            .add_all(std::iter::once("*"), IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = work.find_tree(tree_id).unwrap();

        let sig = Signature::new("test", "test@example.invalid", &Time::new(0, 0)).unwrap();
        let commit_oid = work
            .commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[])
            .expect("initial commit");

        // Rename current branch to the requested one.
        let head_ref = work.head().unwrap();
        let current_branch = head_ref.shorthand().unwrap_or("").to_owned();
        if current_branch != branch {
            let commit = work.find_commit(commit_oid).unwrap();
            work.branch(branch, &commit, false).unwrap();
            work.set_head(&format!("refs/heads/{branch}")).unwrap();
        }

        // Push to bare via local path.
        let url = local_url(bare_path);
        let mut remote = work.remote("origin", &url).unwrap();
        let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
        remote
            .push(&[refspec.as_str()], None)
            .expect("push initial");

        commit_oid.to_string()
    }

    /// Append a new commit to an existing bare remote on `branch`. Returns
    /// the new sha.
    fn append_commit_to_bare(bare_path: &Path, branch: &str, message: &str) -> String {
        let work_dir = tempdir().unwrap();
        let url = local_url(bare_path);
        let mut builder = RepoBuilder::new();
        builder.branch(branch);
        let work = builder
            .clone(&url, work_dir.path())
            .expect("clone for append");

        let filename = format!("note-{}.txt", message.replace(' ', "_"));
        std::fs::write(work_dir.path().join(&filename), message.as_bytes()).unwrap();

        let mut index = work.index().unwrap();
        index.add_path(Path::new(&filename)).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = work.find_tree(tree_id).unwrap();

        let parent_oid = work.head().unwrap().target().unwrap();
        let parent = work.find_commit(parent_oid).unwrap();

        let sig = Signature::new("test", "test@example.invalid", &Time::new(60, 0)).unwrap();
        let commit_oid = work
            .commit(Some("HEAD"), &sig, &sig, message, &tree, &[&parent])
            .expect("append commit");

        let mut origin = work.find_remote("origin").unwrap();
        let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
        origin.push(&[refspec.as_str()], None).expect("push append");

        commit_oid.to_string()
    }

    /// Convert a local filesystem path into a URL git2 accepts uniformly on
    /// Windows and Unix. The bare path works on Unix but Windows libgit2
    /// needs the `file://` scheme.
    fn local_url(path: &Path) -> String {
        let normalised = path.to_string_lossy().replace('\\', "/");
        format!("file:///{}", normalised.trim_start_matches('/'))
    }

    #[test]
    fn fetch_or_clone_creates_initial_clone_and_returns_head_sha() {
        let dir = tempdir().unwrap();
        let bare = dir.path().join("upstream.git");
        let initial_sha = build_bare_remote_with_one_commit(&bare, "main");

        let paths = Paths::new(dir.path().join("orch"));
        paths.ensure_tree().unwrap();

        let url = local_url(&bare);
        let source = RepoSource {
            url: &url,
            branch: "main",
        };
        let outcome = fetch_or_clone(&paths, "wizju-iptv-player", &source).unwrap();

        assert!(outcome.was_cloned, "first call must take the clone path");
        assert_eq!(outcome.app, "wizju-iptv-player");
        assert_eq!(outcome.branch, "main");
        assert_eq!(outcome.head_sha, initial_sha);
        assert_eq!(outcome.path, paths.repo("wizju-iptv-player").unwrap());
        assert!(outcome.path.join(".git").is_dir());
        assert!(outcome.path.join("README.md").is_file());
    }

    #[test]
    fn fetch_or_clone_returns_new_sha_after_remote_advances() {
        let dir = tempdir().unwrap();
        let bare = dir.path().join("upstream.git");
        let initial_sha = build_bare_remote_with_one_commit(&bare, "main");

        let paths = Paths::new(dir.path().join("orch"));
        paths.ensure_tree().unwrap();

        let url = local_url(&bare);
        let source = RepoSource {
            url: &url,
            branch: "main",
        };

        // First call — clone.
        let first = fetch_or_clone(&paths, "wizju-iptv-player", &source).unwrap();
        assert!(first.was_cloned);
        assert_eq!(first.head_sha, initial_sha);

        // Advance the remote, then run again.
        let new_sha = append_commit_to_bare(&bare, "main", "second commit");
        let second = fetch_or_clone(&paths, "wizju-iptv-player", &source).unwrap();
        assert!(!second.was_cloned, "second call must take the fetch path");
        assert_eq!(second.head_sha, new_sha);
        assert_ne!(second.head_sha, initial_sha);
        // Working tree was actually updated, not just the ref.
        assert!(second.path.join("note-second_commit.txt").is_file());
    }

    #[test]
    fn fetch_or_clone_is_noop_when_remote_unchanged() {
        let dir = tempdir().unwrap();
        let bare = dir.path().join("upstream.git");
        let initial_sha = build_bare_remote_with_one_commit(&bare, "main");

        let paths = Paths::new(dir.path().join("orch"));
        paths.ensure_tree().unwrap();
        let url = local_url(&bare);
        let source = RepoSource {
            url: &url,
            branch: "main",
        };

        let first = fetch_or_clone(&paths, "wizju-iptv-player", &source).unwrap();
        let second = fetch_or_clone(&paths, "wizju-iptv-player", &source).unwrap();

        assert_eq!(first.head_sha, initial_sha);
        assert_eq!(second.head_sha, initial_sha);
        assert!(first.was_cloned);
        assert!(!second.was_cloned);
    }

    #[test]
    fn fetch_or_clone_honors_changed_source_url() {
        // Regression for Gemini code review on PR #30 (HIGH): if the operator
        // ever changes a manifest's source URL, subsequent calls must follow
        // the *new* upstream rather than silently fetching the old origin.
        let dir = tempdir().unwrap();
        let bare_a = dir.path().join("upstream-a.git");
        let bare_b = dir.path().join("upstream-b.git");
        let sha_a = build_bare_remote_with_one_commit(&bare_a, "main");
        // Both helpers use a fixed signature and identical initial content,
        // so two fresh bares would produce the same root commit sha. Advance
        // B by one commit so its tip is provably different from A's.
        build_bare_remote_with_one_commit(&bare_b, "main");
        let sha_b = append_commit_to_bare(&bare_b, "main", "remote B advances");
        assert_ne!(sha_a, sha_b, "test bares must produce distinct shas");

        let paths = Paths::new(dir.path().join("orch"));
        paths.ensure_tree().unwrap();
        let url_a = local_url(&bare_a);
        let url_b = local_url(&bare_b);

        // First call points at remote A.
        let first = fetch_or_clone(
            &paths,
            "wizju-iptv-player",
            &RepoSource {
                url: &url_a,
                branch: "main",
            },
        )
        .unwrap();
        assert!(first.was_cloned);
        assert_eq!(first.head_sha, sha_a);

        // Second call passes a different URL — orchestrator must update
        // `origin` and pull from remote B, not silently keep fetching A.
        let second = fetch_or_clone(
            &paths,
            "wizju-iptv-player",
            &RepoSource {
                url: &url_b,
                branch: "main",
            },
        )
        .unwrap();
        assert!(
            !second.was_cloned,
            "second call still re-uses the on-disk clone"
        );
        assert_eq!(
            second.head_sha, sha_b,
            "head must follow the new source URL, not the original"
        );

        // The stored origin URL must reflect remote B now.
        let on_disk = git2::Repository::open(&second.path).unwrap();
        let origin = on_disk.find_remote("origin").unwrap();
        assert_eq!(origin.url(), Some(url_b.as_str()));
    }

    #[test]
    fn current_sha_returns_head_without_network() {
        let dir = tempdir().unwrap();
        let bare = dir.path().join("upstream.git");
        let initial_sha = build_bare_remote_with_one_commit(&bare, "main");

        let paths = Paths::new(dir.path().join("orch"));
        paths.ensure_tree().unwrap();
        let url = local_url(&bare);
        let source = RepoSource {
            url: &url,
            branch: "main",
        };

        fetch_or_clone(&paths, "wizju-iptv-player", &source).unwrap();

        // Move the remote forward so the network would disagree — current_sha
        // must still report the local HEAD, proving it does not fetch.
        append_commit_to_bare(&bare, "main", "ignored by current_sha");

        let local = current_sha(&paths, "wizju-iptv-player").unwrap();
        assert_eq!(local, initial_sha);
    }

    #[test]
    fn current_sha_missing_repo_returns_repo_missing() {
        // Regression for Gemini code review on PR #30 (MEDIUM): when the
        // operator asks for the sha of an app that has never been cloned,
        // we must surface a clear "no prior clone" signal rather than the
        // confusing "exists but not a git repo" NotAGitRepo. The latter is
        // reserved for the case where `repos/<app>/` exists with operator
        // data in it — see `existing_non_git_dir_refused` for that path.
        let dir = tempdir().unwrap();
        let paths = Paths::new(dir.path().join("orch"));
        paths.ensure_tree().unwrap();

        let err = current_sha(&paths, "wizju-iptv-player").unwrap_err();
        match err {
            RepoError::RepoMissing { path } => {
                assert_eq!(path, paths.repo("wizju-iptv-player").unwrap());
                assert!(!path.exists(), "missing path must really be absent");
            }
            other => panic!("expected RepoError::RepoMissing, got {other:?}"),
        }
    }

    #[test]
    fn invalid_app_id_rejected_by_fetch_or_clone() {
        let dir = tempdir().unwrap();
        let paths = Paths::new(dir.path().join("orch"));
        paths.ensure_tree().unwrap();

        let source = RepoSource {
            url: "file:///does-not-matter",
            branch: "main",
        };
        let err = fetch_or_clone(&paths, "Bad/Id", &source).unwrap_err();
        assert!(matches!(err, RepoError::AppId(_)), "got {err:?}");
    }

    #[test]
    fn invalid_app_id_rejected_by_current_sha() {
        let dir = tempdir().unwrap();
        let paths = Paths::new(dir.path().join("orch"));
        paths.ensure_tree().unwrap();

        let err = current_sha(&paths, "..").unwrap_err();
        assert!(matches!(err, RepoError::AppId(_)), "got {err:?}");
    }

    #[test]
    fn missing_branch_surfaces_as_branch_missing_error() {
        let dir = tempdir().unwrap();
        let bare = dir.path().join("upstream.git");
        build_bare_remote_with_one_commit(&bare, "main");

        let paths = Paths::new(dir.path().join("orch"));
        paths.ensure_tree().unwrap();
        let url = local_url(&bare);

        // Ask for a branch the remote doesn't have. The initial clone will
        // fail at the libgit2 layer because the branch is not present on the
        // remote — we surface that as a Git error (RepoBuilder cannot
        // pre-validate without making an extra round trip).
        let source = RepoSource {
            url: &url,
            branch: "nope",
        };
        let err = fetch_or_clone(&paths, "wizju-iptv-player", &source).unwrap_err();
        match err {
            RepoError::Git { app, .. } => assert_eq!(app, "wizju-iptv-player"),
            RepoError::BranchMissing { app, branch } => {
                assert_eq!(app, "wizju-iptv-player");
                assert_eq!(branch, "nope");
            }
            other => panic!("expected Git or BranchMissing, got {other:?}"),
        }
    }

    #[test]
    fn existing_non_git_dir_refused() {
        let dir = tempdir().unwrap();
        let paths = Paths::new(dir.path().join("orch"));
        paths.ensure_tree().unwrap();

        // Operator-created non-git dir under repos/<app>/ — we must NOT try
        // to overwrite it; we must surface a structured error instead.
        let app = "wizju-iptv-player";
        let target = paths.repo(app).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("operator-data.txt"), b"do not delete").unwrap();

        let source = RepoSource {
            url: "file:///nope",
            branch: "main",
        };
        let err = fetch_or_clone(&paths, app, &source).unwrap_err();
        match err {
            RepoError::NotAGitRepo { path } => assert_eq!(path, target),
            other => panic!("expected NotAGitRepo, got {other:?}"),
        }
        // Operator data is intact.
        assert!(target.join("operator-data.txt").is_file());
    }

    #[test]
    fn fetch_or_clone_writes_only_under_orchestrator_root() {
        // Path-traversal regression: an app id like ".." must be rejected so
        // it never escapes `<root>/repos/`. P1's validate_app_id already
        // forbids `.` and `..`, but we re-assert here at the repo layer so a
        // future relaxation of validate_app_id is caught immediately.
        let dir = tempdir().unwrap();
        let paths = Paths::new(dir.path().join("orch"));
        paths.ensure_tree().unwrap();

        for traversal in ["..", ".", "../etc", "a/b", "a\\b"] {
            let err = fetch_or_clone(
                &paths,
                traversal,
                &RepoSource {
                    url: "file:///nope",
                    branch: "main",
                },
            )
            .unwrap_err();
            assert!(
                matches!(err, RepoError::AppId(_)),
                "expected AppId rejection for `{traversal}`, got {err:?}"
            );
        }

        // And the repos/ root contains no entries other than what
        // ensure_tree() created (which is just the directory itself).
        let entries: Vec<_> = std::fs::read_dir(paths.repos())
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        assert!(
            entries.is_empty(),
            "no app id rejection should have created an entry under repos/: {entries:?}"
        );
    }

    #[test]
    fn repo_outcome_round_trips_through_json() {
        let dir = tempdir().unwrap();
        let bare = dir.path().join("upstream.git");
        build_bare_remote_with_one_commit(&bare, "main");

        let paths = Paths::new(dir.path().join("orch"));
        paths.ensure_tree().unwrap();

        let url = local_url(&bare);
        let outcome = fetch_or_clone(
            &paths,
            "wizju-iptv-player",
            &RepoSource {
                url: &url,
                branch: "main",
            },
        )
        .unwrap();

        let json = serde_json::to_string(&outcome).unwrap();
        let parsed: RepoOutcome = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, outcome);
    }
}
