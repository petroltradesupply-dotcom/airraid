"""Build the place catalogues the settings sheet picks from.

Two files, and the split is the point.

    web/places.json       27 subjects + 136 raions, ~39 KB, ships with the page because
                          the headline needs the reader's place immediately.
    web/settlements.json  every city, town and village in Ukraine - 26,475 of them -
                          fetched only when someone starts typing in the search box.

A settlement's raion is computed here by testing its coordinates against the raion
polygons, the same trick that gives a raion its oblast. No source publishes the hierarchy
in a form worth trusting: the official KATOTTG register has no coordinates at all, and
matching 26,000 names between registers is a source of silent errors, not a shortcut.

Names repeat, badly - "Іванівка" occurs 107 times, "Вишневе" 55 - so the picker must always
show the raion beside the name. That is why every entry carries its raion index.

A raion's oblast is computed the same way, and for the same reason: Neptun's
`raions.geojson` carries only `key` and `rayon`, and our alert archive spells raions in
transliterated Latin while every live source uses Ukrainian. A point inside the polygon
answers it exactly and needs no name matching.

Doing all of it at build time is what keeps the page light: the browser gets the answers
instead of the 615 KB of raion geometry it would otherwise download and test itself.

    .venv/bin/python tools/make_places.py

Needs shapely, and network access to Neptun and Overpass. Nothing at runtime needs either.
The Overpass dump is cached in data/osm_places.json (16 MB, gitignored) so a rerun does not
hammer a free public API.
"""

from __future__ import annotations

import json
import pathlib
import sys
import urllib.request

from shapely.geometry import Point, shape
from shapely.strtree import STRtree

ROOT = pathlib.Path(__file__).resolve().parent.parent
OBLASTS = ROOT / "web" / "oblasts.geojson"
RAIONS_URL = "https://neptun.in.ua/raions.geojson"
OSM_CACHE = ROOT / "data" / "osm_places.json"
OVERPASS = "https://overpass-api.de/api/interpreter"
OVERPASS_QL = """[out:json][timeout:240];
area["ISO3166-1"="UA"][admin_level=2]->.ua;
node(area.ua)["place"~"^(city|town|village)$"]["name"];
out body qt;
"""
UA = "Mozilla/5.0 (compatible; airraid/1.0)"

# Zoom that puts one unit comfortably in frame. Raions vary from Kyiv-sized to the whole of
# Odeska's steppe, so this is a starting point the reader can change by pinching, not a
# claim about any particular shape.
ZOOM_OBLAST = 7.2
ZOOM_RAION = 8.6


def fetch(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def oblast_name(props: dict) -> str:
    """`oblasts.geojson` names the oblasts in `region` and Kyiv city in `name`."""
    return (props.get("region") or props.get("name") or props.get("key") or "").strip()


def locative(name: str, level: str) -> str:
    """The place in the locative case, for "Тривога в ...".

    Computed here, for 163 regular names, rather than in the browser: Ukrainian declension
    is not something to improvise in JavaScript, and getting it wrong shows up in the one
    line the reader looks at first. Settlements are deliberately excluded - their locative
    is irregular ("Гатне" -> "Гатному", "Крюківщина" -> "Крюківщині") and the alert they
    show belongs to their raion anyway, so the headline names the raion.

    Anything that does not match a known pattern is reported rather than guessed at.
    """
    if level == "oblast":
        if name.startswith("Автономна Республіка") or name == "Крим":
            return "Криму"
        if name in ("Севастополь", "м. Севастополь"):
            return "Севастополі"
        if name in ("Київ", "м. Київ"):
            return "Києві"
        bare = short(name)
        if bare.endswith("ька"):          # Київська -> Київській
            return f"{bare[:-1]}ій області"
        return ""
    if level == "raion":
        # One rule covers all 136: "-ький" -> "-ькому". Splitting it by the preceding
        # consonant is how "Запорізький" and "Криворізький" got missed the first time.
        if name.endswith("ький район"):
            return f"{name[:-len('ий район')]}ому районі"
        return ""
    return ""


def short(name: str) -> str:
    """"Вінницька область" -> "Вінницька". The word carries nothing: every entry is one."""
    if name.endswith(" область"):
        return name[: -len(" область")]
    if name.startswith("Автономна Республіка"):
        return "Крим"
    if name.startswith("м. "):
        return name[3:]
    return name


def build() -> tuple[list[dict], list[str]]:
    oblasts = json.loads(OBLASTS.read_text(encoding="utf-8"))
    shapes = []
    places: list[dict] = []

    for feature in oblasts["features"]:
        name = oblast_name(feature["properties"])
        geom = shape(feature["geometry"])
        shapes.append((name, geom))
        point = geom.representative_point()
        places.append({
            "level": "oblast",
            "key": (feature["properties"].get("key") or name).lower(),
            "name": short(name),
            "full": name,
            "loc": locative(name, "oblast"),
            "oblast": name,
            "lon": round(point.x, 4),
            "lat": round(point.y, 4),
            "zoom": ZOOM_OBLAST,
        })

    unmatched: list[str] = []
    for feature in fetch(RAIONS_URL)["features"]:
        props = feature["properties"]
        title = (props.get("rayon") or props.get("key") or "").strip()
        geom = shape(feature["geometry"])
        # representative_point is guaranteed to fall inside the polygon; a centroid is not,
        # and a coastal raion's centroid can land in the sea and match no oblast at all.
        point = geom.representative_point()

        parent = next((n for n, g in shapes if g.contains(point)), None)
        if parent is None:
            unmatched.append(title)
            continue

        places.append({
            "level": "raion",
            "key": (props.get("key") or title).lower(),
            "name": title,
            "full": f"{title}, {short(parent)}",
            "loc": locative(title, "raion"),
            "oblast": parent,
            "lon": round(point.x, 4),
            "lat": round(point.y, 4),
            "zoom": ZOOM_RAION,
            # Kept only to hand to build_settlements, and stripped before writing.
            "_geom": feature["geometry"],
        })

    places.sort(key=lambda p: (p["level"] != "oblast", p["name"]))
    return places, unmatched


def osm_places() -> list[dict]:
    """Every city, town and village in Ukraine, from Overpass. Cached: it is 16 MB and the
    endpoint is a free service somebody else pays for."""
    if OSM_CACHE.exists():
        return json.loads(OSM_CACHE.read_text(encoding="utf-8"))["elements"]

    request = urllib.request.Request(
        OVERPASS, data=OVERPASS_QL.encode("utf-8"), headers={"User-Agent": UA})
    with urllib.request.urlopen(request, timeout=300) as response:
        payload = response.read()
    OSM_CACHE.parent.mkdir(parents=True, exist_ok=True)
    OSM_CACHE.write_bytes(payload)
    return json.loads(payload)["elements"]


def build_settlements(raions: list[dict]) -> tuple[dict, list[str]]:
    """Settlements keyed to the raion that contains them.

    26,475 points against 136 polygons is 3.6 million containment tests done naively, so
    the polygons go into an R-tree first and each point only meets the handful whose
    bounding box it falls in.

    The output is arrays rather than objects: `["Крюківщина", 41, 30.372, 50.372]` instead
    of four keys repeated 26,475 times. That is the difference between roughly 2.4 MB and
    900 KB over the wire, for a file whose only job is to be searched.
    """
    geoms = [shape(r["_geom"]) for r in raions]
    tree = STRtree(geoms)

    rows: list[list] = []
    orphans: list[str] = []
    for element in osm_places():
        tags = element.get("tags") or {}
        name = (tags.get("name:uk") or tags.get("name") or "").strip()
        if not name:
            continue
        lon, lat = element["lon"], element["lat"]
        point = Point(lon, lat)

        idx = next((i for i in tree.query(point) if geoms[i].contains(point)), None)
        if idx is None:
            # Almost always a coastal or border settlement whose node sits just outside the
            # raion outline. Counted, not guessed at: a settlement filed under the wrong
            # raion would show the wrong alert.
            orphans.append(name)
            continue

        rows.append([name, int(idx), round(lon, 4), round(lat, 4)])

    rows.sort(key=lambda r: r[0])
    return {
        "raions": [r["key"] for r in raions],
        "settlements": rows,
    }, orphans


def main() -> None:
    places, unmatched = build()
    raions = [p for p in places if p["level"] == "raion"]

    settlements, orphans = build_settlements(raions)

    # The geometry was working data, not output.
    for p in places:
        p.pop("_geom", None)

    (ROOT / "web" / "places.json").write_text(
        json.dumps(places, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (ROOT / "web" / "settlements.json").write_text(
        json.dumps(settlements, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    oblasts = sum(1 for p in places if p["level"] == "oblast")
    print(f"областей: {oblasts} | районів: {len(raions)} | "
          f"населених пунктів: {len(settlements['settlements'])}")
    if unmatched:
        # Loud on purpose: a raion with no oblast is a raion nobody can choose, and silence
        # here would hide that from whoever regenerates the file.
        print(f"БЕЗ ОБЛАСТІ ({len(unmatched)}): {', '.join(unmatched)}")
    nodecl = [p["full"] for p in places if not p.get("loc")]
    if nodecl:
        print(f"БЕЗ ВІДМІНКА ({len(nodecl)}): {', '.join(nodecl)}")
    if orphans:
        print(f"БЕЗ РАЙОНУ: {len(orphans)} "
              f"(перші: {', '.join(orphans[:8])})")


if __name__ == "__main__":
    main()
