# Architecture

## Shape

Three independent layers, and the independence is the point.

```
   phone / browser
        │
        ├── HTTPS ──► Caddy ──► nginx container ──► web/ (static, read-only)
        │                                            └── live/status.json ◄── alert daemon
        │
        ├── wss://neptun.in.ua/api/v1/stream    tracks, fetched by the browser directly
        └── https://tiles.openfreemap.org       map tiles, likewise
```

**The alert daemon never receives an HTTP request.** It is the part that wakes a person at
night; a web request must not be able to slow it down or take it out. It writes a small
`status.json` every few seconds and nginx serves that file. The coupling is one-directional
and the mount is read-only.

**The map works without the daemon.** Tracks and tiles are fetched by the browser from
their sources, so if the daemon stops the map keeps working and the status panel says the
verdict is unavailable — rather than showing a stale green "no threat", which is the one
lie the whole project exists to avoid.

**Nothing here is shared with the other services on the host.** Own directory, own compose
project, own container.

## The status panel

Two lines, two independent questions. The rule that keeps it honest: **the headline's
colour tracks the air-raid alert and nothing else.** The engine can be armed while Kyiv is
quiet, and a red "Тривог немає" would be nonsense.

| Engine state | Headline | Second line |
|---|---|---|
| stale file (>3 min) | `Статус застарів` | how long since the last write |
| any state, no alert | `Тривог немає`, green | hidden, or a yellow ballistic declaration |
| alert, nothing ballistic | where the alert is, red | what is over Kyiv, white |
| armed | where the alert is, red | `Загроза балістики`, yellow |
| alarm | where the alert is, red | `Балістика на Київ`, red, pulsing |

Only the second line pulses. When both lines competed for attention neither won.

An earlier version led with `Балістичної загрози немає` in green while a siren was running
over the city. It was technically true and completely wrong: it read as reassurance at the
exact moment reassurance was misplaced.

## Movement

Neptun pushes updates every few seconds. Drawn as they arrive, markers jump. Between
updates `predict()` projects each track from its last confirmed position along its bearing
at a per-class reference speed, called from `requestAnimationFrame`.

The projection is capped two ways — a horizon per class, and a maximum distance from the
last confirmed point. A ballistic track that stops updating must not keep gliding across
the country; a drone may drift for much longer before the estimate becomes a fiction.
Estimated positions are drawn at reduced opacity so a projection never passes for a
confirmation.

Rotation and pulsing live on separate elements. Combined on one, the pulse animation reset
the transform and the icons twitched.

## Icons

Six silhouettes, filled rather than outlined — at 26 px a hairline stroke disappears
against the map. Each is drawn pointing north and rotated to its heading.

Size carries severity before shape or colour does, so ballistic is drawn largest: it is the
one class that means move now, and size is the fastest thing the eye resolves.

FPV is the only radially symmetric shape, a quadcopter frame with four rotor discs. That is
honest rather than decorative: Neptun reports no heading for this class, so drawing a nose
would invent information.

## Deciding what is "over Kyiv"

Neptun gives most tracks a `region` string; roughly a fifth arrive without one. For those,
the coordinates are tested against the Kyiv city and Kyiv oblast polygons — already loaded
for the alert shading, so this costs no extra request.

The result is memoised per track and invalidated when its position or timestamp changes.
The oblast outline runs to thousands of points and must never be walked inside an
animation frame.

## Making Ukraine the subject

At this scale the base map gives Bryansk roads, Belarusian towns and Russian region names
the same weight as Kyiv oblast. Three changes fix that, and only the first is obvious.

**Foreign region boundaries and names are dropped from the style outright** —
`boundary_state` and `place_state`. There is nothing to filter on: the tile schema carries
no country code on a region line or a region point, so it is all of them or none. None is
right, because the oblast outlines inside Ukraine are already drawn from this project's own
GeoJSON, and the Ukrainian oblast *names* are now drawn from it too.

**Those names come from a separate point source**, one point per oblast on its largest
part. Labelled straight off the polygons, MapLibre places one label per part of a
MultiPolygon and half these oblasts are split by islands or river channels - Kherson came
out labelled twice. The layer sits *below* the settlement labels: collisions resolve in
layer order and the later layer wins, so with it on top "Київ" vanished at z6.0 and z6.5,
exactly where the whole country is in view and finding the capital matters most.

**Everything outside is dimmed by a mask** - the world as one polygon with Ukraine as a
single hole, drawn above the labels so foreign names dim along with the ground while
Ukraine's stay crisp. Two things about it are easy to get wrong, and both were:

- *Skipping the union.* The world with each of the 27 oblasts as its own hole looks like it
  should work and does not. MapLibre clips a GeoJSON source into tiles and triangulates
  each tile separately; holes that share an edge break that triangulation, giving
  rectangular blocks across the map and a country dimmed along with everything else.
- *Winding order.* The vector tile format tells an outer ring from a hole by the direction
  it is traced, and shapely guarantees nothing about it. The difference came out inverted -
  world clockwise, Ukraine counter-clockwise - so the hole was read as a second solid
  polygon and filled the country in.

The paint is `#090b13` at 0.8, chosen by computing the result rather than nudging it: that
puts the outside at luminance 15 against Ukraine's 32, a 2.2x separation. The page
background colour was the wrong paint - it sits so close to the ground colour that even
full opacity caps out at 1.5x. Black would reach 3.3x and take the neighbours' geography
with it, which defeats the point of keeping them visible.

## How an alert is painted

**At raion level, from the official feed only.** An alert is declared per raion far more
often than per oblast - on 2026-08-31 at 18:02 the official feed had twenty-five alerted
raions against two alerted oblasts - and filling the whole oblast because one of its raions
is up tells someone their region is dangerous while their own district is quiet. Kyiv oblast
had exactly one raion up that evening, Vyshhorodskyi, and this page showed all seven.

The alerts come from alerts.in.ua through the daemon's `status.json` and from nowhere else.
An aggregator used to fill this map and says on its own page that it is not an official
alert; the two disagree in both directions, and that same evening it claimed the whole of
Kharkivskyi raion where the official feed named only Lypetska hromada inside it. Neptun
remains the source of the *tracks* - what is flying is a different question from where an
alert is running.

**The join is a KATOTTH code, resolved daemon-side.** The page does no name matching at all,
because raion names are neither unique nor stable: "Первомайський район" exists in
Mykolaivska oblast and in Crimea, and Crimea's Курманський is the former Красногвардійський -
one code, two titles, either of which may arrive. `web/raions.geojson` carries the 136 raions
from OpenStreetMap, filtered to boundaries holding a code, which is also what keeps the
occupation administration's divisions out.

**When an alert resolves to no raion, the whole oblast lights.** A city arriving without its
hromada has no raion anywhere in the data. "Somewhere in here" serves a reader better than a
calm map, and the page can tell the two cases apart because `alert` is true while `raions` is
empty.

**Red is fill, never line.** Outlining each alerted raion in red turned a mass of adjacent
alerted districts - which is what a real attack looks like - into a red field ruled into
stripes, and the stripes carried no information: nobody needs to know where Buchanskyi ends
and Vyshhorodskyi begins when both are under alert. Boundaries are grey and identical inside
the red and outside it, which is what makes them read as geography rather than as alarm, and
weight alone says which level a boundary belongs to - an oblast line is always heavier than a
raion line.

The red is `#ff3b30` at 0.22, one value for the whole application. It was picked by rendering
six candidates on live data side by side. The former `#ff2d55` is a pink crimson and over
this ground at 0.13 it blends to `#392136`, 1.6x the ground - decoration, not alarm; raising
the density alone leaves it magenta. Two candidates measured brighter and were rejected for
reasons arithmetic alone would have missed: pure `#ff1a1a` has too little blue and goes dull
on a navy ground, and `#ff4d2e` drifts orange, which is already the legend's colour for
Ракети and КАБ sitting directly beneath it.

## Things that turned out to matter

**iOS standalone height.** With `apple-mobile-web-app-status-bar-style=black-translucent`
iOS starts the page at y=0, under the status bar, but still sizes the viewport as though
the bar were reserved — measured on a real device: screen 912, `innerHeight` 844,
`safe-area-inset-top` exactly 68. Those 68 pixels reappeared as an unpainted black band
along the bottom. With `black` the viewport starts below the status bar and reaches the
bottom edge. The body is pinned with `position: fixed; inset: 0` rather than sized in
viewport units, because `100dvh` does not reliably resolve to the full screen in standalone
mode.

**CSS source order.** Rules of equal specificity are decided by which comes last. A
media-query block placed above the base rules it overrides does nothing at all, silently.
This has bitten the legend and the status line; both now carry a comment saying so.

**Cache busting.** nginx caches assets for a week. A shipped fix stays invisible until the
query string changes, so every asset carries `?v=<sha1[:8]>` and `tools/check_web.py`
fails if a hash and its file disagree.

**MapLibre load events.** `map.on('load')` never fired with the upstream sprite; the page
listens for `style.load` and handles `styleimagemissing` instead. And `style.load` fires only
once: measured, `map.setStyle()` emits `styledata`, `sourcedata` and `idle` but *not*
`style.load`, so every layer this page adds is wiped and never restored. Recolouring the map
means `setPaintProperty` over the existing style - 57 colour properties in 1 ms, with the
camera and the alert feature-state untouched - not swapping the style out.

**A `zoom` expression cannot be nested inside a `case`.** MapLibre allows zoom only as the
input of a top-level `interpolate` or `step`; written any other way `addLayer` throws and the
layer silently never exists. That cost a raion-border layer that read as correct and simply
was not there. Split the layer, and assert `map.getLayer(id)` after adding one.

**No roads below zoom 11.** They used to flare up at one band of zooms and vanish again,
which reads as a glitch: the style turned `highway_major_subtle` on at z6 and off at z11, so
primary and secondary roads appeared across the whole country in the middle of the range.
This page is not for navigation - below z11 roads carry nothing and every threshold is a
flicker. Counted rendered features to confirm: 0 at z7 and z10.8, 204 at z11.4, 2187 at z12.

**Panning is limited to the country view plus a twelfth of a screen.** The base map is the
whole world, so one careless swipe sent the country off screen and getting back meant zooming
out, recognising Spain and panning east. The limit is a fraction of the *fitted view* rather
than a fixed margin in kilometres, and that had to be measured: with Ukraine plus 300 km as
hard limits MapLibre refuses to zoom out far enough to fit the country on a portrait phone and
cuts the north and south off - every fixed margin up to roughly 600 km failed on at least one
of five viewports, the tall portrait phone always the binding case. A limit derived from the
fitted view cannot clamp it, because the fitted view is inside the limit by construction.

At the minimum zoom the viewport *is* the limit rect, which is what defines the minimum zoom,
so the whole country is on screen there and panning is impossible - 100 % of Ukraine visible
after a full-width fling, on every viewport and for allowances of 0, 8 and 20 %. Sized from
data too: across 12,770 stored Neptun track frames, not one falls outside Ukraine's bounding
box.
