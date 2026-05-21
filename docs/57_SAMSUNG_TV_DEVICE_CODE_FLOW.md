# 57 · Samsung TV device-code login flow

Lane: `lane-cloud-pack`. The "fnice1971@gmail.com would have to accept users
registering" experience reaches the TV via this flow.

## The problem

Samsung Tizen TVs (2020 and later) ship a Chromium-based browser. Loading
`https://opentv.daveai.tech` on the TV works — TLS, cookies, JS, all fine.
But:

- Typing a password with the TV remote is painful.
- The on-screen keyboard takes 30+ seconds for "Sherri@example.com" + a
  decent password.
- Authentik's default flow assumes a real keyboard.

We need a flow where the TV asks the family member to **finish login on their
phone**, then the TV picks up the session.

## The flow

Authentik supports OAuth 2.0 Device Authorization Grant (RFC 8628). It is
not enabled by default; `authentik/scripts/seed-family-users.py` configures
it as part of the seed step.

What the family member sees:

1. TV browser opens `opentv.daveai.tech`. No session yet → Nginx
   `auth_request` returns 302 to `auth.daveai.tech/d`.
2. The `/d` route shows a short code (`ABCD-EFGH`), a QR code that links to
   `https://auth.daveai.tech/d/ABCD-EFGH`, and a "waiting" spinner.
3. Family member opens the QR with their phone camera (every modern phone
   supports this from the lock screen).
4. The phone lands on a normal Authentik login form — full keyboard, password
   managers, biometric autofill all work.
5. After login, the phone confirms "Allow opentv.daveai.tech on this TV?".
   They tap "Allow".
6. TV polls the device endpoint every 5 seconds. On the next poll after
   approval, Authentik returns a token. The TV sets its session cookie on
   `.daveai.tech` and redirects to `opentv.daveai.tech`.

Total time: ~20 seconds. No TV-keyboard typing.

Because the cookie is scoped to `.daveai.tech`, **the TV is now logged in to
every app subdomain at once**. They can navigate between `opentv`, `pitv`,
`iptvnator`, etc. without re-authenticating.

## Session lifetime

Default Authentik session is 14 days. For the family TV use case we extend
it to 90 days via the seed script — the family member only re-logs once a
quarter unless an admin revokes them.

This is a deliberate trade-off:

- Pro: A grandparent who fires up the TV once a month doesn't get kicked.
- Con: A revoked user keeps access until their token's next refresh, which
  Authentik checks on a 60-second interval. Acceptable for family.

If a user is revoked _hard_ (`is_active = false` in Authentik), their session
ends within 60 seconds regardless of expiry.

## What the operator sees

The Authentik admin UI shows two extra fields on the user record:

- **Devices** — every TV / phone / browser that has an active session, with
  real IP from `cloudflare-real-ip` and a "Revoke" button per row.
- **Pending device approvals** — anyone who started the flow on a TV but
  hasn't approved on their phone yet. Stale entries auto-expire after 10
  minutes.

Revoking a device terminates only that device's session; the user can re-pair
from any phone.

## Why not just a really long session

Could we skip the device flow and just give every family login a 1-year
session? Yes, but:

- It pushes the painful keyboard step from "once a quarter" to "once". The
  first login is still bad on the TV.
- It makes the "approve from phone" UX (which is the killer feature here)
  impossible.
- It encourages account sharing — Sherri logs in once, the kids use Sherri's
  session forever. The device list makes this visible to admins.

The device code flow earns its keep.

## TV-side technical notes

Tizen 2020+ browsers (model-year T2020 and later) handle `auth_request`
redirects, `Set-Cookie` with `Domain=.daveai.tech`, and `<meta refresh>` all
correctly. The `/d` page uses a 5-second `<meta http-equiv="refresh">` plus
JS polling, so even Tizens with hostile JS engines still complete the flow.

The QR code is generated client-side with a small inline JS lib
(`qrcode-svg`, 6KB) — no external request, no leak.

For older Samsungs (pre-2020 Tizen 4.0) the browser may not handle
`auth_request` 302s cleanly. The runbook lists those models as "use phone
or laptop instead". The family stack does not bend the security model to
accommodate them.

## What this lane does **not** do

- Does not implement a TV remote app or native Tizen package. The family
  uses the built-in browser; that's the whole shape.
- Does not implement device fingerprinting beyond the user agent + IP shown
  in the admin UI. Adding WebAuthn or attestation is a later-lane concern.
- Does not work offline. If the TV loses internet during the polling phase
  it shows a clear "no connection" message and recovers when the link is
  back.
