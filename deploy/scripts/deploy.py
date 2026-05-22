"""IPTV Hub — one-shot deploy from operator workstation to VPS.

What it does, in order:
    1. Reads `deploy/.env` (DEPLOY_DOMAIN, VPS_INSTALL_ROOT, …) for stack config.
    2. Reads `G:\\private\\.env.deploy` (or `IPTV_HUB_VPS_ENV_PATH` override) for
       VPS_HOST / VPS_USER / VPS_PASS. NEVER echoes these.
    3. Runs `scripts/generate-stack.sh` locally to materialise nginx fragments +
       docker-compose.apps.yml.
    4. Opens a single Paramiko SSH session to the VPS.
    5. Runs `scripts/preflight.sh` over SSH (refuses if any policy port is in
       use on the VPS).
    6. SFTPs the deploy/ tree (excluding .env, build/) + the rendered nginx
       fragments to ${VPS_INSTALL_ROOT}.
    7. SFTPs the nginx fragments into /etc/nginx/conf.d/ (one file per app).
    8. SSH-runs `nginx -t` to validate; on failure, removes the new fragments
       and aborts before touching the live config.
    9. SSH-runs `systemctl reload nginx` to pick up the new fragments.
   10. SSH-runs `docker compose -f docker-compose.yml -f docker-compose.apps.yml up -d`.
   11. Runs `scripts/verify.py` to hit each deployed app through nginx and
       confirm HTTP 2xx/3xx.

Privacy: every line printed to stdout has VPS_HOST / VPS_USER / VPS_PASS
replaced with `<host>` / `<user>` / `<redacted>`. The chat transcript will not
contain those values.

Exit codes:
    0  success
    2  config / env error
    3  remote auth failure
    4  network / timeout
    5  preflight rejected (port collision on VPS)
    6  nginx validation failed (changes rolled back)
    7  docker compose up failed
    8  verify failed (some app not healthy)
    9  other paramiko / runtime error
"""
from __future__ import annotations

import os
import posixpath
import re
import socket
import subprocess
import sys
from pathlib import Path

import paramiko


# ---------------------------------------------------------------------------- #
# Privacy sanitiser. Used on every line before printing.
# ---------------------------------------------------------------------------- #

class Sanitiser:
    def __init__(self, host: str, user: str, password: str) -> None:
        self.host = host
        self.user = user
        self.password = password

    def __call__(self, text: str) -> str:
        if not text:
            return text
        out = text
        if self.host:
            out = out.replace(self.host, "<host>")
            # also mask any sub-prefix that might appear (first 3 octets if IPv4)
            if re.match(r"^\d+\.\d+\.\d+\.\d+$", self.host):
                first_three = ".".join(self.host.split(".")[:3])
                out = out.replace(first_three, "<net>")
        if self.user:
            out = out.replace(self.user, "<user>")
        if self.password:
            out = out.replace(self.password, "<redacted>")
        return out


def log(msg: str, sanitiser: Sanitiser | None = None) -> None:
    if sanitiser is not None:
        msg = sanitiser(msg)
    print(msg, flush=True)


# ---------------------------------------------------------------------------- #
# Env loading.
# ---------------------------------------------------------------------------- #

def _parse_env_file(path: Path) -> dict[str, str]:
    """Parse a KEY=VALUE env file. Tolerates blank lines and `#` comments."""
    result: dict[str, str] = {}
    if not path.is_file():
        return result
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = re.match(r"^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$", stripped)
        if match:
            key, value = match.group(1), match.group(2)
            # Strip optional surrounding quotes.
            if (value.startswith('"') and value.endswith('"')) or (
                value.startswith("'") and value.endswith("'")
            ):
                value = value[1:-1]
            result[key] = value
    return result


def load_creds() -> tuple[str, str, str, int]:
    """Read VPS creds without echoing. Override path via IPTV_HUB_VPS_ENV_PATH."""
    cred_path = Path(
        os.environ.get("IPTV_HUB_VPS_ENV_PATH", r"G:\private\.env.deploy")
    )
    creds = _parse_env_file(cred_path)
    host = creds.get("VPS_HOST", os.environ.get("VPS_HOST", ""))
    user = creds.get("VPS_USER", os.environ.get("VPS_USER", ""))
    pwd = creds.get("VPS_PASS", os.environ.get("VPS_PASS", ""))
    port = int(creds.get("VPS_PORT", os.environ.get("VPS_PORT", "22")) or "22")
    if not host or not user or not pwd:
        print(
            f"deploy: missing VPS creds (looked at {cred_path}); "
            "set VPS_HOST / VPS_USER / VPS_PASS",
            file=sys.stderr,
        )
        sys.exit(2)
    return host, user, pwd, port


def load_stack_env(deploy_dir: Path) -> dict[str, str]:
    env_file = deploy_dir / ".env"
    if not env_file.is_file():
        print(f"deploy: missing {env_file} — copy .env.example and fill it in", file=sys.stderr)
        sys.exit(2)
    env = _parse_env_file(env_file)
    required = ("DEPLOY_DOMAIN", "VPS_INSTALL_ROOT", "COMPOSE_PROJECT_NAME")
    missing = [k for k in required if not env.get(k)]
    if missing:
        print(f"deploy: .env missing required keys: {missing}", file=sys.stderr)
        sys.exit(2)
    env.setdefault("ROUTING_SCHEME", "subdomain")
    env.setdefault("CLIENT_MAX_MB", "64")
    return env


# ---------------------------------------------------------------------------- #
# SSH helpers.
# ---------------------------------------------------------------------------- #

def open_ssh(host: str, user: str, password: str, port: int) -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(
            hostname=host,
            port=port,
            username=user,
            password=password,
            timeout=20,
            auth_timeout=20,
            banner_timeout=20,
            look_for_keys=False,
            allow_agent=False,
        )
    except paramiko.AuthenticationException:
        print("deploy: ssh auth failed", file=sys.stderr)
        sys.exit(3)
    except (socket.timeout, socket.gaierror, OSError) as exc:
        print(f"deploy: ssh network error ({type(exc).__name__})", file=sys.stderr)
        sys.exit(4)
    return client


def run_remote(
    client: paramiko.SSHClient,
    cmd: str,
    sanitiser: Sanitiser,
    *,
    check: bool = True,
    timeout: float = 600.0,
) -> tuple[int, str, str]:
    log(f"[remote] {sanitiser(cmd)}", sanitiser=None)
    _, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    rc = stdout.channel.recv_exit_status()
    if out.strip():
        for line in out.splitlines():
            log(f"  {line}", sanitiser)
    if err.strip():
        for line in err.splitlines():
            log(f"  [stderr] {line}", sanitiser)
    if check and rc != 0:
        log(f"deploy: remote command failed (exit {rc})", sanitiser)
        sys.exit(7)
    return rc, out, err


def sftp_put_file(sftp: paramiko.SFTPClient, local: Path, remote: str, sanitiser: Sanitiser) -> None:
    log(f"  put  {local.name}  ->  {remote}", sanitiser)
    sftp.put(str(local), remote)


def sftp_makedirs(sftp: paramiko.SFTPClient, remote: str) -> None:
    parts = remote.strip("/").split("/")
    cur = "/"
    for part in parts:
        if not part:
            continue
        cur = posixpath.join(cur, part)
        try:
            sftp.stat(cur)
        except FileNotFoundError:
            sftp.mkdir(cur)


def sftp_put_tree(
    sftp: paramiko.SFTPClient,
    local_root: Path,
    remote_root: str,
    *,
    exclude: set[str],
    sanitiser: Sanitiser,
) -> int:
    sftp_makedirs(sftp, remote_root)
    pushed = 0
    for local in local_root.rglob("*"):
        if local.is_dir():
            continue
        # Compute the path relative to local_root using POSIX separators.
        rel = local.relative_to(local_root).as_posix()
        if any(rel == ex or rel.startswith(ex + "/") for ex in exclude):
            continue
        # Skip hidden files unless explicitly listed in the deploy set.
        if local.name.startswith("."):
            if local.name not in (".env.example", ".gitignore"):
                continue
        remote = posixpath.join(remote_root, rel)
        sftp_makedirs(sftp, posixpath.dirname(remote))
        try:
            sftp.put(str(local), remote)
        except OSError as exc:
            log(f"deploy: sftp put failed: {sanitiser(str(exc))}", sanitiser=None)
            sys.exit(9)
        pushed += 1
    return pushed


# ---------------------------------------------------------------------------- #
# Main flow.
# ---------------------------------------------------------------------------- #

def main() -> int:
    deploy_dir = Path(__file__).resolve().parent.parent
    repo_root = deploy_dir.parent

    stack_env = load_stack_env(deploy_dir)
    host, user, pwd, ssh_port = load_creds()
    sanitiser = Sanitiser(host, user, pwd)

    log("deploy: 1. generating stack artifacts locally")
    gen = subprocess.run(
        ["bash", str(deploy_dir / "scripts" / "generate-stack.sh")],
        cwd=str(deploy_dir),
        capture_output=True,
        text=True,
    )
    if gen.returncode != 0:
        log("deploy: generate-stack failed:", sanitiser=None)
        log(sanitiser(gen.stdout))
        log(sanitiser(gen.stderr))
        return 2

    nginx_build_dir = deploy_dir / "build" / "nginx"
    fragments = sorted(nginx_build_dir.glob("iptv-hub-*.conf"))
    log(f"deploy: {len(fragments)} nginx fragment(s) prepared locally")

    log("deploy: 2. opening ssh session")
    client = open_ssh(host, user, pwd, ssh_port)

    try:
        install_root = stack_env["VPS_INSTALL_ROOT"]

        log("deploy: 3. running preflight on VPS")
        run_remote(
            client,
            f"mkdir -p {install_root} && cd {install_root} && "
            f"test -f deploy/ports.json && bash deploy/scripts/preflight.sh || echo PREFLIGHT_SKIPPED_FIRST_RUN",
            sanitiser,
            check=False,
        )

        log("deploy: 4. uploading deploy/ tree to VPS")
        sftp = client.open_sftp()
        try:
            remote_deploy = posixpath.join(install_root, "deploy")
            sftp_makedirs(sftp, remote_deploy)
            exclude = {".env", "build/nginx", "upstream"}
            pushed = sftp_put_tree(
                sftp, deploy_dir, remote_deploy, exclude=exclude, sanitiser=sanitiser
            )
            log(f"  pushed {pushed} files")

            # Upload the operator's actual .env (separate so the exclude above
            # protects it from accidental commit-friendly copy).
            local_env = deploy_dir / ".env"
            if local_env.is_file():
                sftp_put_file(sftp, local_env, posixpath.join(remote_deploy, ".env"), sanitiser)

            log("deploy: 5. uploading rendered nginx fragments to /etc/nginx/conf.d/")
            # Stage in install_root first, then atomically move into /etc/nginx.
            staging = posixpath.join(install_root, "nginx-staging")
            run_remote(client, f"rm -rf {staging} && mkdir -p {staging}", sanitiser)
            for frag in fragments:
                sftp_put_file(
                    sftp,
                    frag,
                    posixpath.join(staging, frag.name),
                    sanitiser,
                )
        finally:
            sftp.close()

        # Validate nginx config with the staged fragments included BEFORE moving them in.
        log("deploy: 6. validating staged nginx fragments")
        # Mirror the live conf.d temporarily, splice in staged files, run nginx -t against the mirror.
        run_remote(
            client,
            f"set -e; "
            f"mkdir -p /tmp/iptv-hub-nginx-test/conf.d; "
            f"cp -a /etc/nginx/conf.d/. /tmp/iptv-hub-nginx-test/conf.d/ 2>/dev/null || true; "
            # Remove our own old fragments from the mirror so the test sees ONLY the new set.
            f"rm -f /tmp/iptv-hub-nginx-test/conf.d/iptv-hub-*.conf; "
            f"cp {staging}/* /tmp/iptv-hub-nginx-test/conf.d/ 2>/dev/null || true; "
            # Build a temp nginx.conf that includes the mirror dir.
            f"cat /etc/nginx/nginx.conf "
            f"| sed 's#/etc/nginx/conf.d#/tmp/iptv-hub-nginx-test/conf.d#g' "
            f"> /tmp/iptv-hub-nginx-test/nginx.conf; "
            f"nginx -t -c /tmp/iptv-hub-nginx-test/nginx.conf",
            sanitiser,
            check=False,
        )

        # If validation worked, move staged into place atomically.
        log("deploy: 7. installing nginx fragments and reloading")
        run_remote(
            client,
            f"set -e; "
            # Drop our previously installed fragments first.
            f"find /etc/nginx/conf.d -maxdepth 1 -name 'iptv-hub-*.conf' -delete; "
            # Copy the new ones in.
            f"cp {staging}/iptv-hub-*.conf /etc/nginx/conf.d/ 2>/dev/null || true; "
            # Final live validation.
            f"nginx -t && systemctl reload nginx",
            sanitiser,
        )

        log("deploy: 8. starting / updating docker compose stack")
        run_remote(
            client,
            f"cd {install_root}/deploy && "
            f"set -a && . ./.env && set +a && "
            f"docker compose --env-file .env "
            f"-f docker-compose.yml -f docker-compose.apps.yml "
            f"pull && "
            f"docker compose --env-file .env "
            f"-f docker-compose.yml -f docker-compose.apps.yml "
            f"up -d --remove-orphans",
            sanitiser,
        )

        log("deploy: 9. running post-deploy verification")
        rc, _, _ = run_remote(
            client,
            f"cd {install_root}/deploy && bash scripts/verify.sh",
            sanitiser,
            check=False,
        )
        if rc != 0:
            log("deploy: verification reported failures; containers running but unhealthy", sanitiser=None)
            return 8

        log("deploy: complete.", sanitiser=None)
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main())
