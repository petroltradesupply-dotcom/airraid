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
listens for `style.load` and handles `styleimagemissing` instead.
