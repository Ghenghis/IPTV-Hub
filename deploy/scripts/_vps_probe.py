"""VPS capability probe — never echoes credentials.

Reads VPS_HOST / VPS_USER / VPS_PASS from process env (caller must source the
.env.deploy file privately). Connects via Paramiko, runs a low-volume survey of
the VPS, prints results to stdout with any host-identifying tokens replaced by
'<host>'.

Exit codes:
    0  — connected, survey collected.
    2  — env vars missing.
    3  — authentication failure.
    4  — network / DNS / timeout.
    5  — other paramiko error.
"""
from __future__ import annotations

import os
import re
import socket
import sys
import time

import paramiko


def sanitize(text: str, host: str, user: str, password: str) -> str:
    if not text:
        return text
    out = text
    for token, repl in ((host, "<host>"), (user, "<user>"), (password, "<redacted>")):
        if token:
            out = out.replace(token, repl)
    # Drop any IPv4 that looks like the configured host even with sub-octet variations.
    if host and re.match(r"^\d+\.\d+\.\d+\.\d+$", host):
        # Replace the bare host's first 3 octets to mask any other reference
        first_three = ".".join(host.split(".")[:3])
        out = out.replace(first_three, "<net>")
    return out


def main() -> int:
    host = os.environ.get("VPS_HOST", "")
    user = os.environ.get("VPS_USER", "")
    password = os.environ.get("VPS_PASS", "")
    port = int(os.environ.get("VPS_PORT", "22") or "22")

    if not host or not user or not password:
        print("missing_env_vars")
        return 2

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    try:
        t0 = time.time()
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
        connect_ms = int((time.time() - t0) * 1000)
        print(f"ssh_connect_ms={connect_ms}")
    except paramiko.AuthenticationException:
        print("category=auth_failed")
        return 3
    except (socket.timeout, socket.gaierror, ConnectionRefusedError, OSError) as exc:
        msg = str(exc)
        if "Name or service not known" in msg or "gaierror" in msg:
            print("category=dns_failure")
        elif "timed out" in msg.lower():
            print("category=timeout")
        elif "refused" in msg.lower():
            print("category=connection_refused")
        else:
            print("category=network_other")
            print(f"detail={sanitize(msg, host, user, password)[:200]}")
        return 4
    except paramiko.SSHException as exc:
        print("category=ssh_error")
        print(f"detail={sanitize(str(exc), host, user, password)[:200]}")
        return 5

    # Single combined command — one round trip. Each line tagged so we can
    # parse without revealing per-command stdout/stderr separately.
    survey = r"""
. /etc/os-release 2>/dev/null && echo OS=${ID}-${VERSION_ID} || echo OS=unknown
uname -r | sed 's/^/KERNEL=/'
uname -m | sed 's/^/ARCH=/'
nproc 2>/dev/null | sed 's/^/CORES=/'
awk '/MemTotal/{printf "MEM_GB=%.1f\n",$2/1024/1024}' /proc/meminfo
df -BG / | awk 'NR==2{gsub("G","",$4); print "DISK_FREE_GB="$4}'
(command -v docker >/dev/null && docker --version) || echo DOCKER=missing
(docker compose version 2>/dev/null | head -1) || echo COMPOSE=missing
(command -v jq >/dev/null && jq --version) || echo JQ=missing
(command -v curl >/dev/null && curl --version | head -1) || echo CURL=missing
(command -v git >/dev/null && git --version) || echo GIT=missing
ss -ltn 2>/dev/null | tail -n +2 | wc -l | sed 's/^/LISTENERS=/'
id -u | sed 's/^/UID=/'
test -w / && echo ROOT_WRITABLE=yes || echo ROOT_WRITABLE=no
"""

    try:
        stdin_, stdout, stderr = client.exec_command(survey, timeout=30)
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        rc = stdout.channel.recv_exit_status()
    finally:
        client.close()

    print(f"survey_exit={rc}")
    for line in out.splitlines():
        line = line.strip()
        if line:
            print(sanitize(line, host, user, password))
    if err.strip():
        print("--- stderr (sanitized) ---")
        for line in err.splitlines():
            line = line.strip()
            if line:
                print(sanitize(line, host, user, password))

    return 0 if rc == 0 else 5


if __name__ == "__main__":
    sys.exit(main())
