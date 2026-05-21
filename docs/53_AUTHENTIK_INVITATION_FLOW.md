# 53 · Authentik invitation flow

Lane: `lane-cloud-pack`. Picks up after `52_CLOUDFLARE_REAL_IP_AND_SSL.md`.

This document defines the auth model for the cloud-deployed IPTV apps. It is
prescriptive: anything that contradicts it (e.g. open registration, anonymous
proxies, shared accounts) is out of contract for this lane.

## Why Authentik

Authentik is the single sign-on gateway. One login at `auth.daveai.tech` covers
every subdomain because the session cookie is scoped to `.daveai.tech`.
Authentik is reached by Nginx via the `auth_request` directive (see
`upstream/nginx/auth-gate.conf.example`); apps themselves are never exposed to
the public internet directly.

Three reasons over Authelia / Keycloak:

1. **Invitation flow is a first-class feature.** A pending user signs up,
   Authentik holds them in a quarantined group until a `family-admins` member
   approves. No glue code.
2. **Group-delegated approval.** Any of the ten family admins can approve, not
   only the root user. Matches the brief.
3. **OIDC device code flow is built in.** Samsung TVs use this — see
   `57_SAMSUNG_TV_DEVICE_CODE_FLOW.md`.

## Trust model

Three groups, evaluated in this order:

| Group | Members | Can do |
|---|---|---|
| `family-admins` | Dave, Sherri, Warren, Suzy, Jeff, Missy, Tyler, Nick, Savanna, plus the root account `fnice1971@gmail.com` | Access all apps. Invite. Approve pending users. Revoke. |
| `family-members` | Everyone an admin approves into the family | Access all apps. Cannot invite or approve. |
| `pending-family` | Anyone who submitted the invitation form but has not been approved | No app access. Holds the application record until an admin acts. |

A user with no group membership is rejected at the Nginx `auth_request` layer
before any app proxy. The `auth-gate` snippet enforces this; do not bypass it
even for "internal" or "trusted" subdomains.

## The invitation flow, end to end

1. **Stranger reaches the invite form.** They open
   `https://auth.daveai.tech/if/flow/family-invite/`. The flow is defined in
   `authentik/scripts/seed-family-users.py` and is reachable without a login.
2. **They submit name + email.** Authentik creates a user, adds them to
   `pending-family`, and emails every member of `family-admins` with a one-click
   approval link.
3. **First admin to click decides.** The admin lands on a one-screen approval
   page. Approve → user moves to `family-members`, gets a welcome email with
   the login link. Reject → user is deleted, the requester is told their
   request was declined (no reason given).
4. **The new member logs in.** Cookie is set on `.daveai.tech`. Every app
   subdomain works without a second login.

There is no public signup form linked from any app. The only way to land on
the invitation flow is to know the URL — admins share it deliberately.

## SMTP

Authentik sends the invitation, approval, and welcome emails over Gmail SMTP
using an app password on `fnice1971@gmail.com`. The app password is generated
at <https://myaccount.google.com/apppasswords> and stored only in the secrets
file mounted into the Authentik container (see `54_IPTV_HUB_CLOUD_DEPLOYMENT.md`
§ "Secrets layout"). It is never committed.

If Gmail rate-limits or you want a separate sender identity, switch to
Postmark / SES / Mailgun by changing the four `AUTHENTIK_EMAIL__*` environment
variables. The flow is otherwise unchanged.

## Bootstrap order

This sequence runs once on a new VPS:

1. `scripts/cloud-bootstrap.sh` — installs Docker, opens UFW for Cloudflare
   only, prepares `/opt/iptv-hub/` directory tree, generates the `acme.sh`
   wildcard cert for `*.daveai.tech`.
2. `scripts/sync-secrets.sh` — copies the operator's local
   `~/.iptv-hub-secrets/` into `/opt/iptv-hub/secrets/` with mode `0600`.
3. `docker compose -f authentik/docker-compose.yml up -d` — brings Authentik
   online. The first boot may take 60–90 seconds while the database migrates.
4. `python3 authentik/scripts/seed-family-users.py` — pre-creates the ten
   `family-admins`, defines the `family-members` and `pending-family` groups,
   and creates the invitation flow. Idempotent; safe to re-run.
5. `docker compose -f apps/<id>/docker-compose.yml up -d` — for each app.
6. `nginx -s reload` — applies all the new `upstream/nginx/*.conf` files.

Skipping the seed step leaves Authentik in a state where the very first user
to log in is the superuser — useful for recovery, dangerous in normal
operation. The seed script ends with a verification step that fails loudly if
the ten admins are not present.

## Day-two operations

- **Add an admin** — log into Authentik admin UI as any existing admin, add the
  user to `family-admins`. They can immediately approve invitations.
- **Revoke access** — remove the user from both `family-admins` and
  `family-members`. Their session terminates within 60 seconds (Authentik
  re-checks group membership on its token refresh interval).
- **Audit who logged in** — Authentik admin UI → Events → Login. The
  `cloudflare-real-ip` Nginx include feeds real visitor IPs into Authentik via
  the `X-Real-IP` header so this log is meaningful.
- **Rotate the Gmail app password** — generate a new one, replace it in
  `~/.iptv-hub-secrets/authentik.env`, re-run `scripts/sync-secrets.sh`,
  `docker compose -f authentik/docker-compose.yml restart authentik-server
  authentik-worker`.

## Out of scope for this lane

- LDAP / Active Directory backing.
- SAML or social-login sources (Google / GitHub / Apple sign-in).
- Multi-factor enrolment beyond TOTP. (TOTP is supported by default; admins
  may enable it per-user but it is not enforced.)
- Public sign-up without an admin in the loop.

These can land in later lanes if the family ever grows beyond ten or if the
threat model changes.
