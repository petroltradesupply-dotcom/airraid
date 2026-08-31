/* Air Raid.
 *
 * Two data sources, deliberately independent:
 *
 *   - live threats come straight from the aggregator's WebSocket, browser to origin. The
 *     alerting daemon is not in that path, so a page left open on a phone cannot slow
 *     down or crash the process whose job is to wake someone up at 3 a.m.
 *   - the ballistic status comes from a small JSON file that daemon writes. If the daemon
 *     is stopped the map keeps working and the status bar says so, rather than showing a
 *     reassuring "no threat" that nothing is behind.
 *
 * Everything degrades toward telling the truth: a dead socket, a stale file and a missing
 * file each produce a visibly different state.
 */
'use strict';

const NEPTUN = 'https://neptun.in.ua';
const STREAM = 'wss://neptun.in.ua/api/v1/stream';
const STATUS_URL = 'live/status.json';

const KYIV = [30.5234, 50.4501];

/* The country, corner to corner, measured off web/oblasts.geojson rather than guessed:
 * 22.14..40.23 east, 44.39..52.37 north. The map opens fitted to this on every screen, so
 * the first thing anyone sees is all of Ukraine - phone, tablet or desktop - instead of a
 * fixed zoom that frames it on one of them and crops it on the others. */
/* The colour an air-raid alert paints, and how densely.
 *
 * Both layers read these, because an oblast-wide alert and a single alerted raion must be
 * the same red - with two literals they drifted apart once already.
 *
 * Chosen by rendering six candidates on live data and looking at them side by side. What
 * the arithmetic showed, and what settled it: the old #ff2d55 is a pink crimson, and over
 * this map's #1b1f31 ground at 0.13 it blends to #392136 - a cherry burgundy only 1.6x
 * brighter than the ground, which reads as decoration rather than alarm. Raising the
 * density alone does not fix it: the same hue at 0.22 is still magenta.
 *
 * #ff3b30 at 0.22 blends to #4d2531, 2.2x the ground. Two candidates measured brighter and
 * both were rejected: pure #ff1a1a has too little blue and goes dull on a navy ground
 * (1.9x, the worst of the dense group), and #ff4d2e at 2.4x drifts orange, which is already
 * the legend's colour for Ракети and КАБ.
 */
const ALERT_RED = '#ff3b30';
const ALERT_FILL = 0.22;

/* This is THE red of the application, not just the map's. --alarm and --ballistic in
 * style.css are the same value, and the legend icon below reads this constant. One red,
 * because the difference between two of them named nothing a reader could point at, and
 * because two tokens drift - these two map fills were separate literals and had already
 * drifted apart, the oblast painting weaker than a raion inside it. */

const UKRAINE_BOUNDS = [[22.14, 44.39], [40.23, 52.37]];

/* Room for the things that float over the map, so the country is not fitted underneath
 * them. Horizontally symmetric, and that is the whole point of this comment: reserving
 * space on the right for the two round buttons pushed the country left by exactly that
 * much - about 130 device pixels against 40 on the left - and it looked off-centre because
 * it was. The buttons sit in the bottom corner, so the bottom inset already covers them;
 * paying for them across the full height bought nothing and cost the centring. */
function fitPadding() {
  const wide = window.innerWidth >= 900 && window.innerHeight >= 500;
  return wide
    ? { top: 24, right: 24, bottom: 32, left: 24 }
    : { top: 16, right: 16, bottom: 104, left: 16 };
}

/* Declared up here, far from the code that uses them, on purpose: `paintStatus` reads
 * `place`, and a `let` is not hoisted. Today nothing paints before the bottom of this file
 * runs, but a single early call added later would throw at three in the morning, which is
 * precisely when nobody is reading the console. */
const PLACE_KEY = 'radar.place';
const DEFAULT_PLACE = { level: 'oblast', key: 'м. київ', name: 'Київ',
                        full: 'м. Київ', oblast: 'м. Київ',
                        lon: KYIV[0], lat: KYIV[1], zoom: 7.2 };
let places = [];              // the catalogue, from places.json
let place = DEFAULT_PLACE;    // what the reader has chosen

/* Restored before the map is constructed, because the map opens on it. Read after, and the
 * page would centre on Kyiv and then jump. */
loadPlace();

/* How far ahead a track of each type may be projected between server updates, in minutes.
 * A ballistic track covers ground fast and its reports are sparse, so extrapolating it far
 * would draw a confident line through a position nobody reported - hence the short
 * horizon. Drones are slow and densely reported, so a longer horizon is safe. */
const FLY_HORIZON_MIN = {
  ballistic: 1.5, missile: 5, kab: 4, mig31k: 6, uav: 12, fpv: 10, recon: 12, unknown: 6,
};
/* And a hard cap in kilometres, so a stale velocity can never fling a marker across the
 * country. */
const MAX_GHOST_KM = {
  ballistic: 20, missile: 30, kab: 10, mig31k: 24, uav: 18, fpv: 10, recon: 12, unknown: 10,
};

/* Reference cruising speeds, km/h, used when the feed reports a course but no speed -
 * which, measured over 7,635 stored frames, is ALWAYS: the aggregator has never once sent
 * a velocity. Its own map moves markers anyway, so it is doing the same thing.
 *
 * These are published characteristics of the weapon types, not guesses, and each is
 * deliberately at the cautious end of its range - a marker that lags reality is a smaller
 * lie than one that runs ahead of it.
 *
 * The feed does NOT distinguish a jet Shahed from a propeller one (checked across every
 * stored frame: no "реактивний" anywhere, only "БпЛА"), so the drone figure is the
 * propeller Shahed-136. A jet one really does fly two to three times faster, and its
 * marker will lag. That is the honest failure direction. */
const REFERENCE_KMH = {
  ballistic: 1800,   // Iskander-M / KN-23 on a mid-course leg
  missile: 700,      // Kh-101, Kalibr
  kab: 700,          // glide bomb after release
  mig31k: 1800,      // MiG-31K transiting
  uav: 180,          // Shahed-136, propeller
  fpv: 120,
  recon: 120,
  unknown: 150,
};

/* Every drawing points NORTH. That is the whole convention: a marker is then simply
 * rotated by the threat's own heading, and the fleet on screen shows where things are
 * actually going. Fixed-orientation icons had every Shahed apparently flying back into
 * Russia, which is worse than no arrow at all. */
const ICONS = {
  /* Ballistic: vertical, ogive nose, two base fins, exhaust flame. */
  ballistic: (s, c) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="${c}">
      <path d="M12 1.2c1.7 2.4 2.5 4.6 2.5 6.6v8.1h-5V7.8c0-2 .8-4.2 2.5-6.6z"/>
      <path d="M9.5 12.1 6.6 15.6v2.2l2.9-1.6zM14.5 12.1l2.9 3.5v2.2l-2.9-1.6z"/>
      <path d="M10.2 15.9h3.6v1.9h-3.6z"/>
      <path d="M12 18.2c1.1 1.3 1.7 2.5 1.7 3.4 0 .8-.6 1.3-1.7 1.3s-1.7-.5-1.7-1.3c0-.9.6-2.1 1.7-3.4z" opacity=".75"/>
    </svg>`,

  /* Cruise: body, wing above and below, tail fins. Drawn nose-right, then turned to
     north like every other icon here - see ICONS' note on orientation. */
  missile: (s, c) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="${c}">
      <g transform="rotate(-90 12 12)">
      <path d="M3.6 10.1h14.1c2.1 0 3.8 1 5.1 1.9-1.3.9-3 1.9-5.1 1.9H3.6z"/>
      <path d="M10.4 10.1 9.6 4.3h2.3l1.7 5.8zM10.4 13.9l-.8 5.8h2.3l1.7-5.8z"/>
      <path d="M3.6 10.1 1 6.9h1.9l1.9 3.2zM3.6 13.9 1 17.1h1.9l1.9-3.2z" opacity=".85"/>
      </g>
    </svg>`,

  /* Glide bomb: a fat, blunt body on a descending diagonal with a cruciform tail.
     Drawn horizontally and rotated, which keeps the proportions honest. The weight of
     the body is what separates it from the slim cruise missile at small size. */
  kab: (s, c) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="${c}">
      <g transform="rotate(-90 12 12)">
        <path d="M4.8 9.2h9.6c2.7 0 4.9 1.3 5.8 2.8-.9 1.5-3.1 2.8-5.8 2.8H4.8z"/>
        <path d="M4.8 9.2 1.9 4.9h2.4l2 4.3zM4.8 14.8 1.9 19.1h2.4l2-4.3z"/>
        <path d="M11.2 9.2 9.7 5.4h2l1.9 3.8zM11.2 14.8 9.7 18.6h2l1.9-3.8z" opacity=".85"/>
      </g>
    </svg>`,

  /* Fighter: swept wings. The artwork climbs to the upper right, so it is turned back
     to north here rather than being redrawn. */
  aviation: (s, c) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="${c}">
      <g transform="rotate(-45 12 12)">
      <path d="M21.9 2.1c.6 1.9.2 3.9-1.3 5.9l-4.2 5.5-1.9 6.1-2 2-.6-6.3-3.7 3.6.2 2.5-1.6 1.6-1.2-2.4-2.4-1.2 1.6-1.6 2.5.2 3.6-3.7-6.3-.6 2-2 6.1-1.9 5.5-4.2c2-1.5 4-1.9 5.9-1.3z"/>
      </g>
    </svg>`,

  /* Shahed: a plain delta arrowhead. No nose, no tail surfaces - the blunt triangle is
     precisely what tells it apart from the fighter, which has a long nose and separate
     wing and tail. */
  uav: (s, c) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="${c}">
      <path d="M12 1.8 21.4 21.4 12 16.9 2.6 21.4z"/>
    </svg>`,

  /* FPV quadcopter from above: an X frame with a rotor disc on each arm. Deliberately
     the only radially symmetric shape in the set - it has no nose, which is honest,
     because Neptun reports no heading for this class. Discs are filled rather than
     outlined: a 1px ring disappears entirely at legend size. */
  fpv: (s, c) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="${c}">
      <path d="M6.9 5.5 5.5 6.9l11.6 11.6 1.4-1.4zM17.1 5.5l1.4 1.4L6.9 18.5 5.5 17.1z"/>
      <circle cx="5.8" cy="5.8" r="3" opacity=".6"/>
      <circle cx="18.2" cy="5.8" r="3" opacity=".6"/>
      <circle cx="5.8" cy="18.2" r="3" opacity=".6"/>
      <circle cx="18.2" cy="18.2" r="3" opacity=".6"/>
      <circle cx="12" cy="12" r="2.6"/>
    </svg>`,

  /* Recon drone from above: slim fuselage, very long straight wings, tail plane. The
     cross it forms is unlike anything else in the set, and the teal carries the rest. */
  recon: (s, c) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="${c}">
      <g transform="rotate(-90 12 12)">
      <path d="M2.4 10.6h14.2c2.4 0 4.4.6 5.4 1.4-1 .8-3 1.4-5.4 1.4H2.4z"/>
      <path d="M9.6 1.8h2.2v20.4H9.6z"/>
      <path d="M2.8 6.9h1.8v10.2H2.8z" opacity=".9"/>
      </g>
    </svg>`,
};

/* Which drawing each threat type uses. `unknown` borrows the drone shape rather than
 * inventing a silhouette nobody can learn. */
const ICON_FOR = {
  ballistic: 'ballistic', missile: 'missile', kab: 'kab',
  mig31k: 'aviation', uav: 'uav', fpv: 'fpv', recon: 'recon', unknown: 'uav',
};

const TYPES = [
  { key: 'ballistic', label: 'Балістика', colour: ALERT_RED },
  { key: 'missile',   label: 'Ракети',    colour: '#ff8a3d' },
  { key: 'kab',       label: 'КАБ',       colour: '#e0603a' },
  { key: 'mig31k',    label: 'Авіація',   colour: '#a06cff' },
  { key: 'uav',       label: 'БпЛА',      colour: '#9aa6c4' },
  /* FPV used to share the Shahed's row and the Shahed's colour. It should not: these
   * fly a few kilometres near the line of contact and can never reach Kyiv, so being
   * able to switch them off on their own is the point of splitting them out. Muted gold
   * keeps them legible without competing with anything that means take cover. */
  { key: 'fpv',       label: 'FPV',       colour: '#a89050' },
  /* Teal, not blue: at the previous colour a recon drone and a Shahed were a shade
   * apart on a dark map, and those two mean very different things. */
  { key: 'recon',     label: 'Розвідка',  colour: '#28c8c0' },
];
const COLOUR_FOR = Object.fromEntries(TYPES.map(t => [t.key, t.colour]));
COLOUR_FOR.unknown = '#6b7a99';

/* Ballistic is drawn larger on purpose. It is the one class that means move now, and
 * size is the fastest thing the eye resolves - faster than shape, faster than colour. */
const ICON_SIZE = { ballistic: 30, missile: 26, kab: 26, mig31k: 26, recon: 24, fpv: 20 };
const TYPE_LABEL = Object.fromEntries(TYPES.map(t => [t.key, t.label]));
const STALE_AFTER_S = 900;

/* ---------------------------------------------------------------- dead reckoning */

/** Project a point `km` along `bearing` on a sphere. */
function destination(lat, lon, bearingDeg, km) {
  if (km <= 0) return [lat, lon];
  const R = 6371;
  const d = km / R;
  const b = bearingDeg * Math.PI / 180;
  const φ1 = lat * Math.PI / 180;
  const λ1 = lon * Math.PI / 180;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(b));
  const λ2 = λ1 + Math.atan2(
    Math.sin(b) * Math.sin(d) * Math.cos(φ1),
    Math.cos(d) - Math.sin(φ1) * Math.sin(φ2),
  );
  return [φ2 * 180 / Math.PI, ((λ2 * 180 / Math.PI + 540) % 360) - 180];
}

/** Where a track probably is right now.
 *
 * Updates arrive every few seconds; without this markers teleport. With it they move,
 * which is also how a heading becomes legible at a glance. Only tracks that reported a
 * velocity and an anchor time are projected - a track without them is drawn where it was
 * last seen, because inventing motion for it would be inventing information. */
function predict(threat, nowMs) {
  const still = { lat: threat.lat, lon: threat.lon, moving: false, estimated: false };
  if (threat.status !== 'active') return still;

  /* A course is required and never invented. Speed may be estimated from the type;
   * direction may not, because a marker pointing somewhere nobody reported is
   * indistinguishable on screen from one that was measured. */
  const bearing = headingOf(threat);
  if (bearing === null) return still;

  const anchorAt = threat.confirmedAt || threat.updatedAt;
  if (!anchorAt) return still;
  const ageMin = (nowMs - Date.parse(anchorAt)) / 60000;
  if (!(ageMin > 0)) return still;

  const measured = threat.velocity && Number.isFinite(threat.velocity.speedKmh);
  const kmh = measured ? threat.velocity.speedKmh : (REFERENCE_KMH[threat.type] ?? 150);

  const horizon = FLY_HORIZON_MIN[threat.type] ?? 6;
  const cap = MAX_GHOST_KM[threat.type] ?? 8;
  const km = Math.min(cap, kmh * (Math.min(ageMin, horizon) / 60));
  const [lat, lon] = destination(threat.lat, threat.lon, bearing, km);
  return { lat, lon, moving: ageMin <= horizon && km > 0.05, estimated: !measured };
}

/* ------------------------------------------------------------------------- map */

const map = new maplibregl.Map({
  container: 'map',
  /* Versioned like every other asset. These three are fetched from here rather than from
   * index.html, and nginx caches .geojson for a day - so a regenerated boundary or mask
   * would sit invisible behind the cache. tools/check_web.py verifies these hashes too,
   * which is the only reason they can be trusted to be right. */
  style: 'map-style.json?v=daf69b5f',
  /* Fitted to the country, not centred on the reader's place. The place drives the status
   * line and the "to me" button; the opening view is meant to answer "what is happening"
   * before "what is happening to me". */
  bounds: UKRAINE_BOUNDS,
  fitBoundsOptions: { padding: fitPadding(), animate: false },
  /* 3, not 4. Fitting the country on a phone needs zoom 3.61: these are 512-pixel vector
   * tiles, so a 390-pixel viewport shows only 17 degrees at zoom 4 and Ukraine is 18.1 wide.
   * At minZoom 4 the fit was silently clamped and the west stayed off-screen. */
  minZoom: 3,
  maxZoom: 12,
  attributionControl: false,
  /* Pitch and rotation add nothing to reading positions and make a phone map easy to
   * knock askew by accident. */
  pitchWithRotate: false,
  dragRotate: false,
  touchZoomRotate: true,
});
map.touchZoomRotate.disableRotation();

let mapReady = false;

/* 'style.load', not 'load'. The style keeps the upstream sprite URL, and a sprite image
 * that fails to resolve can leave 'load' un-fired forever - the map draws, tiles arrive,
 * and nothing that waits on 'load' ever runs. 'style.load' fires as soon as the style is
 * usable, which is exactly when layers may be added. */
/* Refitted here, not only in the constructor. `fitBounds` measures the container, and at
 * construction time the grid has not laid it out yet - on a phone that produced a view
 * about two degrees too tight, with Zakarpattia and Volyn off the left edge. Measuring
 * again once the style is up gets the real size.
 *
 * `fitUntilTouched` stops it fighting the reader: once they pan, zoom or pick a place, the
 * view is theirs and a later resize must not yank it back to the whole country. */
let fitUntilTouched = true;
for (const ev of ['dragstart', 'zoomstart', 'rotatestart']) {
  map.on(ev, () => { fitUntilTouched = false; });
}

/* How far past the country view a reader may pan, as a fraction of the fitted view on each
 * side. A twelfth of a screen: enough to nudge Odesa or Kharkiv off the edge for a closer
 * look, and no more.
 *
 * It is deliberately small, and the reason is what this number does NOT control. At the
 * minimum zoom the viewport is exactly the limit rect - that is what defines the minimum
 * zoom - so the whole country is on screen and panning is impossible there, measured at
 * 100 % of Ukraine visible for allowances of 0, 8 and 20 %. What the number does control is
 * how much empty ground surrounds the country at that most-zoomed-out view: at 20 % the
 * minimum zoom was 3.47 on a 430-point phone against a 3.95 fit, so the country sat small in
 * a field of neighbours. At 8 % it is 3.74 and the country nearly fills the screen.
 *
 * A limit is needed at all because the base map is the whole world. One careless swipe on a
 * phone sent the country off-screen, and getting back meant zooming out, recognising Spain,
 * and panning east - which is not something to do while deciding whether to go to a shelter.
 *
 * The bound is 20 % of the VIEW, not a fixed number of kilometres, and that is the part that
 * had to be measured rather than guessed. A fixed margin clamps the zoom: with Ukraine plus
 * 300 km as hard limits, MapLibre refuses to zoom out far enough to fit the country on a
 * portrait phone and cuts the north and south off. Measured on five viewports, every fixed
 * margin up to ~600 km did this on at least one of them, and the tall portrait phone is
 * always the binding case. Deriving the limit from the fitted view cannot clamp it, because
 * the fitted view is inside the limit by construction. */
const PAN_ALLOWANCE = 0.08;

/* The pan limit, recomputed for the current viewport. Never moves the camera: the fit runs
 * with the limit cleared and the previous camera is put back in the same tick, so nothing
 * renders in between and the reader sees no jump. */
function refreshPanLimits() {
  const camera = { center: map.getCenter(), zoom: map.getZoom() };
  map.setMaxBounds(null);
  map.fitBounds(UKRAINE_BOUNDS, { padding: fitPadding(), animate: false });
  const view = map.getBounds();
  map.jumpTo(camera);

  const dx = (view.getEast() - view.getWest()) * PAN_ALLOWANCE;
  const dy = (view.getNorth() - view.getSouth()) * PAN_ALLOWANCE;
  map.setMaxBounds([
    [view.getWest() - dx, view.getSouth() - dy],
    [view.getEast() + dx, view.getNorth() + dy],
  ]);
}

function fitUkraine() {
  map.resize();
  /* Cleared first, or the limit set on the previous pass clamps this fit - which on a
   * portrait phone means the country no longer fits on screen. */
  map.setMaxBounds(null);
  map.fitBounds(UKRAINE_BOUNDS, { padding: fitPadding(), animate: false });
  const view = map.getBounds();
  const dx = (view.getEast() - view.getWest()) * PAN_ALLOWANCE;
  const dy = (view.getNorth() - view.getSouth()) * PAN_ALLOWANCE;
  map.setMaxBounds([
    [view.getWest() - dx, view.getSouth() - dy],
    [view.getEast() + dx, view.getNorth() + dy],
  ]);
}

/* Rotating the phone changes what "the country view" is, so the limit has to change with it
 * - including for a reader who has already zoomed in, whose camera must survive untouched.
 * Miss this and a portrait limit applied to a landscape screen clamps the zoom. */
addEventListener('resize', () => {
  if (fitUntilTouched) fitUkraine();
  else refreshPanLimits();
});

map.on('style.load', () => {
  mapReady = true;
  fitUkraine();
  addOblastLayer().then(addRaionLayer);
  render();
});

/* The upstream sprite does not carry every icon the layer definitions reference. Serving
 * a transparent pixel keeps the console clean and stops MapLibre retrying. */
map.on('styleimagemissing', (e) => {
  if (map.hasImage(e.id)) return;
  map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
});

/** Oblast outlines, plus a fill that lights up where an air-raid alert is running.
 *
 * This is the layer that makes the map answer "is my region under alert" without reading
 * anything. */
async function addOblastLayer() {
  try {
    const geo = await fetch('oblasts.geojson?v=211a6dae').then(r => r.json());
    map.addSource('oblasts', { type: 'geojson', data: geo });
    map.addSource('oblast-labels', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    map.addLayer({
      id: 'oblast-alert-fill',
      type: 'fill',
      source: 'oblasts',
      paint: {
        'fill-color': ['case', ['boolean', ['feature-state', 'alert'], false], ALERT_RED, '#000000'],
        /* The same density a raion gets. Red has to mean one thing: with the oblast lower an
         * oblast-wide alert looked milder than a single alerted raion next to it, which is
         * backwards. */
        'fill-opacity': ['case', ['boolean', ['feature-state', 'alert'], false], ALERT_FILL, 0],
      },
    });
    map.addLayer({
      id: 'oblast-outline',
      type: 'line',
      source: 'oblasts',
      paint: {
        /* Never red, at any alert state, and always heavier than a raion line. Those two
         * rules are the whole hierarchy: weight says which level a boundary belongs to,
         * colour says nothing at all. When an alerted oblast got a red outline it was
         * indistinguishable from the alerted raions inside it, and the map lost the one
         * structure a reader navigates by.
         *
         * Weight grows with zoom because its job changes. With the whole country in frame
         * it only has to separate neighbours; close in it has to stay legible across a red
         * fill and above the raion lines it outranks. */
        'line-color': '#5a638a',
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.8, 6, 1.6, 8, 2.0],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0.5, 6, 0.75],
      },
    });
    /* Our own oblast names, replacing upstream's `place_state`.
     *
     * That layer was dropped from the style because it labels Bryansk and Lipetsk from the
     * same source as Kyivska, and the tile schema carries no country code on region
     * points - so it was all of them or none. Drawing them here from the boundaries we
     * already load costs nothing extra and buys the handover: oblast names while the whole
     * country is in view, gone once the map is close enough for city names to take over.
     *
     * Labelled from a separate point source rather than the polygons themselves. On a
     * polygon source MapLibre places one label per part of a MultiPolygon, and half these
     * oblasts are split by islands or river channels - Kherson came out labelled twice.
     * One point per oblast, on its largest part, is the only way to get one label. */
    /* Below the settlement labels, and that placement is load-bearing.
     *
     * MapLibre resolves label collisions in layer order and the LATER layer wins. With this
     * layer on top, measured across zooms, "Київ" vanished at z6.0 and z6.5 - the oblast
     * name took its spot at exactly the zoom where the whole country is in view and finding
     * the capital matters most. Placed underneath, the city always wins and oblast names
     * simply thin out where it is crowded, which is the right trade. */
    /* Everything outside Ukraine, muted.
     *
     * The point is not decoration: at this scale the map carries Bryansk roads, Belarusian
     * towns and Russian region names with equal weight to Kyiv oblast, and none of that is
     * what the page is for. Per-layer filters cannot express it - the tile schema has no
     * country code on a settlement point - so the honest tool is a mask.
     *
     * Above the base map and below the labels of OUR OWN layers, so foreign names dim with
     * the ground while oblast names, targets and the alert shading stay crisp. */
    const mask = await fetch('ukraine-mask.geojson?v=cb8639e1').then(r => r.json());
    map.addSource('outside', { type: 'geojson', data: mask });
    map.addLayer({
      id: 'outside-dim',
      type: 'fill',
      source: 'outside',
      paint: {
        /* Darker than the page background, and deliberately not black.
         *
         * Computed rather than eyeballed. Against Ukraine's ground (#1b1f31, luminance
         * 31.4) this pair puts the outside at 15.2 - a 2.07x difference, twice what the
         * first attempt at 0.55 over the background colour managed. The background colour
         * was the wrong paint: it sits so close to the ground that even full opacity caps
         * out at 1.5x.
         *
         * Black at 0.7 would give 3.3x, and that is too much: the neighbours lose their
         * geography entirely, and the point of keeping them visible is knowing where
         * Ukraine sits among them. */
        'fill-color': '#090b13',
        'fill-opacity': 0.8,
      },
    });

    /* Specifically the first SETTLEMENT label layer, not the first symbol layer - that one
     * is water_name, and slipping underneath it would let a river name outrank an oblast. */
    const firstPlaceLayer = map.getStyle().layers.find(l => l.id.startsWith('place_'))?.id;
    map.addLayer({
      id: 'oblast-label',
      type: 'symbol',
      source: 'oblast-labels',
      maxzoom: 8,
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 4, 9, 7, 12],
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.08,
        'text-max-width': 8,
        'text-padding': 4,
      },
      paint: {
        'text-color': ['case', ['boolean', ['feature-state', 'alert'], false],
                       '#e8879b', '#8990a6'],
        'text-halo-color': '#11131f',
        'text-halo-width': 1.2,
      },
    }, firstPlaceLayer);

    /* MapLibre feature-state needs a stable id per feature; the file has none, so index
     * by position and keep a name -> index map for the alert updates. */
    geo.features.forEach((f, i) => {
      f.id = i;
      const name = normaliseOblast(f.properties.region || f.properties.key || '');
      oblastIndex.set(name, i);

      /* "ВІННИЦЬКА ОБЛАСТЬ" is twice the width it needs to be at this size, and the word
       * "область" carries nothing - every shape here is one. Kyiv city gets no label at
       * all: the map already names it, from the place layer, and two labels on the same
       * dot is worse than one. */
      const region = f.properties.region || '';
      if (region.endsWith(' область')) {
        f.properties.label = region.slice(0, -' область'.length);
      } else if (region.startsWith('Автономна Республіка')) {
        f.properties.label = 'Крим';
      } else if (region) {
        f.properties.label = region;
      }
      /* Every oblast's geometry, keyed by its normalised name. Roughly a fifth of
       * Neptun's tracks arrive with no `region` at all, and for those the geometry is the
       * only way to tell whether the thing is over the reader's place. Kyiv city is its
       * own shape here, which is right - it is its own subject. */
      const shapes = oblastShapes.get(name) || [];
      shapes.push(f.geometry);
      oblastShapes.set(name, shapes);
    });
    map.getSource('oblasts').setData(geo);
    map.getSource('oblast-labels').setData({
      type: 'FeatureCollection',
      features: geo.features
        .filter(f => f.properties.label)
        .map(f => ({
          type: 'Feature',
          id: f.id,
          properties: { label: f.properties.label },
          geometry: { type: 'Point', coordinates: labelPoint(f.geometry) },
        })),
    });
    applyAlerts();
  } catch (err) {
    console.warn('oblast layer failed', err);
  }
}

/** Raion outlines and fills - the level an air-raid alert is actually declared at.
 *
 * An alert is declared per raion far more often than per oblast: on 2026-08-31 at 18:02
 * twenty-six raions were alerted and only three oblasts. Painting the whole oblast because
 * one of its raions is up overstates in the direction that matters - it tells someone their
 * region is dangerous while their own district is quiet. Kyiv oblast had exactly one raion
 * up that evening, Vyshhorodskyi, and the page showed all seven.
 *
 * Keyed by Neptun's own raion key, which is the same string in their alert feed and in
 * their geometry - the one join in this page that needs no name matching at all.
 *
 * Drawn UNDER the oblast outline so an oblast border still reads as a border where a red
 * patch touches it. */
async function addRaionLayer() {
  try {
    const geo = await fetch('raions.geojson?v=ac1bd555').then(r => r.json());
    /* Same as the oblasts: feature-state needs a stable id and the file carries none. */
    geo.features.forEach((f, i) => { f.id = i; raionIndex.set(f.properties.key, i); });
    map.addSource('raions', { type: 'geojson', data: geo });

    /* If the oblast layer failed, its outline is not there to insert under; adding on top
     * is still far better than not painting alerts at all. */
    const under = map.getLayer('oblast-outline') ? 'oblast-outline' : undefined;

    map.addLayer({
      id: 'raion-alert-fill',
      type: 'fill',
      source: 'raions',
      paint: {
        'fill-color': ALERT_RED,
        'fill-opacity': ['case', ['boolean', ['feature-state', 'alert'], false], ALERT_FILL, 0],
      },
    }, under);

    /* Quiet raion borders, and they appear only once the map is close enough that they
     * explain the shape of a red patch. At country zoom 136 extra lines would be noise on a
     * map whose whole job is to be read in one glance.
     *
     * A SEPARATE layer from the alerted outline below, not one layer with a conditional
     * opacity, because MapLibre rejects a `zoom` expression nested inside a `case`: zoom may
     * only be the input of a top-level interpolate or step. Written the other way it throws
     * at addLayer and the layer silently never exists - which is exactly what happened. */
    map.addLayer({
      id: 'raion-line',
      type: 'line',
      source: 'raions',
      minzoom: 5,
      paint: {
        /* Lighter than the alert fill on purpose. At #2f3550 these lines were darker than
         * the red they cross and vanished inside it, so the districts a reader was trying
         * to tell apart were exactly the ones with no visible boundary. */
        'line-color': '#4d5678',
        'line-width': 0.6,
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0, 6.5, 0.45, 9, 0.55],
      },
    }, under);

    /* There is deliberately NO red outline on an alerted raion.
     *
     * It was tried and it was wrong. Outlining each alerted raion turns a mass of adjacent
     * alerted districts - which is what a real attack looks like - into a red field ruled
     * into stripes, and the stripes carry no information: nobody needs to know where
     * Buchanskyi ends and Vyshhorodskyi begins when both are under alert. Red means area,
     * never line. Boundaries are the grey layer above, identical inside the red and outside
     * it, which is what makes them read as geography rather than as alarm. */

    applyAlerts();
  } catch (err) {
    console.warn('raion layer failed', err);
  }
}

/* Where to put an oblast's single label: the centre of its largest ring.
 *
 * The centre of the bounding box, not the centroid - for a shape like Odesa oblast the
 * true centroid can land in the sea, and a name floating offshore reads as a mistake. The
 * largest ring is picked by bounding-box area, which is enough to tell a mainland from an
 * island and costs one pass. */
function labelPoint(geom) {
  const rings = geom.type === 'MultiPolygon'
    ? geom.coordinates.map(poly => poly[0])
    : [geom.coordinates[0]];

  let best = null, bestArea = -1;
  for (const ring of rings) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const area = (maxX - minX) * (maxY - minY);
    if (area > bestArea) { bestArea = area; best = [(minX + maxX) / 2, (minY + maxY) / 2]; }
  }
  return best;
}

const oblastIndex = new Map();
const raionIndex = new Map();   // Neptun's raion key -> feature id
const oblastShapes = new Map();  // normalised oblast name -> [geometry], filled on load

/* Ray casting on the outer ring. Holes are ignored: an oblast's enclaves are far smaller
 * than the error already present in a track's reported position, so testing them would be
 * false precision. */
function inRing(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat)
        && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inGeometry(geom, lon, lat) {
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
  return polys.some(poly => inRing(poly[0], lon, lat));
}

/* Which oblast contains this point, if any. Used by auto-detect: these polygons are
 * already loaded for the alert shading, so it costs no request and no extra data. */
function oblastAt(lonLat) {
  for (const [name, geoms] of oblastShapes) {
    if (geoms.some(g => inGeometry(g, lonLat[0], lonLat[1]))) return name;
  }
  return null;
}

/* Geometry fallback for a track that arrived with no reported region. Memoised per track:
 * the polygons run to thousands of points and this must never happen inside an animation
 * frame. */
const geoCache = new Map();
function overGeometry(threat, oblastName) {
  if (!Number.isFinite(threat.lat) || !Number.isFinite(threat.lon)) return false;
  const want = normaliseOblast(oblastName || '');
  const stamp = `${threat.updatedAt || ''}|${threat.lat}|${threat.lon}|${want}`;
  const hit = geoCache.get(threat.id);
  if (hit && hit.stamp === stamp) return hit.value;

  const value = (oblastShapes.get(want) || [])
    .some(g => inGeometry(g, threat.lon, threat.lat));

  /* Tracks come and go all night; without this the cache is a slow leak. */
  if (geoCache.size > 500) geoCache.clear();
  geoCache.set(threat.id, { stamp, value });
  return value;
}

/* Oblast names arrive spelled three ways - "м. Київ", "Київська область", "Автономна
 * Республіка Крим" - from three sources with three conventions. Every comparison goes
 * through here, because comparing them by hand is how a region silently stops matching. */
function normaliseOblast(name) {
  return (name || '').toLowerCase()
    .replace(/^м\.\s*/, '')
    .replace(/^автономна республіка\s*/, '')
    .replace(/\s+область$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* --------------------------------------------------------------------- state */

const threats = new Map();       // id -> threat
const markers = new Map();       // id -> { marker, el, type }
let hidden = new Set(JSON.parse(localStorage.getItem('radar.hidden') || '[]'));
let lastFrameAt = 0;
let lastDataAt = 0;
let socketState = 'connecting';

/* ------------------------------------------------------------------- rendering */

/** The direction a track is actually going, or null if nobody reported one.
 *
 * `heading` is the aggregator's own field and is null when unknown; `velocity.bearingDeg`
 * is the course it derived from consecutive positions. Either is real. What must NOT
 * happen is inventing one: an icon pointing somewhere nobody claimed is a lie the reader
 * has no way to see through. */
function headingOf(threat) {
  if (Number.isFinite(threat.heading)) return threat.heading;
  const b = threat.velocity && threat.velocity.bearingDeg;
  return Number.isFinite(b) ? b : null;
}

function markerElement(threat) {
  const el = document.createElement('div');
  el.className = `threat threat--${threat.type}`;
  const draw = ICONS[ICON_FOR[threat.type] || 'uav'];
  /* Rotation lives on an inner element: the outer one carries the ballistic pulse, and
     two animations writing the same transform would fight. */
  const rot = document.createElement('div');
  rot.className = 'threat__rot';
  rot.innerHTML = draw(ICON_SIZE[threat.type] || 22, COLOUR_FOR[threat.type] || '#6b7a99');
  el.appendChild(rot);
  applyHeading(el, rot, threat);
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    showPopup(threat);
  });
  return el;
}

/* The centroid of Ukraine's own area, computed from web/oblasts.geojson rather than looked
 * up: 49.0153 N, 31.3914 E. It lands inside the country and within a couple of kilometres
 * of the official geographic centre near Dobrovelychkivka, which is a useful check that the
 * number is not nonsense. */
const UKRAINE_CENTRE = [31.3914, 49.0153];

/* Classes that never report a course, and for which "no course" still has a direction.
 *
 * A guided bomb is released by an aircraft on the far side of the border and glides INWARD;
 * it cannot fly out of the country. Neptun reports no heading for the class at all - checked
 * live, all six KAB tracks carried heading: null - and with no rotation the glyph kept the
 * orientation it was drawn in, which is north. From Kharkiv that reads as a bomb flying into
 * Russia, which is not a small cosmetic complaint: it is the map stating the opposite of
 * what is happening.
 *
 * So the glyph is turned toward the centre of the country. That is a statement about the
 * class, not a measurement of the track, and it stays out of `predict()` - the marker still
 * does not MOVE, because inventing motion would put the icon somewhere nobody reported. The
 * dimming that marks an unmeasured course stays too, and the popup still prints no course
 * line. */
const INWARD_TYPES = new Set(['kab']);

/** Initial bearing from one point to another, degrees clockwise from north. */
function bearingTo(fromLon, fromLat, toLon, toLat) {
  const φ1 = fromLat * Math.PI / 180, φ2 = toLat * Math.PI / 180;
  const Δλ = (toLon - fromLon) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** Point the marker along the track's course.
 *
 * Icons are drawn pointing north, so the rotation IS the compass heading. A track with no
 * reported course keeps the drawing upright and is marked, so "north" is never mistaken
 * for a measurement - unless its class only ever flies one way, see INWARD_TYPES. */
function applyHeading(el, rot, threat) {
  const heading = headingOf(threat);
  let shown = heading;
  if (shown === null && INWARD_TYPES.has(threat.type)
      && Number.isFinite(threat.lon) && Number.isFinite(threat.lat)) {
    shown = bearingTo(threat.lon, threat.lat, UKRAINE_CENTRE[0], UKRAINE_CENTRE[1]);
  }
  rot.style.transform = shown === null ? '' : `rotate(${shown}deg)`;
  /* Dimming is keyed on the REPORTED course - "nobody measured this" stays true even when
   * the class tells us which way it must be going. The upright pin is keyed on the DRAWN
   * one, so an inward heading is not overridden by it. */
  el.classList.toggle('threat--unmeasured', heading === null);
  el.classList.toggle('threat--upright', shown === null);
}

/* "22:16" makes the reader do arithmetic, at night, to answer the only question that
 * matters about a track: how old is this. So the popup says the answer instead. */
function pluralUk(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function agoText(date) {
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 45) return 'щойно';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${pluralUk(minutes, 'хвилину', 'хвилини', 'хвилин')} тому`;
  const hours = Math.round(minutes / 60);
  return `${hours} ${pluralUk(hours, 'годину', 'години', 'годин')} тому`;
}

/* Exactly one popup at a time, and it closes itself.
 *
 * Both rules exist because of how this is actually used: a phone, at night, tapping
 * tracks near Kyiv one after another. Without the first rule every tap left its popup
 * behind and the map disappeared under a stack of them. Without the second, a popup
 * opened by accident stays until it is deliberately dismissed - and on a phone the
 * dismiss target is the map itself, which is what you are trying to look at. */
/* Twelve seconds: about 26 words across four fields, scanned rather than read, at the
 * ~2 words/second that structured text actually goes at - plus a second to find the popup
 * after the tap. Rounded up on purpose, because the two mistakes do not cost the same. Too
 * long and the next tap dismisses it anyway; too short and you are hunting a 26-pixel
 * marker again, at night, one-handed. */
const POPUP_LIFETIME_MS = 12000;
let activePopup = null;

function closePopup() {
  if (activePopup) activePopup.remove();     // fires 'close', which clears the timers
}

function showPopup(threat) {
  closePopup();

  const when = threat.updatedAt ? new Date(threat.updatedAt) : null;
  const parts = [threat.locality, threat.district, threat.region].filter(Boolean);
  /* Anchored where the MARKER is, not where the report was.
   *
   * `predict()` projects a moving track forward from the moment it was last confirmed, so
   * the marker is ahead of `threat.lon/lat` by however far it has flown since - fifteen
   * kilometres for a drone reported five minutes ago at 180 km/h. Anchoring the popup to
   * the raw report put it that far from the icon that was tapped, and because both are
   * geographic the gap grew in pixels as the map zoomed in. */
  const at = predict(threat, Date.now());
  const popup = new maplibregl.Popup({ offset: 14, closeButton: false })
    .setLngLat([at.lon, at.lat])
    .setHTML(
      `<div class="popup__type">${TYPE_LABEL[threat.type] || threat.type}</div>` +
      `<div>${escapeHtml(threat.explanationShort || threat.title || '')}</div>` +
      (headingOf(threat) === null ? '' :
        `<div class="popup__meta">курс: ${compass(headingOf(threat))}` +
        (threat.velocity && Number.isFinite(threat.velocity.speedKmh)
          ? ` · ${Math.round(threat.velocity.speedKmh)} км/год`
          : ` · швидкість орієнтовна (${REFERENCE_KMH[threat.type] ?? 150} км/год)`) +
        `</div>`) +
      `<div class="popup__meta">${escapeHtml(parts.join(' · '))}` +
      (when ? ` · <span class="popup__ago">${agoText(when)}</span>` : '') +
      (threat.sourceCount ? ` · підтверджень: ${threat.sourceCount}` : '') +
      `</div>`,
    )
    .addTo(map);

  activePopup = popup;

  /* A popup left open would otherwise keep claiming "2 хвилини тому" indefinitely, which
   * is worse than the clock it replaced: a wrong relative time reads as fresh. */
  const tick = when ? setInterval(() => {
    const span = popup.getElement()?.querySelector('.popup__ago');
    if (span) span.textContent = agoText(when);
  }, 15000) : null;

  let dismiss = null;
  const restart = () => {
    clearTimeout(dismiss);
    dismiss = setTimeout(() => popup.remove(), POPUP_LIFETIME_MS);
  };
  restart();

  /* Touching the popup means it is being read - start the countdown over rather than
   * pulling it away mid-sentence. */
  popup.getElement()?.addEventListener('pointerdown', restart);

  popup.on('close', () => {
    clearTimeout(dismiss);
    if (tick) clearInterval(tick);
    if (activePopup === popup) activePopup = null;
  });
}

/** Degrees to the eight-point compass, because "на південний захід" is read faster than
 * "223°" and is no less accurate at this resolution. */
function compass(deg) {
  const names = ['на північ', 'на північний схід', 'на схід', 'на південний схід',
                 'на південь', 'на південний захід', 'на захід', 'на північний захід'];
  return names[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** Redraw every marker at its predicted position. Runs on a frame loop rather than on
 * each message, so motion stays smooth between the sparse server updates. */
function render() {
  if (!mapReady) return;
  const now = Date.now();
  const counts = Object.create(null);

  for (const [id, threat] of threats) {
    counts[threat.type] = (counts[threat.type] || 0) + 1;

    if (hidden.has(threat.type)) {
      const existing = markers.get(id);
      if (existing) { existing.marker.remove(); markers.delete(id); }
      continue;
    }

    const at = predict(threat, now);
    if (!Number.isFinite(at.lat) || !Number.isFinite(at.lon)) continue;

    let entry = markers.get(id);
    if (!entry || entry.type !== threat.type) {
      if (entry) entry.marker.remove();
      const el = markerElement(threat);
      entry = {
        marker: new maplibregl.Marker({ element: el }).setLngLat([at.lon, at.lat]).addTo(map),
        el,
        rot: el.firstElementChild,
        type: threat.type,
      };
      markers.set(id, entry);
    } else {
      entry.marker.setLngLat([at.lon, at.lat]);
      applyHeading(entry.el, entry.rot, threat);
    }

    const stale = threat.updatedAt
      && (now - Date.parse(threat.updatedAt)) / 1000 > STALE_AFTER_S;
    entry.el.classList.toggle('threat--stale', Boolean(stale) || threat.status !== 'active');
    /* Position carried by a reference speed rather than a reported one. Marked, so the
       difference between a measurement and an estimate stays visible on screen. */
    entry.el.classList.toggle('threat--estimated', at.estimated && at.moving);
  }

  for (const [id, entry] of markers) {
    if (!threats.has(id)) { entry.marker.remove(); markers.delete(id); }
  }

  updateLegend(counts);
  updateCounts(counts);
}

function frame() {
  const now = performance.now();
  /* 8 fps is plenty for objects moving a few hundred km/h on a country-scale map, and it
   * keeps a phone left open all night from cooking its battery. */
  if (now - lastFrameAt > 125) { lastFrameAt = now; render(); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* -------------------------------------------------------------------- legend */

const legendEl = document.getElementById('legend');
function buildLegend() {
  legendEl.innerHTML = '';
  for (const t of TYPES) {
    const b = document.createElement('button');
    b.className = 'legend__item';
    b.type = 'button';
    b.setAttribute('aria-pressed', String(!hidden.has(t.key)));
    b.innerHTML = `<span class="legend__icon">${ICONS[ICON_FOR[t.key]](15, t.colour)}</span>` +
                  `<span>${t.label}</span><span class="legend__count" data-count="${t.key}"></span>`;
    b.addEventListener('click', () => {
      const nowHidden = !hidden.has(t.key);
      nowHidden ? hidden.add(t.key) : hidden.delete(t.key);
      b.setAttribute('aria-pressed', String(!nowHidden));
      localStorage.setItem('radar.hidden', JSON.stringify([...hidden]));
      render();
    });
    legendEl.appendChild(b);
  }
}
buildLegend();

function updateLegend(counts) {
  for (const t of TYPES) {
    const el = legendEl.querySelector(`[data-count="${t.key}"]`);
    if (!el) continue;
    const n = counts[t.key] || 0;
    el.textContent = n ? String(n) : '';
  }
}

/* The ballistic tally gets its own row rather than being appended to the total.
 *
 * Appended, it made the meta column wider whenever it appeared, the headline column
 * narrower by the same amount, and "Тривога в Бучанському районі" re-wrap to a different
 * line - the same words jumping between renders for no reason the reader can see. A row
 * changes the block's height, which nothing else depends on; a longer value changes its
 * width, which the headline does. */
function updateCounts(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const ballistic = counts.ballistic || 0;
  document.getElementById('counts').textContent = String(total);
  const row = document.getElementById('ballistic-row');
  const cell = document.getElementById('ballistic-count');
  if (cell) cell.textContent = ballistic ? String(ballistic) : '';
  if (row) row.hidden = !ballistic;
}

/* ------------------------------------------------------------------ live feed */

let ws = null;
let retries = 0;
let reconnectTimer = null;

function connect() {
  clearTimeout(reconnectTimer);
  try {
    ws = new WebSocket(STREAM);
  } catch (err) {
    scheduleReconnect();
    return;
  }
  socketState = 'connecting';

  ws.onopen = () => { retries = 0; socketState = 'live'; paintStatus(); };
  ws.onmessage = (ev) => {
    let env;
    try { env = JSON.parse(ev.data); } catch { return; }
    lastDataAt = Date.now();

    switch (env.type) {
      case 'snapshot': {
        threats.clear();
        for (const t of (env.data?.threats || [])) threats.set(t.id, t);
        break;
      }
      case 'upsert':
        if (env.data?.id) threats.set(env.data.id, env.data);
        break;
      case 'remove':
        if (env.data?.id) threats.delete(env.data.id);
        break;
      /* Neptun's own alert envelope is deliberately ignored: alerts come from the
       * official feed through status.json. Its threat track envelopes above are the only
       * thing this socket is here for. */
      case 'alerts':
        break;
      case 'heartbeat':
      default:
        break;
    }
    paintStatus();
  };
  ws.onclose = () => { ws = null; scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function scheduleReconnect() {
  socketState = 'reconnecting';
  paintStatus();
  retries += 1;
  /* Fall back to REST immediately on the first failure, so a blocked WebSocket degrades
   * to a slower map rather than to an empty one. */
  if (retries === 1) restFallback();
  const wait = Math.min(15000, 1000 * 2 ** Math.min(retries - 1, 4)) + Math.random() * 400;
  reconnectTimer = setTimeout(connect, wait);
}

async function restFallback() {
  try {
    const data = await fetch(`${NEPTUN}/api/v1/threats`).then(r => r.json());
    threats.clear();
    for (const t of (data.threats || [])) threats.set(t.id, t);
    lastDataAt = Date.now();
    paintStatus();
  } catch (err) {
    console.warn('REST fallback failed', err);
  }
}

/* Which shapes the alert fill covers.
 *
 * Read from status.json and from nothing else, because that file carries alerts.in.ua -
 * the official service. Neptun, which used to fill this map, says on its own page that it
 * is not an official alert, and it disagrees with the official feed in both directions: on
 * 2026-08-31 at 18:02 it claimed the whole Kharkivskyi raion while the official feed named
 * only Lypetska hromada inside it.
 *
 * The daemon has already done the hard half. It resolves every alerted unit down to the
 * raion it sits in and publishes KATOTTH codes, so there is no name matching here at all -
 * which matters, because raion names are neither unique nor stable, and getting that wrong
 * in a page means a district that silently never turns red. */
function applyAlerts() {
  if (!mapReady) return;

  const wholeOblasts = new Set();
  const raionCodes = new Set();

  for (const region of Object.values(status?.regions || {})) {
    if (!region.alert) continue;
    const codes = region.raions || [];
    /* Two ways an oblast gets filled entirely. `whole` is an oblast-wide declaration, which
     * is the truth. No codes at all on an alerted oblast is the fallback: the feed named
     * something with no geometry anywhere - a city, arriving without its hromada - and
     * "somewhere in this oblast" serves a reader better than a calm map. */
    if (region.whole || codes.length === 0) {
      wholeOblasts.add(normaliseOblast(region.name));
    }
    for (const code of codes) raionCodes.add(code);
  }

  if (map.getSource('oblasts')) {
    for (const [name, id] of oblastIndex) {
      const alert = wholeOblasts.has(name);
      map.setFeatureState({ source: 'oblasts', id }, { alert });
      /* The label lives on its own source, so its feature-state is a separate write - miss
       * this and the outline turns red while its name stays grey. */
      if (map.getSource('oblast-labels')) {
        map.setFeatureState({ source: 'oblast-labels', id }, { alert });
      }
    }
  }
  if (map.getSource('raions')) {
    for (const [code, id] of raionIndex) {
      map.setFeatureState({ source: 'raions', id }, { alert: raionCodes.has(code) });
    }
  }
}

/* ------------------------------------------------------------------- status */

let status = null;
let statusFetchedAt = 0;

async function fetchStatus() {
  try {
    const res = await fetch(`${STATUS_URL}?t=${Date.now()}`, { cache: 'no-store' });
    status = res.ok ? await res.json() : null;
    statusFetchedAt = Date.now();
  } catch {
    status = null;
  }
  /* The fill is part of the status now, not a separate feed, so it repaints here rather
   * than on its own timer. */
  applyAlerts();
  paintStatus();
}

/* Up here with the other lookups, not next to the sheet code that uses them: these are
 * `const`, `renderPlaceList` is hoisted, and a call before the declaration would throw.
 * Same reason `place` lives at the top of the file. */
const sheet = document.getElementById('sheet');
const placeList = document.getElementById('place-list');
const placeSearch = document.getElementById('place-search');
const geoMsg = document.getElementById('geo-msg');

const el = {
  bar: document.getElementById('status'),
  headline: document.getElementById('headline'),
  reason: document.getElementById('reason'),
  kyiv: document.getElementById('kyiv'),
  kyivLabel: document.getElementById('kyiv-label'),
  oblastRow: document.getElementById('oblast-row'),
  oblast: document.getElementById('oblast'),
  freshness: document.getElementById('freshness'),
};

/* The panel answers two independent questions, one per line, and never mixes them.
 *
 * Line one: is there an air-raid alert, and where. That is a fact about Kyiv, it is what
 * a person checks first, and it is red whenever it is true. The old design led with
 * "Балістичної загрози немає" in green while a siren was running over the city, which
 * read as reassurance at the exact moment reassurance was wrong.
 *
 * Line two: is any of it ballistic, HERE. Absent when it is not - silence is the honest
 * answer and it keeps the panel quiet on the ~11 ordinary alerts a week.
 *
 *     red, pulsing   the Air Force named your region and the siren is on here
 *     yellow         a ballistic declaration that can reach you
 *     white          what is actually flying over your place
 *
 * The distinction between red and yellow is the distinction between "at you" and "in the
 * air somewhere that includes you". 57 % of ballistic declarations name no place at all,
 * so treating them as "at you" would turn most of them red and the colour would stop
 * meaning anything.
 *
 * The reason text ("ракета на Одесу") is gone on purpose: a launch at another city is
 * not information this page exists to carry. */
function paintStatus() {
  let cls = 'unknown';          /* left edge: the most severe thing on the panel */
  let headline = 'Статус недоступний';
  let alerted = false;          /* drives the headline colour, nothing else */
  let sub = '';                 /* second line, empty when there is nothing to say */
  let subCls = '';

  if (status) {
    const ageS = (Date.now() - Date.parse(status.written_at)) / 1000;
    if (ageS > 180) {
      /* The daemon writes every few seconds. Three minutes of silence means it is not
       * running, and saying "no threat" on its behalf would be the one lie this whole
       * project exists to avoid. */
      headline = 'Статус застарів';
      sub = `дані не оновлювались ${Math.round(ageS / 60)} хв`;
    } else {
      alerted = placeAlerted();
      headline = placeHeadline();

      const region = regionFor(place.oblast);
      const ballistic = region ? region.ballistic : null;

      /* The engine's own verdict still wins for Kyiv, and that is not favouritism: it
       * carries suppression the per-region watch does not - it goes quiet when every
       * located ballistic track sits over Donetsk. Where it speaks, it is the better
       * answer; elsewhere the watch is the only one. */
      const engineFired = status.state === 'alarm' && isKyivPlace();

      if (status.degraded && (alerted || engineFired)) {
        cls = 'alarm';
        subCls = 'alarm';
        sub = 'ФІЛЬТР НЕ ПРАЦЮЄ — ТИП НЕВІДОМИЙ';
      } else if (engineFired || (ballistic === 'named' && alerted)) {
        cls = 'alarm';
        subCls = 'alarm';
        /* "в повітрі", not "загроза": a named declaration means the Air Force reported an
         * actual missile, while a placeless one says only that ballistic weapons may be
         * used. Calling both a threat would waste the distinction; calling both a launch
         * would claim something they did not say.
         *
         * No "take cover" either - an alert already means take cover, so the words add
         * nothing and cost the line its bluntness. The pulse is the instruction. */
        sub = 'Балістика в повітрі';
      } else if (ballistic) {
        cls = 'watch';
        subCls = 'watch';
        sub = 'Загроза балістики';
      } else if (status.state === 'armed' && isKyivPlace()) {
        cls = 'watch';
        subCls = 'watch';
        /* Only say "ballistic" when a ballistic marker is what armed it. A missile or
         * aviation post arms the engine too, and announcing those as a ballistic threat
         * makes the whole panel untrustworthy. */
        sub = status.armed_class === 'ballistic' ? 'Загроза балістики'
            : status.armed_class === 'aviation' ? 'Активність авіації'
            : 'Ракетна небезпека';
      } else {
        cls = alerted ? 'alert' : 'calm';
        /* Nothing ballistic to report, so the line is free for the question a person asks
         * next: what is actually up there. Only during an alert - listing tracks while the
         * place is quiet would be trivia. */
        if (alerted) { sub = placeComposition(); subCls = sub ? 'info' : ''; }
      }
    }
    /* The two meta rows used to be "Київ" and "Область" unconditionally. They now follow
     * the chosen place: the place itself, and the oblast it sits in - which for an oblast
     * selection is the same thing, so the second row is dropped in that case. */
    const region = regionFor(place.oblast);
    el.kyivLabel.textContent = place.name;
    el.kyiv.textContent = placeAlerted() ? 'тривога' : 'тихо';
    el.oblastRow.hidden = place.level === 'oblast';
    el.oblast.textContent = region && region.alert ? 'тривога' : 'тихо';
  } else {
    sub = 'сервіс сповіщень не відповідає';
    el.kyiv.textContent = '—';
    el.oblast.textContent = '—';
    el.oblastRow.hidden = false;
  }

  el.bar.className = `status status--${cls}`;
  el.headline.textContent = headline;
  /* Colour follows the alert, not the panel: the engine can be armed with no Kyiv alert
   * at all, and a red "Тривог немає" would be nonsense. */
  el.headline.className = 'status__headline status__headline--'
    + (status && cls !== 'unknown' ? (alerted ? 'alert' : 'calm') : 'unknown');
  el.reason.textContent = sub;
  el.reason.className = 'status__reason' + (subCls ? ` status__reason--${subCls}` : '');
  el.reason.hidden = !sub;

  const feedAge = lastDataAt ? Math.round((Date.now() - lastDataAt) / 1000) : null;
  el.freshness.textContent =
    socketState === 'live' && feedAge !== null && feedAge < 120 ? 'онлайн'
    : socketState === 'live' ? `${Math.round((feedAge ?? 0) / 60)} хв тому`
    : socketState === 'reconnecting' ? 'зв\'язок…'
    : 'з\'єднання…';
}

/* ------------------------------------------------------------------ lifecycle */

/* ------------------------------------------------------------------ your place */

/* Which place this page is about. Everything above - the headline, the composition line,
 * where the map opens - answers for THIS, not for Kyiv.
 *
 * Manual choice is the primary mechanism and auto-detect only fills the same field. So the
 * stored value is always a concrete place, never a mode: open the page in another city
 * tomorrow and your home region is still your home region, rather than silently becoming
 * wherever the phone happens to be. */

function loadPlace() {
  try {
    const raw = localStorage.getItem(PLACE_KEY);
    if (raw) place = JSON.parse(raw);
  } catch { /* corrupt or blocked storage: the default is a perfectly good answer */ }
}

function savePlace(next) {
  place = next;
  try { localStorage.setItem(PLACE_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  paintStatus();
  render();
  renderPlaceList();
}

/* The published status keys regions by their canonical English name and carries the
 * Ukrainian one in `name`; the catalogue only knows Ukrainian. This bridges the two
 * without a second copy of the mapping. */
function regionFor(oblastName) {
  const want = normaliseOblast(oblastName);
  for (const entry of Object.values(status?.regions || {})) {
    if (normaliseOblast(entry.name) === want) return entry;
  }
  return null;
}

/* Is the chosen place under an air-raid alert?
 *
 * An oblast is alerted when its own record says so. A raion is alerted when the oblast is
 * up as a whole, or when that raion is named among the units - which is why the daemon
 * publishes the unit list at all. */
/* The unit whose alert this place inherits.
 *
 * A settlement does not get its own alert: alerts are declared for oblasts, raions and
 * hromadas, never for a village. Choosing Крюківщина therefore means watching Бучанський
 * район - which is also why the headline names the raion. */
function unitOf(p) {
  return p.level === 'oblast' ? null : (p.raion || p.name);
}

function alertedAt(p) {
  const region = regionFor(p.oblast);
  if (!region || !region.alert) return false;
  if (p.level === 'oblast') return true;
  if (region.whole) return true;
  const want = normaliseOblast(unitOf(p));
  return region.units.some(u => normaliseOblast(u) === want);
}

function placeAlerted() {
  return alertedAt(place);
}

/* Does the chosen place sit under the engine's own verdict? The engine only computes Kyiv,
 * so this is what decides whether its `state` may be read at all. */
function isKyivPlace() {
  const o = normaliseOblast(place.oblast);
  return o === 'київ' || o === 'київська';
}

/* Is this track over the chosen place?
 *
 * Strings first: Neptun labels most tracks with a region and a district, and a string
 * comparison is both exact and free. Geometry is the fallback for the roughly one track in
 * five that arrives with no region at all - and only at oblast level, because raion
 * polygons are deliberately not shipped to the browser.
 *
 * A settlement is treated as its raion here too. Matching on `locality` would be tighter
 * but almost always empty, and an empty line reads as "nothing is flying" - which is the
 * one thing this page must never imply without knowing it. */
function overPlace(threat) {
  if (place.level !== 'oblast') {
    const unit = unitOf(place);
    const key = (threat.regionKey || '').toLowerCase();
    if (key && key === (place.raionKey || place.key)) return true;
    return normaliseOblast(threat.district) === normaliseOblast(unit);
  }
  if (normaliseOblast(threat.region) === normaliseOblast(place.oblast)) return true;
  return overGeometry(threat, place.oblast);
}

function placeComposition() {
  const counts = Object.create(null);
  for (const t of threats.values()) if (overPlace(t)) counts[t.type] = (counts[t.type] || 0) + 1;
  const parts = [];
  for (const t of TYPES) if (counts[t.key]) parts.push(`${t.label} ${counts[t.key]}`);
  if (counts.unknown) parts.push(`Невідомі ${counts.unknown}`);
  return parts.join(' · ');
}

/* The locative form comes from the catalogue, computed at build time for all 163 regular
 * names. Ukrainian declension is not something to improvise here, and this is the line the
 * reader looks at first. */
function placeHeadline() {
  if (!placeAlerted()) return 'Тривог немає';
  return place.loc ? `Тривога в ${place.loc}` : `Тривога: ${place.name}`;
}

/* ------------------------------------------------------------- settings sheet */

/* Ukraine -> oblast -> raion -> settlement, one level at a time. A flat list cannot work:
 * "Іванівка" is the name of 107 different villages and "Вишневе" of 56, so a name on its
 * own does not identify a place.
 *
 * Every tap both refines the selection and descends a level, so you can stop wherever you
 * like - tap "Київська" and that is your place, tap again into "Бучанський" and now that
 * is. Search cuts across all of it, because plenty of people do not know which raion their
 * village ended up in after the 2020 reform. */

let browse = { oblast: null, raion: null };
let settlements = null;        // lazily loaded: 303 KB gzipped
let settlementsLoading = null;

function loadSettlements() {
  if (settlements) return Promise.resolve(settlements);
  if (settlementsLoading) return settlementsLoading;
  settlementsLoading = fetch('settlements.json?v=cec1208e')
    .then(r => r.json())
    .then((data) => { settlements = data; return data; })
    .catch((err) => { console.warn('settlements load failed', err); settlementsLoading = null; });
  return settlementsLoading;
}

function raionByKey(key) {
  return places.find(p => p.level === 'raion' && p.key === key);
}

/* Kyiv city and Sevastopol are subjects with no raions beneath them. Offering to descend
 * into an empty list is a dead end, so they get no chevron and selecting them closes the
 * sheet like a leaf. */
function hasChildren(p) {
  if (p.level === 'settlement') return false;
  if (p.level === 'raion') return true;
  return places.some(q => q.level === 'raion'
    && normaliseOblast(q.oblast) === normaliseOblast(p.oblast));
}

function settlementPlace(row) {
  const [name, idx, lon, lat] = row;
  const raion = raionByKey(settlements.raions[idx]);
  if (!raion) return null;
  return {
    level: 'settlement',
    key: `${name}|${idx}`,
    name,
    full: `${name}, ${raion.name}`,
    oblast: raion.oblast,
    /* Carried so the alert, the composition and the headline all resolve to the raion
     * without having to look it up again on every repaint. */
    raion: raion.name,
    raionKey: raion.key,
    loc: raion.loc,
    lon, lat,
    zoom: 11,
  };
}

function openSheet() {
  sheet.hidden = false;
  /* Open on the reader's SIBLINGS, not inside their own place. Someone opening this wants
   * to change the choice, and a list of one thing's children is no help - Kyiv city has no
   * raions at all, so opening inside it showed an empty list and a dead end. */
  browse = place.level === 'oblast' ? { oblast: null, raion: null }
    : place.level === 'raion' ? { oblast: place.oblast, raion: null }
    : { oblast: place.oblast, raion: place.raionKey };
  placeSearch.value = '';
  renderPlaceList();
  placeSearch.focus({ preventScroll: true });
}

function closeSheet() {
  sheet.hidden = true;
  geoMsg.hidden = true;
}

function byName(a, b) { return a.name.localeCompare(b.name, 'uk'); }

/* Search folding, Ukrainian only. Ignores apostrophes, soft signs and doubled letters, so
 * "Кам'янець" is found without the apostrophe and a mistyped double letter still matches.
 *
 * Deliberately no Russian and no Latin: the interface is Ukrainian, and a half-working
 * transliteration is worse than none - it answers some queries and silently fails others,
 * which reads as a broken search rather than a Ukrainian one. */
function fold(s) {
  return (s || '').toLowerCase()
    .replace(/[\u02bc'\u2019`\u02b9]/g, '')
    .replace(/[ьъ]/g, '')
    .replace(/(.)\1+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesQuery(p, q) {
  return fold(p.name).includes(q);
}

/* What the list shows right now: either search results across everything, or one level of
 * the cascade. */
function currentRows() {
  const q = fold(placeSearch.value);

  if (q.length >= 2) {
    /* Oblasts first, then raions, then settlements: the coarser the place, the more likely
     * it is what a two-letter query meant. */
    const hits = places
      .filter(p => matchesQuery(p, q))
      .sort((a, b) => (a.level === b.level ? byName(a, b) : (a.level === 'oblast' ? -1 : 1)));
    if (settlements) {
      for (const row of settlements.settlements) {
        if (hits.length >= 80) break;
        if (fold(row[0]).includes(q)) {
          const p = settlementPlace(row);
          if (p) hits.push(p);
        }
      }
    } else {
      loadSettlements().then(renderPlaceList);
    }
    return { rows: hits.slice(0, 80), crumbs: null };
  }

  if (!browse.oblast) {
    return { rows: places.filter(p => p.level === 'oblast').sort(byName), crumbs: [] };
  }

  const oblast = places.find(p => p.level === 'oblast'
    && normaliseOblast(p.oblast) === normaliseOblast(browse.oblast));

  if (!browse.raion) {
    const rows = places
      .filter(p => p.level === 'raion' && normaliseOblast(p.oblast) === normaliseOblast(browse.oblast))
      .sort(byName);
    return { rows, crumbs: [oblast] };
  }

  const raion = raionByKey(browse.raion);
  if (!settlements) {
    loadSettlements().then(renderPlaceList);
    return { rows: [], crumbs: [oblast, raion], loading: true };
  }
  const idx = settlements.raions.indexOf(browse.raion);
  const rows = settlements.settlements
    .filter(r => r[1] === idx)
    .map(settlementPlace)
    .filter(Boolean)
    .sort(byName);
  return { rows, crumbs: [oblast, raion] };
}

function renderPlaceList() {
  document.getElementById('sheet-now').textContent = place.full || place.name;

  const { rows, crumbs, loading } = currentRows();

  /* Breadcrumbs double as the way back up: there is no separate back button, because a
   * sheet with both is a sheet where neither is obvious. */
  const crumbBar = document.getElementById('sheet-crumbs');
  if (!crumbs) {
    crumbBar.hidden = true;
  } else {
    crumbBar.hidden = false;
    crumbBar.innerHTML = '';
    const step = (label, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sheet__crumb';
      b.textContent = label;
      b.addEventListener('click', onClick);
      crumbBar.appendChild(b);
    };
    step('Україна', () => { browse = { oblast: null, raion: null }; renderPlaceList(); });
    if (crumbs[0]) step(crumbs[0].name, () => {
      browse = { oblast: crumbs[0].oblast, raion: null }; renderPlaceList();
    });
    if (crumbs[1]) step(crumbs[1].name, () => renderPlaceList());
  }

  placeList.innerHTML = '';
  if (loading) {
    const li = document.createElement('li');
    li.className = 'sheet__empty';
    li.textContent = 'Завантаження населених пунктів…';
    placeList.appendChild(li);
    return;
  }
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'sheet__empty';
    li.textContent = 'Нічого не знайдено';
    placeList.appendChild(li);
    return;
  }

  for (const p of rows) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    const chosen = p.key === place.key && p.level === place.level;
    btn.className = 'sheet__item' + (chosen ? ' sheet__item--on' : '');
    /* The place's OWN alert, not its oblast's: an oblast can be up while this raion is
     * not, and a badge that says otherwise is the exact lie this project exists to
     * remove. */
    const alerted = alertedAt(p);
    btn.innerHTML =
      `<span>${escapeHtml(p.name)}</span>` +
      (p.level !== 'oblast' && placeSearch.value
        ? `<span class="sheet__where">${escapeHtml(p.raion || p.oblast.replace(/\s+область$/, ''))}</span>`
        : '') +
      (alerted ? '<span class="sheet__alert">тривога</span>' : '') +
      (hasChildren(p) ? '<span class="sheet__more">›</span>' : '');
    btn.addEventListener('click', () => {
      savePlace(p);
      fitUntilTouched = false;
      flyToPlace();
      if (!hasChildren(p)) { closeSheet(); return; }
      /* Descend, so the next tap refines. Selection already happened. */
      browse = p.level === 'oblast'
        ? { oblast: p.oblast, raion: null }
        : { oblast: p.oblast, raion: p.key };
      placeSearch.value = '';
      renderPlaceList();
    });
    li.appendChild(btn);
    placeList.appendChild(li);
  }
}

function flyToPlace() {
  map.flyTo({ center: [place.lon, place.lat], zoom: place.zoom || 7.2, duration: 800 });
}

document.getElementById('settings').addEventListener('click', openSheet);
document.getElementById('sheet-close').addEventListener('click', closeSheet);
placeSearch.addEventListener('input', renderPlaceList);
sheet.addEventListener('click', (ev) => { if (ev.target === sheet) closeSheet(); });
addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !sheet.hidden) closeSheet(); });

/* --------------------------------------------------------------- geolocation */

/* Asked for only on a tap, never on load, and never with watchPosition: this page is meant
 * to sit open all night, and continuous positioning would drain the battery it is supposed
 * to be watched on. Coordinates are used here and thrown away - nothing is sent anywhere. */
function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('unsupported'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve([pos.coords.longitude, pos.coords.latitude]),
      reject,
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 },
    );
  });
}

let meMarker = null;
function showMe(lonLat) {
  if (!meMarker) {
    const dot = document.createElement('div');
    dot.className = 'me';
    meMarker = new maplibregl.Marker({ element: dot }).setLngLat(lonLat).addTo(map);
  } else {
    meMarker.setLngLat(lonLat);
  }
}

function geoExcuse(err) {
  if (!navigator.geolocation) return 'Пристрій не вміє визначати місце.';
  if (err && err.code === 1) return 'Доступ до місця не надано.';
  if (err && err.code === 3) return 'Не вдалося визначити місце — надто довго.';
  return 'Не вдалося визначити місце.';
}

/* The button says "to me", so when it cannot do that it must say why rather than quietly
 * going somewhere else. */
document.getElementById('recenter').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  btn.setAttribute('aria-busy', 'true');
  try {
    const at = await locate();
    showMe(at);
    map.flyTo({ center: at, zoom: 9, duration: 800 });
  } catch (err) {
    flyToPlace();
    geoMsg.textContent = geoExcuse(err) + ' Показано вибране місце.';
    geoMsg.hidden = false;
    openSheet();
  } finally {
    btn.removeAttribute('aria-busy');
  }
});

/* Auto-detect resolves the OBLAST exactly, by testing the point against the oblast
 * polygons the map already has. The raion inside it is then the nearest raion centre,
 * which is an approximation and can be wrong near a boundary - so the result is shown in
 * the sheet for the reader to correct, and correcting it always wins. */
document.getElementById('geo-detect').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  btn.setAttribute('aria-busy', 'true');
  geoMsg.hidden = true;
  try {
    const at = await locate();
    showMe(at);
    const oblast = oblastAt(at);
    if (!oblast) {
      geoMsg.textContent = 'Ви поза межами України — вибір залишився без змін.';
      geoMsg.hidden = false;
      return;
    }
    const inside = places.filter(p => p.level === 'raion'
      && normaliseOblast(p.oblast) === normaliseOblast(oblast));
    const nearest = inside.reduce((best, p) => {
      const d = (p.lon - at[0]) ** 2 + (p.lat - at[1]) ** 2;
      return !best || d < best.d ? { p, d } : best;
    }, null);
    savePlace(nearest ? nearest.p
      : places.find(p => p.level === 'oblast' && normaliseOblast(p.oblast) === normaliseOblast(oblast)));
    flyToPlace();
    geoMsg.textContent = `Визначено: ${place.full}. Якщо не так — виберіть зі списку.`;
    geoMsg.hidden = false;
  } catch (err) {
    geoMsg.textContent = geoExcuse(err);
    geoMsg.hidden = false;
  } finally {
    btn.removeAttribute('aria-busy');
  }
});

/* Coming back from the lock screen: a phone suspends timers and sockets, so without this
 * the map shows a frozen picture that looks current. */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  fetchStatus();
  if (!ws || ws.readyState > 1) { retries = 0; connect(); }
});

setInterval(fetchStatus, 5000);
setInterval(paintStatus, 15000);   // keeps the freshness line honest while idle

/* The catalogue is 39 KB and the headline needs it immediately - a reader whose place is
 * a raion would otherwise see the default for a moment. So it ships with the page rather
 * than being fetched when the sheet opens. */
fetch('places.json?v=748a44ef')
  .then(r => r.json())
  .then((list) => {
    places = list;
    /* Re-resolve the stored choice against the current catalogue: a raion renamed or
     * dropped upstream would otherwise stay selected forever and match nothing. */
    const fresh = places.find(p => p.key === place.key && p.level === place.level);
    if (fresh) place = fresh;
    renderPlaceList();
    paintStatus();
  })
  .catch(err => console.warn('places load failed', err));

fetchStatus();
connect();
