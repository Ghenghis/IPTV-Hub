# 55 · UFW Cloudflare origin lockdown

Lane: `lane-cloud-pack`. Closes the spoofing hole that doc 52 partially
addressed at the Nginx layer.

## What this fixes

Doc 52 narrowed Nginx's `set_real_ip_from` to Cloudflare's CIDRs, so a forged
`CF-Connecting-IP` header from a non-Cloudflare source is ignored. That stops
log poisoning and the auth-audit spoof.

It does **not** stop a direct connection to the origin. Anyone who knows
`187.77.30.206` can still:

- Connect directly to port 443, get a TLS handshake, and probe the apps.
- Bypass Cloudflare WAF, rate-limiting, and bot challenges.
- Hit the apps from a country Cloudflare would have blocked.

The fix is at the firewall, not Nginx: drop any inbound 80/443 traffic that
isn't from a published Cloudflare range.

## The rules

`scripts/cloud-ufw-cloudflare.sh` builds the rule set idempotently:

1. `ufw default deny incoming` and `ufw default allow outgoing` (baseline).
2. `ufw allow 22/tcp` from the operator's static IP only. The operator's IP
   comes from `OPERATOR_SSH_IP` in `cloudflare.env`. Falls back to "any" with
   a loud warning if unset, because locking yourself out of the VPS by
   misconfiguring this rule is the most common UFW disaster.
3. For each Cloudflare IPv4 CIDR: `ufw allow proto tcp from <cidr> to any
   port 80,443`.
4. For each Cloudflare IPv6 CIDR: same, ipv6.
5. `ufw enable` (no-op if already enabled).
6. `ufw status numbered` printed at the end so the operator can confirm.

The script reads the current ranges from
`/etc/iptv-hub/cloudflare-ips-v4.txt` and `-v6.txt`, which
`scripts/update-cloudflare-ips.sh` keeps fresh. Hard-coding ranges in the
script body would re-introduce the staleness problem (the old IPv6
`2405:b500::/32` is a real example of a range that left the published list
mid-2025).

## Operating consequences

Once the lockdown is on:

- `curl https://187.77.30.206 -k` from anywhere except the operator's IP →
  connection refused. Good.
- `curl https://opentv.daveai.tech` → succeeds (traffic comes from
  Cloudflare). Good.
- The Hostinger panel's "VPS console" SSH still works because it tunnels
  through their network, not the public IP.

Cloudflare's "Origin Server Rules" feature can also restrict direct origin
hits, but it relies on the origin server cooperating. UFW is the
authoritative drop point.

## What to do if you lock yourself out

1. Use the Hostinger panel's web SSH console — it bypasses UFW because it
   goes through their hypervisor, not the public network.
2. `ufw disable` to fall back to "anything allowed", then fix the rule set,
   then `ufw enable` again.
3. If panel SSH is also down for some reason, request a Hostinger console
   session ("Recovery mode" in the panel's "Settings" → "Boot in recovery").

`scripts/cloud-ufw-cloudflare.sh` always re-allows the operator IP before
applying the deny rules, so re-running the script with a correct
`OPERATOR_SSH_IP` is the fastest recovery.

## Why not Cloudflare Tunnel

A `cloudflared` tunnel removes the origin from the public internet entirely —
no inbound ports, no firewall rule maintenance. It is genuinely the better
architecture and a fair future lane.

For this lane we keep the public IP because:

- Hostinger's VPS panel SSH expects port 22 reachable.
- The operator's existing Nginx for `hermestv.daveai.tech` is reachable on
  the public IP and is in active use.
- A tunnel adds a moving part (`cloudflared` as a single point of failure)
  that the family stack hasn't earned yet.

Once the cloud pack has been running cleanly for a few weeks, migrating to
Tunnel is a 2-hour lane: install `cloudflared`, register a tunnel, point the
public hostnames at the tunnel ingress, `ufw deny 80,443` from everywhere.

## Verifying the lock

After applying:

```bash
# From the operator laptop — should succeed:
curl -sI https://opentv.daveai.tech | head -1

# From a different IP (e.g. a phone on cellular, or a free shell on a
# different VPS) — should hang/refuse:
curl -sI --connect-timeout 5 https://187.77.30.206
# expected: curl: (28) Connection timed out
```

If the second curl returns a TLS handshake, the lockdown didn't take —
re-run the script and check `ufw status numbered` for the deny line.
