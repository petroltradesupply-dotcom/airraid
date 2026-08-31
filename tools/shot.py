"""Screenshot the live page, or the page as it would look during an event.

    .venv/bin/python tools/shot.py                              # as it is now
    .venv/bin/python tools/shot.py --state reach --alert        # placeless declaration
    .venv/bin/python tools/shot.py --state named --alert        # named, siren on
    .venv/bin/python tools/shot.py --place сумська --state reach

The forged states matter more than the screenshot. A ballistic declaration happens a few
times a day and never on demand, so the only honest way to see what the panel does during
one is to hand the page a status file that says so. The forgery goes in by intercepting the
request, not by reaching into the page's variables: that way the page's own code path -
fetch, parse, paint - is the one being tested.

Replaces a browser extension for this purpose, which is why it exists: the extension is not
always connected, and a check that cannot be run is not a check.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

URL = "https://airraid.pp.ua/"
PLACES = Path(__file__).resolve().parent.parent / "web" / "places.json"

# Which ballistic field each case puts on the reader's own region.
CASES = {
    "quiet": (None, ""),
    "reach": ("reach", "☄️ Загроза застосування балістичного озброєння з північного сходу."),
    "named": ("named", "🚀 Балістична ракета на Дніпро"),
}


def forged_status(place: dict, kind: str | None, reason: str, alerted: bool) -> dict:
    """A status.json shaped exactly as the daemon writes it."""
    places = json.loads(PLACES.read_text(encoding="utf-8"))
    oblasts = [p for p in places if p["level"] == "oblast"]

    regions = {}
    for p in oblasts:
        mine = p["oblast"] == place["oblast"]
        regions[p["key"]] = {
            "name": p["name"],
            "alert": alerted and mine,
            "whole": alerted and mine,
            "units": [],
            "ballistic": kind if mine else None,
            **({"ballistic_reason": reason} if kind and mine else {}),
        }

    return {
        "written_at": datetime.now(timezone.utc).isoformat(),
        "state": "idle", "degraded": False, "geo_mode": "city",
        "kyiv_alert": False, "kyiv_oblast_alert": False,
        "alerted_count": 1 if alerted else 0,
        "reason": reason, "armed_class": None, "last_alarm_at": None,
        "ballistic_tracks": 0, "sources": {}, "regions": regions,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", choices=sorted(CASES), default="quiet")
    ap.add_argument("--place", default="м. київ", help="key from places.json")
    ap.add_argument("--alert", action="store_true", help="pretend the siren is on there")
    ap.add_argument("--out", default="/tmp/airraid-shot.png")
    ap.add_argument("--width", type=int, default=430)
    ap.add_argument("--height", type=int, default=860)
    args = ap.parse_args()

    places = json.loads(PLACES.read_text(encoding="utf-8"))
    place = next((p for p in places if p["key"] == args.place), None)
    if place is None:
        print(f"немає такого місця: {args.place}", file=sys.stderr)
        return 1

    kind, reason = CASES[args.state]

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": args.width, "height": args.height})

        if args.state != "quiet" or args.alert:
            body = json.dumps(forged_status(place, kind, reason, args.alert))
            page.route("**/live/status.json*", lambda route: route.fulfill(
                status=200, content_type="application/json", body=body))

        # The chosen place lives in localStorage, which needs an origin to exist first.
        page.goto(URL, wait_until="load")
        page.evaluate("(p) => localStorage.setItem('radar.place', JSON.stringify(p))", place)
        page.reload(wait_until="load")
        page.wait_for_timeout(7000)

        panel = page.evaluate("""() => ({
            headline: document.getElementById('headline').textContent,
            headlineColour: getComputedStyle(document.getElementById('headline')).color,
            second: document.getElementById('reason').hidden
                ? null : document.getElementById('reason').textContent,
            secondColour: getComputedStyle(document.getElementById('reason')).color,
            pulsing: getComputedStyle(document.getElementById('reason')).animationName,
            place: JSON.parse(localStorage.getItem('radar.place')).full,
        })""")

        page.screenshot(path=args.out, full_page=False)
        browser.close()

    print(json.dumps(panel, ensure_ascii=False, indent=1))
    print(args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
