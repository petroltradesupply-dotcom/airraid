"""Static checks for the map page.

Three failures have actually happened while building this page, and each one is silent -
the page still loads, it is just wrong. That is what this guards.

    a stale ?v= hash      nginx caches assets for seven days, so a fix that ships with the
                          old query string is invisible until the cache expires. This cost
                          an evening once.
    a missing asset       a renamed file leaves a 404 that only shows up as a blank map.
    malformed JSON        the manifest or the map style parses at load time, in the
                          browser, on the phone, at night.

Run it from the repository root:

    python3 tools/check_web.py
"""

from __future__ import annotations

import hashlib
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
WEB = ROOT / "web"

# Files the page pulls in through a URL of its own, as opposed to ones the browser only
# ever reaches through another asset.
REF = re.compile(r'(?:href|src)="([^"#?]+)(?:\?v=([0-9a-f]+))?"')


def digest(path: pathlib.Path) -> str:
    return hashlib.sha1(path.read_bytes()).hexdigest()[:8]


def check() -> list[str]:
    problems: list[str] = []
    index = WEB / "index.html"
    if not index.exists():
        return [f"немає {index.relative_to(ROOT)}"]

    html = index.read_text(encoding="utf-8")

    for ref, stamp in REF.findall(html):
        if ref.startswith(("http://", "https://", "//", "data:", "mailto:")):
            continue
        target = (WEB / ref).resolve()
        if not target.exists():
            problems.append(f"index.html посилається на {ref}, якого немає")
            continue
        if stamp:
            actual = digest(target)
            if stamp != actual:
                problems.append(
                    f"{ref}: у index.html ?v={stamp}, а вміст дає {actual}"
                    " - браузери віддаватимуть стару версію з кешу"
                )

    # Assets the page pulls from app.js rather than from index.html. nginx caches
    # .geojson for a day, so a stale hash here is the same invisible failure as in the
    # markup - and it is easier to forget, because nothing in index.html mentions them.
    js = WEB / "app.js"
    if js.exists():
        for ref, stamp in re.findall(r"['\"]([A-Za-z0-9._/-]+\.(?:json|geojson))\?v=([0-9a-f]+)['\"]",
                                     js.read_text(encoding="utf-8")):
            target = WEB / ref
            if not target.exists():
                problems.append(f"app.js посилається на {ref}, якого немає")
            elif digest(target) != stamp:
                problems.append(
                    f"{ref}: у app.js ?v={stamp}, а вміст дає {digest(target)}"
                    " - браузери віддаватимуть стару версію з кешу"
                )

    for name in ("manifest.webmanifest", "map-style.json", "oblasts.geojson",
                 "raions.geojson"):
        path = WEB / name
        if not path.exists():
            problems.append(f"немає {name}")
            continue
        try:
            json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as err:
            problems.append(f"{name}: некоректний JSON - {err}")

    # The two tags iOS actually reads for a home-screen launch. Losing either turns the
    # installed app back into a browser window, which is not obvious until someone taps
    # the icon.
    for tag in ('name="apple-mobile-web-app-capable"',
                'name="apple-mobile-web-app-status-bar-style"'):
        if tag not in html:
            problems.append(f"в index.html зник тег {tag}")

    return problems


def main() -> int:
    problems = check()
    if problems:
        print("НЕ ПРОЙДЕНО:")
        for p in problems:
            print(f"  - {p}")
        return 1
    print("сторінка ціла: посилання, хеші кешу, JSON і теги iOS на місці")
    return 0


if __name__ == "__main__":
    sys.exit(main())
