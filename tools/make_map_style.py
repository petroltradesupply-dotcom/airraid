"""Build the map style: OpenFreeMap's vector tiles, our own colours.

Why generate rather than hand-write: a MapLibre style is 47 layers of filters, zoom stops
and font stacks that must match the tile schema exactly. Getting that right by hand is
tedious and gets stale when the upstream schema moves. So the upstream dark style is
fetched for its STRUCTURE and every colour is replaced with ours.

The palette comes from the reference screenshot: a dark navy-slate ground with blue-grey
roads and light grey labels. The ready-made dark styles are near-black - OpenFreeMap's is
rgb(12,12,12), CARTO's dark-matter is #0e0e0e - which is not the same look at all. The
one that does match is Protomaps' dark theme, whose hosted tiles need an API key, so the
answer is to take free tiles and paint them ourselves.

    python -m tools.make_map_style > web/map-style.json
"""
from __future__ import annotations

import json
import sys
import urllib.request

UPSTREAM = "https://tiles.openfreemap.org/styles/dark"
# Their CDN rejects urllib's default User-Agent with a 403.
UA = "Mozilla/5.0 (compatible; airraid/1.0)"

# The reference palette, read off the screenshot.
GROUND = "#1b1f31"        # land
WATER = "#141726"         # sea, lakes, rivers
GLACIER = "#232842"
BUILDING = "#232741"
PARK = "#1e2436"

ROAD_MINOR = "#333852"
ROAD_MAJOR = "#454b63"
ROAD_CASING = "#20243a"
RAIL = "#2c3149"

BORDER = "#4a5068"        # dashed administrative lines
BORDER_MINOR = "#353b52"

LABEL = "#c8ccd8"
LABEL_HALO = "#11131f"
LABEL_MINOR = "#8990a6"
WATER_LABEL = "#5f6b8a"

# Layer id -> the colour its paint properties should take. Matched by prefix, longest
# first, so "highway_motorway_casing" wins over "highway_motorway".
RULES: list[tuple[str, dict[str, str]]] = [
    ("background", {"fill": GROUND}),
    ("water_name", {"text": WATER_LABEL}),
    ("water", {"fill": WATER}),
    ("waterway", {"line": WATER}),
    ("landcover_ice_shelf", {"fill": GLACIER}),
    ("landcover_glacier", {"fill": GLACIER}),
    ("landcover_wood", {"fill": PARK}),
    ("landuse_park", {"fill": PARK}),
    ("landuse_residential", {"fill": GROUND}),
    ("building", {"fill": BUILDING}),
    ("aeroway-runway-casing", {"line": ROAD_CASING}),
    ("aeroway-runway", {"line": ROAD_MAJOR}),
    ("aeroway-taxiway", {"line": ROAD_MINOR}),
    ("aeroway-area", {"fill": ROAD_MINOR}),
    ("road_area_pier", {"fill": GROUND}),
    ("road_pier", {"line": ROAD_MINOR}),
    ("highway_motorway_casing", {"line": ROAD_CASING}),
    ("highway_motorway_inner", {"line": ROAD_MAJOR}),
    ("highway_motorway_subtle", {"line": ROAD_MAJOR}),
    ("highway_major_casing", {"line": ROAD_CASING}),
    ("highway_major_inner", {"line": ROAD_MAJOR}),
    ("highway_major_subtle", {"line": ROAD_MINOR}),
    ("highway_minor", {"line": ROAD_MINOR}),
    ("highway_path", {"line": ROAD_MINOR}),
    ("railway", {"line": RAIL}),
    # The real layer ids in this schema. The reference screenshot shows dashed admin
    # lines, which is what makes oblast shapes readable on a flat dark ground.
    ("boundary_state", {"line": BORDER_MINOR}),
    ("boundary_country", {"line": BORDER}),
    ("boundary", {"line": BORDER}),
    ("place_", {"text": LABEL}),
    ("highway-name", {"text": LABEL_MINOR}),
    ("road_oneway", {"icon": LABEL_MINOR}),
    ("country_", {"text": LABEL}),
    ("continent", {"text": LABEL_MINOR}),
]


def _colour_for(layer_id: str) -> dict[str, str] | None:
    for prefix, colours in sorted(RULES, key=lambda r: -len(r[0])):
        if layer_id.startswith(prefix):
            return colours
    return None


def _repaint(layer: dict) -> dict:
    """Replace every colour in one layer, leaving filters and zoom stops untouched."""
    colours = _colour_for(layer["id"]) or {}
    paint = dict(layer.get("paint") or {})

    for key in list(paint):
        if not key.endswith("-color"):
            continue
        if key.startswith("text-halo") or key.startswith("icon-halo"):
            paint[key] = LABEL_HALO
        elif key.startswith("text") and "text" in colours:
            paint[key] = colours["text"]
        elif key.startswith("icon") and "icon" in colours:
            paint[key] = colours["icon"]
        elif key.startswith("fill") and "fill" in colours:
            paint[key] = colours["fill"]
        elif key.startswith("line") and "line" in colours:
            paint[key] = colours["line"]
        elif key.startswith("background") and "fill" in colours:
            paint[key] = colours["fill"]
        else:
            # A layer we have no rule for: fold it into the ground rather than leave an
            # upstream colour that clashes with the palette.
            paint[key] = LABEL_HALO if "halo" in key else GROUND

    # Labels need a halo to stay readable over roads on a dark ground.
    if layer["type"] == "symbol" and "text-color" in paint:
        paint.setdefault("text-halo-color", LABEL_HALO)
        paint.setdefault("text-halo-width", 1.2)

    layer["paint"] = paint
    return layer


def build() -> dict:
    request = urllib.request.Request(UPSTREAM, headers={"User-Agent": UA})
    with urllib.request.urlopen(request, timeout=30) as response:
        style = json.load(response)

    style["name"] = "Air Raid"
    style["layers"] = [_repaint(layer) for layer in style["layers"]]

    # Two upstream layers are dropped outright.
    #
    # `boundary_state` draws admin_level=4 for the whole planet - which inside Ukraine
    # duplicates the oblast outlines this project already draws from its own GeoJSON, and
    # outside Ukraine adds Bryansk, Lipetsk and every other region as pure noise. The tile
    # schema carries no country code on those lines, so there is nothing to filter on:
    # either all of them or none, and none is right.
    #
    # `place_state` is the same problem for labels. Dropping it costs the Ukrainian oblast
    # names too, which is why this project draws its own from the same GeoJSON - and gains
    # exact control over the zoom at which they hand over to city names.
    DROP = {"boundary_state", "place_state"}
    style["layers"] = [layer for layer in style["layers"] if layer["id"] not in DROP]

    # The shaded-relief raster carries its own colour and fights the flat palette.
    style["layers"] = [
        layer for layer in style["layers"]
        if layer.get("source") != "ne2_shaded"
    ]
    style["sources"].pop("ne2_shaded", None)

    for layer in style["layers"]:
        layout = layer.get("layout") or {}

        # Ukrainian labels. Upstream builds a two-line "latin\nnonlatin" label, which on
        # a Ukrainian map means every city is printed twice. Replaced wholesale rather
        # than patched, because the upstream value is an expression, not a string.
        if layer["type"] == "symbol" and "text-field" in layout:
            layout["text-field"] = [
                "coalesce",
                ["get", "name:uk"],
                ["get", "name:local"],
                ["get", "name"],
            ]

        # Dashed administrative lines, as on the reference.
        if layer["id"].startswith("boundary"):
            paint = layer.setdefault("paint", {})
            paint.setdefault("line-dasharray", [3, 2])

    return style


def main() -> None:
    json.dump(build(), sys.stdout, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
