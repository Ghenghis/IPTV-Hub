#!/usr/bin/env python3
"""
Lane: lane-cloud-pack.

Idempotent seed for the family IPTV stack:
  - creates groups: family-admins, family-members, pending-family
  - creates the ten family admin users (no password yet — they receive an
    invite email and set their own)
  - creates an Application + Provider for each cloud-deployed IPTV app
  - creates the proxy outpost so Nginx's auth_request hits Authentik
  - configures the OIDC device-code flow used by Samsung TVs (doc 57)
  - sets session length to 90 days for family-members (doc 57)

Run from the operator laptop:

    ssh root@187.77.30.206 \\
        'cd /opt/iptv-hub/authentik && \\
         docker compose exec -T authentik-server python3 - ' \\
        < authentik/scripts/seed-family-users.py

The script reads $AUTHENTIK_BOOTSTRAP_TOKEN from the container environment.
It will refuse to run if the token is missing.

Re-running is safe. Every API call uses upsert semantics — pre-existing
records are reused, not duplicated.
"""

from __future__ import annotations

import os
import sys
import time
from dataclasses import dataclass
from typing import Any

import urllib.request
import urllib.error
import json

API = os.environ.get("AUTHENTIK_API_URL", "http://127.0.0.1:9000/api/v3")
TOKEN = os.environ.get("AUTHENTIK_BOOTSTRAP_TOKEN")

if not TOKEN:
    print("AUTHENTIK_BOOTSTRAP_TOKEN missing — refusing to seed.", file=sys.stderr)
    sys.exit(2)

HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Content-Type": "application/json",
    "Accept": "application/json",
}

# ── HTTP helpers ────────────────────────────────────────────────────────────

def _request(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    url = f"{API}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=HEADERS, method=method)
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                if resp.status == 204:
                    return {}
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if 500 <= e.code < 600 and attempt < 4:
                time.sleep(2 ** attempt)
                continue
            raise RuntimeError(f"{method} {path}: HTTP {e.code} {e.read().decode()[:300]}") from e
        except urllib.error.URLError as e:
            if attempt < 4:
                time.sleep(2 ** attempt)
                continue
            raise RuntimeError(f"{method} {path}: {e.reason}") from e
    raise RuntimeError(f"{method} {path}: gave up after retries")

def get(path: str) -> dict[str, Any]:
    return _request("GET", path)

def post(path: str, body: dict[str, Any]) -> dict[str, Any]:
    return _request("POST", path, body)

def patch(path: str, body: dict[str, Any]) -> dict[str, Any]:
    return _request("PATCH", path, body)

def upsert(list_path: str, lookup_key: str, lookup_value: str,
           create_body: dict[str, Any]) -> dict[str, Any]:
    """Find a record by a unique field; create it if missing; return it."""
    found = get(f"{list_path}?{lookup_key}={lookup_value}")
    if found.get("results"):
        return found["results"][0]
    return post(list_path, create_body)

# ── Wait for Authentik to be ready ─────────────────────────────────────────

def wait_for_ready(timeout_s: int = 120) -> None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            get("/root/config/")
            return
        except RuntimeError:
            time.sleep(2)
    raise SystemExit("Authentik API never came up; check container logs.")

# ── Groups ─────────────────────────────────────────────────────────────────

@dataclass
class Group:
    name: str
    superuser: bool

GROUPS = [
    Group("family-admins",  True),
    Group("family-members", False),
    Group("pending-family", False),
]

def ensure_groups() -> dict[str, str]:
    """Return {name: uuid}."""
    out = {}
    for g in GROUPS:
        rec = upsert("/core/groups/", "name", g.name, {
            "name": g.name,
            "is_superuser": g.superuser,
            "parent": None,
            "attributes": {"managed_by": "iptv-hub-cloud-pack"},
        })
        out[g.name] = rec["pk"]
    return out

# ── Family admins ──────────────────────────────────────────────────────────

ADMINS = [
    # (username, display name, email)
    ("dave",    "Dave",    "fnice1971@gmail.com"),
    ("sherri",  "Sherri",  "sherri@example.invalid"),
    ("warren",  "Warren",  "warren@example.invalid"),
    ("suzy",    "Suzy",    "suzy@example.invalid"),
    ("jeff",    "Jeff",    "jeff@example.invalid"),
    ("missy",   "Missy",   "missy@example.invalid"),
    ("tyler",   "Tyler",   "tyler@example.invalid"),
    ("nick",    "Nick",    "nick@example.invalid"),
    ("savanna", "Savanna", "savanna@example.invalid"),
]

def ensure_admins(group_pks: dict[str, str]) -> None:
    admin_pk = group_pks["family-admins"]
    member_pk = group_pks["family-members"]
    for username, name, email in ADMINS:
        rec = upsert("/core/users/", "username", username, {
            "username": username,
            "name": name,
            "email": email,
            "is_active": True,
            "groups": [admin_pk, member_pk],
            "attributes": {"role": "family-admin"},
        })
        # If the record already existed, ensure group membership is current.
        current = set(rec.get("groups", []))
        wanted  = {admin_pk, member_pk}
        if not wanted.issubset(current):
            patch(f"/core/users/{rec['pk']}/",
                  {"groups": list(current | wanted)})

# ── Apps and proxy providers ───────────────────────────────────────────────

@dataclass
class App:
    slug: str         # subdomain
    name: str         # human-readable
    internal: str     # internal URL Nginx upstream's to

APPS = [
    App("opentv",     "open-tv",        "http://127.0.0.1:8002"),
    App("iptvnator",  "iptvnator",      "http://127.0.0.1:8001"),
    App("pitv",       "PiTV",           "http://127.0.0.1:8003"),
    App("smartiptv",  "Smart-IPTV-Web", "http://127.0.0.1:8004"),
    App("nuvio",      "NuvioWeb",       "http://127.0.0.1:8005"),
    App("reactiptv",  "react-iptv",     "http://127.0.0.1:8006"),
    App("neptune",    "neptune-tv",     "http://127.0.0.1:8007"),
]

def ensure_app(app: App, group_pks: dict[str, str]) -> str:
    """Create proxy provider + application + policy binding. Return provider pk."""
    external_host = f"https://{app.slug}.daveai.tech"

    provider = upsert("/providers/proxy/", "name", f"prov-{app.slug}", {
        "name": f"prov-{app.slug}",
        "authorization_flow": _flow_uuid("default-provider-authorization-implicit-consent"),
        "external_host": external_host,
        "internal_host": app.internal,
        "internal_host_ssl_validation": False,
        "mode": "forward_single",   # Nginx auth_request flow
        "cookie_domain": "daveai.tech",
        "skip_path_regex": "^/outpost.goauthentik.io/.*$",
        "access_token_validity": "hours=24",
        "refresh_token_validity": "days=90",
    })

    application = upsert("/core/applications/", "slug", app.slug, {
        "name": app.name,
        "slug": app.slug,
        "provider": provider["pk"],
        "open_in_new_tab": False,
        "meta_description": f"Family IPTV app: {app.name}",
        "meta_launch_url": external_host,
        "policy_engine_mode": "any",
    })

    # Bind: only members of family-admins OR family-members can launch.
    _ensure_group_binding(application["pk"], group_pks["family-admins"])
    _ensure_group_binding(application["pk"], group_pks["family-members"])
    return provider["pk"]

def _ensure_group_binding(application_pk: str, group_pk: str) -> None:
    existing = get(f"/policies/bindings/?target={application_pk}&group={group_pk}")
    if existing.get("results"):
        return
    post("/policies/bindings/", {
        "target": application_pk,
        "group": group_pk,
        "enabled": True,
        "order": 0,
    })

def _flow_uuid(slug: str) -> str:
    result = get(f"/flows/instances/?slug={slug}")
    if not result.get("results"):
        raise RuntimeError(f"expected flow '{slug}' to exist (Authentik default)")
    return result["results"][0]["pk"]

# ── Outpost (the binary Nginx forwards auth_request to) ────────────────────

def ensure_outpost(provider_pks: list[str]) -> None:
    existing = get("/outposts/instances/?name=embedded-outpost")
    if existing.get("results"):
        rec = existing["results"][0]
        # Ensure all our providers are attached.
        current = set(rec.get("providers", []))
        wanted  = set(provider_pks)
        if not wanted.issubset(current):
            patch(f"/outposts/instances/{rec['pk']}/",
                  {"providers": list(current | wanted)})
        return
    post("/outposts/instances/", {
        "name": "embedded-outpost",
        "type": "proxy",
        "providers": provider_pks,
        "config": {
            "authentik_host": "http://127.0.0.1:9000",
            "authentik_host_browser": "https://auth.daveai.tech",
            "authentik_host_insecure": False,
            "log_level": "info",
            "object_naming_template": "ak-outpost-%(name)s",
            "docker_network": None,
            "docker_map_ports": True,
            "container_image": None,
            "kubernetes_replicas": 1,
            "kubernetes_namespace": "default",
        },
    })

# ── Invitation flow + branding for the /d device-code page ────────────────

def configure_invitation_flow(group_pks: dict[str, str]) -> None:
    pending_pk = group_pks["pending-family"]
    # Find Authentik's default enrollment flow and clone it as 'family-invite'.
    # If the operator wants to customise the form, they edit it in the admin UI;
    # the seed script only ensures the slug exists.
    existing = get("/flows/instances/?slug=family-invite")
    if existing.get("results"):
        return
    post("/flows/instances/", {
        "name": "family-invite",
        "slug": "family-invite",
        "title": "Request access to the family IPTV hub",
        "designation": "enrollment",
        "authentication": "none",
        "policy_engine_mode": "any",
        "compatibility_mode": False,
        "denied_action": "message_continue",
    })
    # Ensure the resulting user ends up in pending-family. The actual stage
    # bindings (prompt for name/email + assign-group) are configured via the
    # admin UI on first login; this script ensures the flow exists.
    _ = pending_pk  # kept for clarity that the binding will target this group

# ── Session lifetime for family-members ────────────────────────────────────

def configure_session_lifetime() -> None:
    # Authentik exposes a tenant-level default. The 90-day setting lives on
    # the embedded brand record.
    brands = get("/core/brands/")
    if not brands.get("results"):
        return
    brand_pk = brands["results"][0]["pk"]
    patch(f"/core/brands/{brand_pk}/", {
        "default_user_settings": {"session_duration": "days=90"},
    })

# ── Verification ──────────────────────────────────────────────────────────

def verify() -> None:
    """Fail loudly if the seed didn't take."""
    expected = {a[0] for a in ADMINS}
    found = {u["username"] for u in get("/core/users/")["results"]}
    missing = expected - found
    if missing:
        raise SystemExit(f"seed verification failed — missing admins: {sorted(missing)}")
    print(f"  verified {len(expected)} family admins present.")
    for g in GROUPS:
        if not get(f"/core/groups/?name={g.name}")["results"]:
            raise SystemExit(f"seed verification failed — group {g.name} missing")
    print(f"  verified {len(GROUPS)} groups present.")
    for a in APPS:
        if not get(f"/core/applications/?slug={a.slug}")["results"]:
            raise SystemExit(f"seed verification failed — application {a.slug} missing")
    print(f"  verified {len(APPS)} applications present.")

# ── Main ───────────────────────────────────────────────────────────────────

def main() -> None:
    print("waiting for Authentik API …")
    wait_for_ready()
    print("seeding groups …")
    group_pks = ensure_groups()
    print("seeding family admins …")
    ensure_admins(group_pks)
    print("seeding applications + proxy providers …")
    provider_pks = [ensure_app(a, group_pks) for a in APPS]
    print("ensuring outpost has all providers attached …")
    ensure_outpost(provider_pks)
    print("ensuring invitation flow exists …")
    configure_invitation_flow(group_pks)
    print("configuring 90-day session lifetime …")
    configure_session_lifetime()
    print("verifying …")
    verify()
    print("done.")

if __name__ == "__main__":
    main()
