#!/usr/bin/env python3
"""
Build-time patch for upstream iptv_player.py (RickyRLD/iptv-player).

Replaces four hardcoded literals with environment-driven defaults so the
container can bind to 0.0.0.0 (instead of 127.0.0.1) and so the operator can
override the M3U path, EPG URL, port, and bind host without rebuilding the
image. The four originals are baked in by upstream as one-liners — each must
appear *exactly once* in the source, otherwise upstream has drifted and the
build fails on purpose (silent drift is worse than a broken build).

Usage:
    python3 patch_iptv_player.py <path-to-iptv_player.py>

Exit codes:
    0  patched cleanly (4 substitutions applied)
    2  one or more expected literals missing  (upstream drift)
    3  one or more expected literals not unique (upstream drift)
"""
from __future__ import annotations

import pathlib
import sys


REPLACEMENTS: list[tuple[str, str]] = [
    (
        'M3U_FILE   = os.path.join(BASE_DIR, "rpl.m3u")',
        'M3U_FILE   = os.environ.get("IPTV_M3U_FILE", os.path.join(BASE_DIR, "rpl.m3u"))',
    ),
    (
        'EPG_URL    = "http://list.plusx.tv/pl10.gz"',
        'EPG_URL    = os.environ.get("IPTV_EPG_URL", "http://list.plusx.tv/pl10.gz")',
    ),
    (
        'PORT       = 8765',
        'PORT       = int(os.environ.get("IPTV_PORT", "8765"))',
    ),
    (
        'server = HTTPServer(("127.0.0.1", PORT), Handler)',
        'server = HTTPServer((os.environ.get("IPTV_BIND_HOST", "0.0.0.0"), PORT), Handler)',
    ),
]


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        sys.stderr.write(f"usage: {argv[0]} <iptv_player.py>\n")
        return 1

    target = pathlib.Path(argv[1])
    src = target.read_text(encoding="utf-8")

    for old, new in REPLACEMENTS:
        if old not in src:
            sys.stderr.write(f"patch: expected literal not found: {old!r}\n")
            return 2
        if src.count(old) != 1:
            sys.stderr.write(
                f"patch: literal not unique ({src.count(old)} matches): {old!r}\n"
            )
            return 3
        src = src.replace(old, new)

    target.write_text(src, encoding="utf-8")
    print(f"patched {target}: {len(REPLACEMENTS)} substitutions applied")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
