"""Build the mask that dims everything outside Ukraine.

One polygon: the world as the outer ring, the country as a single hole. Drawn over the base
map it leaves Ukraine untouched and mutes the rest - foreign roads, water and settlement
names alike - which per-layer filters cannot do, because the tile schema carries no country
code on a settlement point.

The country outline is the union of the oblast boundaries the page already ships.

A cheaper version was tried first and does not work: the world as the outer ring and each
of the 27 oblasts as its own hole, skipping the union entirely. MapLibre clips a GeoJSON
source into tiles and triangulates each tile separately, and holes that share an edge break
that triangulation - the result was rectangular blocks across the map and Ukraine dimmed
along with everything else. Hence the real union.

    .venv/bin/python tools/make_mask.py > web/ukraine-mask.geojson

Needs shapely, which is a build-time dependency only - nothing at runtime reads it.
"""

from __future__ import annotations

import json
import pathlib
import sys

from shapely.geometry import shape, mapping, Polygon
from shapely.geometry.polygon import orient
from shapely.ops import unary_union

ROOT = pathlib.Path(__file__).resolve().parent.parent
OBLASTS = ROOT / "web" / "oblasts.geojson"

# The whole world, stopping just short of the antimeridian and of the poles where Mercator
# runs to infinity. A tighter box around Ukraine would be smaller, but its edge becomes a
# hard visible line the moment someone zooms out past it.
WORLD = Polygon([(-179.9, -85.0), (179.9, -85.0), (179.9, 85.0), (-179.9, 85.0)])

# Degrees. Enough to close the hairline gaps between neighbouring oblast boundaries - they
# come from separate sources and do not share vertices - without visibly fattening the
# country. About 100 m at this latitude.
CLOSE_GAPS = 0.001

# Degrees. The full-resolution union is 17,000 points and 255 KB over the wire, which is a
# lot to send to a phone for a shape whose job is to be slightly darker. Measured against
# the border line the page draws from the same source, this tolerance is ~15 m - under one
# pixel at every zoom this map uses, including z12 - and cuts the transfer to 48 KB.
SIMPLIFY = 0.0002


def build():
    oblasts = json.loads(OBLASTS.read_text(encoding="utf-8"))
    shapes = [shape(f["geometry"]) for f in oblasts["features"]]

    # Buffer out, merge, buffer back: the outward pass makes touching-but-not-identical
    # edges overlap so the union has no seams, the inward pass returns the true outline.
    country = unary_union([s.buffer(CLOSE_GAPS) for s in shapes]).buffer(-CLOSE_GAPS)

    # Keep only the mainland-scale parts. Odesa and Kherson contribute sandbars whose own
    # tiny rings would punch pinholes into the mask for no visible benefit.
    if country.geom_type == "MultiPolygon":
        parts = sorted(country.geoms, key=lambda g: g.area, reverse=True)
        biggest = parts[0].area
        parts = [g for g in parts if g.area > biggest * 0.001]
    else:
        parts = [country]

    # Holes of the country itself - lakes, reservoirs - are dropped: a dim spot in the
    # middle of the map reads as damage, not as water.
    mask = WORLD
    for part in parts:
        mask = mask.difference(Polygon(part.exterior))

    mask = mask.simplify(SIMPLIFY, preserve_topology=True)

    # Winding order is not cosmetic here. The vector tile format tells an outer ring from a
    # hole by the direction it is traced, and shapely guarantees nothing about that: the
    # difference above came out with the world clockwise and Ukraine counter-clockwise -
    # exactly inverted - so MapLibre read the hole as a second solid polygon and filled the
    # country along with everything else. `orient` with sign=1 gives the exterior
    # counter-clockwise and every hole clockwise, which is what the format expects.
    mask = orient(mask, sign=1.0)

    return {
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "properties": {}, "geometry": mapping(mask)}],
    }, parts


if __name__ == "__main__":
    mask, parts = build()
    print(json.dumps(mask, separators=(",", ":")))
    rings = mask["features"][0]["geometry"]["coordinates"]
    print(f"частин країни: {len(parts)} | кілець у масці: {len(rings)}", file=sys.stderr)
