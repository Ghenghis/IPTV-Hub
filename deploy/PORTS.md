# IPTV Hub — Port Allocation Policy

> **This document is the single source of truth for every TCP port the IPTV-Hub VPS
> stack exposes on its host. Deviating from this allocation is a deploy-time error;
> `deploy/scripts/preflight.sh` fails any host where one of the listed ports is
> already bound by another process.**

## 1. Why this matters

Two collisions cause silent corruption that surfaces hours later:

- A port already used by some other host service (Prometheus, Elasticsearch, a
  printer, the Docker daemon, the SSH daemon) — the container starts but no
  packets reach it.
- Two of our own apps fighting for the same port across re-deploys — only one
  binds; the other dies with "address in use" buried in container logs.

We pick a band where IANA, common server roles, and the Docker default ephemeral
range all leave us alone. Within that band each app gets a deterministic 10-port
slot keyed off its catalogue index, so the same app gets the same port on every
host, every deploy, forever.

## 2. The band: **9600–9899**

Avoided port hazards (do **not** reuse any of these for IPTV-Hub workloads):

| Range / port | Why we avoid |
| --- | --- |
| `0–1023` | Privileged. Only `80` and `443` (Caddy) live here. |
| `3000` | Node dev default; clashes with Grafana on some hosts. |
| `3306`, `5432`, `6379`, `27017` | MySQL / Postgres / Redis / Mongo. |
| `4200` | Angular dev server. |
| `5173`, `5174`, `5175` | Vite dev defaults. |
| `8080`, `8443`, `8888` | Universal alt-HTTP/HTTPS. |
| `8200`, `8300–8600` | HashiCorp Vault, Consul. |
| `9000`, `9001` | Portainer, MinIO, PHP-FPM, SonarQube. |
| `9090`, `9091` | Prometheus, Transmission. |
| `9100–9107` | HP JetDirect printer ports — many office VPSes still expose these. |
| `9200`, `9300`, `9400` | Elasticsearch HTTP, transport, alt. |
| `9418` | `git://` daemon. |
| `9500–9599` | Reserved for ad-hoc debugging / one-off deploys (see §5). |
| `9999` | Anki Connect / Bitcoin / Lantronix — also our Caddy admin loopback. |
| `32768–60999` | Linux ephemeral. Docker also pulls from here. |
| `49152–65535` | Windows ephemeral. |

Within `9600–9899` IANA leaves almost everything unassigned. The few exceptions
(`9700` "silver-platter", `9750` "board-roar", `9800` "WebDAV source") are rare
enough that no commodity hosting product binds them.

## 3. Deterministic app slot table

Catalogue order matches `schema/examples/full-28-apps.json`. The slot rule:

```
slot_base(N) = 9600 + N * 10        # N = catalogue index, 0-based
```

| # | App id | Slot base | HTTP | WS | Metrics | Reserved |
| --- | --- | --- | --- | --- | --- | --- |
| 01 | `authoiptv` | 9600 | 9600 | 9601 | 9602 | 9603–9609 |
| 02 | `cinexa` | 9610 | 9610 | 9611 | 9612 | 9613–9619 |
| 03 | `clubtivi-windows` | 9620 | 9620 | 9621 | 9622 | 9623–9629 |
| 04 | `extreme-infinitv` | 9630 | 9630 | 9631 | 9632 | 9633–9639 |
| 05 | `free-tv-iptv` | 9640 | 9640 | 9641 | 9642 | 9643–9649 |
| 06 | `harmonyiptv` | 9650 | 9650 | 9651 | 9652 | 9653–9659 |
| 07 | `iptauriv` | 9660 | 9660 | 9661 | 9662 | 9663–9669 |
| 08 | `iptv` | 9670 | 9670 | 9671 | 9672 | 9673–9679 |
| 09 | `iptvnator` | 9680 | 9680 | 9681 | 9682 | 9683–9689 |
| 10 | `iptv-restream` | 9690 | 9690 | 9691 | 9692 | 9693–9699 |
| 11 | `iptv-stream` | 9700 | 9700 | 9701 | 9702 | 9703–9709 |
| 12 | `maxvideoplayer` | 9710 | 9710 | 9711 | 9712 | 9713–9719 |
| 13 | `neptune-tv` | 9720 | 9720 | 9721 | 9722 | 9723–9729 |
| 14 | `nuvioweb` | 9730 | 9730 | 9731 | 9732 | 9733–9739 |
| 15 | `open-tv` | 9740 | 9740 | 9741 | 9742 | 9743–9749 |
| 16 | `orbiscast` | 9750 | 9750 | 9751 | 9752 | 9753–9759 |
| 17 | `pitv` | 9760 | 9760 | 9761 | 9762 | 9763–9769 |
| 18 | `react-iptv` | 9770 | 9770 | 9771 | 9772 | 9773–9779 |
| 19 | `smart-iptv-web` | 9780 | 9780 | 9781 | 9782 | 9783–9789 |
| 20 | `stalker-ui` | 9790 | 9790 | 9791 | 9792 | 9793–9799 |
| 21 | `stremio` | 9800 | 9800 | 9801 | 9802 | 9803–9809 |
| 22 | `tvapp` | 9810 | 9810 | 9811 | 9812 | 9813–9819 |
| 23 | `wizju-iptv-player` | 9820 | 9820 | 9821 | 9822 | 9823–9829 |
| 24 | `xstream-player` | 9830 | 9830 | 9831 | 9832 | 9833–9839 |
| 25 | `ynotv` | 9840 | 9840 | 9841 | 9842 | 9843–9849 |
| 26 | `crunchyroll-tizen` | 9850 | 9850 | 9851 | 9852 | 9853–9859 |
| 27 | `fred-tv` | 9860 | 9860 | 9861 | 9862 | 9863–9869 |
| 28 | `iptv-desktop` | 9870 | 9870 | 9871 | 9872 | 9873–9879 |

Apps 26–28 are not web-deployable (`tizen-ipk` and Windows `installer` types) — they
keep slot reservations so that if they ever ship a web mode the slot is theirs.

## 4. Reserved infrastructure ports (`9880–9899`)

| Port | Service | Bind |
| --- | --- | --- |
| 9880 | Prometheus (scrape target metrics) | host loopback only |
| 9881 | Grafana | reverse-proxied behind Caddy at `/grafana/` |
| 9882 | Loki (log aggregation) | loopback |
| 9883 | Promtail (log shipper) | loopback |
| 9884 | Caddy admin API | **loopback only** (no public exposure) |
| 9885 | Healthcheck aggregator (`deploy/verify.sh` endpoint) | loopback |
| 9886–9899 | Reserved (Alertmanager, Node Exporter, blackbox, etc.) |  |

## 5. Ad-hoc / debug slot

`9500–9599` is the only range that may be used outside this document, and only by
`deploy/scripts/run-debug.sh` for a single-container test. Anything that lives
past the debugging session must move into the 9600+ table before the deploy
commits.

## 6. Public entry points

Only the reverse proxy is exposed to the public network.

| Port | Bound by | Notes |
| --- | --- | --- |
| 80 | Caddy | ACME HTTP-01 challenge + `http→https` redirect. |
| 443 | Caddy | All app traffic terminates here, routed by `Host:` header. |

App ports `9600–9899` bind to `127.0.0.1` on the host (or to the docker bridge
network only) — they are **never** opened to the public internet. Caddy is the
single ingress.

## 7. Routing rules

Each app gets either a subdomain (preferred) or a `/`-path under a shared host:

```
nuvioweb.<domain>          -> 127.0.0.1:9730
react-iptv.<domain>        -> 127.0.0.1:9770
…
iptvnator.<domain>         -> 127.0.0.1:9680
```

Or, if the operator chooses a single domain:

```
<domain>/nuvioweb/         -> 127.0.0.1:9730
<domain>/react-iptv/       -> 127.0.0.1:9770
…
```

The `Caddyfile` in `deploy/caddy/` is generated from this table and the
operator's choice of routing scheme.

## 8. Pre-deploy verification

`deploy/scripts/preflight.sh` (POSIX shell, runs on the VPS over SSH) does:

1. Reads this table (via the machine-readable `deploy/ports.json` mirror).
2. For each port: `ss -ltn` (or `netstat -tln` fallback) to check the port is
   free on `127.0.0.1`.
3. Exits non-zero with the conflicting `pid/proc` if any port is already taken.

The Windows-side mirror `deploy/scripts/preflight.ps1` does the same with
`Get-NetTCPConnection -State Listen` for local testing.

## 9. How to change this

Adding an app, splitting a slot, or repurposing a port requires a PR that
updates **both** `deploy/PORTS.md` and `deploy/ports.json`, plus the regenerated
`deploy/caddy/Caddyfile`. No exceptions — even a one-off staging deploy must
allocate from §5 (`9500–9599`) and never elsewhere.
