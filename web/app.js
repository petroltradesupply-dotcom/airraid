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
  { key: 'ballistic', label: 'Балістика', colour: '#ff2d55' },
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
  style: 'map-style.json',
  center: KYIV,
  zoom: 5.6,
  minZoom: 4,
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
map.on('style.load', () => {
  mapReady = true;
  addOblastLayer();
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
    const geo = await fetch('oblasts.geojson').then(r => r.json());
    map.addSource('oblasts', { type: 'geojson', data: geo });
    map.addLayer({
      id: 'oblast-alert-fill',
      type: 'fill',
      source: 'oblasts',
      paint: {
        'fill-color': ['case', ['boolean', ['feature-state', 'alert'], false], '#ff2d55', '#000000'],
        'fill-opacity': ['case', ['boolean', ['feature-state', 'alert'], false], 0.10, 0],
      },
    });
    map.addLayer({
      id: 'oblast-outline',
      type: 'line',
      source: 'oblasts',
      paint: {
        'line-color': ['case', ['boolean', ['feature-state', 'alert'], false], '#ff2d55', '#3a4160'],
        'line-width': ['case', ['boolean', ['feature-state', 'alert'], false], 1.4, 0.7],
        'line-opacity': ['case', ['boolean', ['feature-state', 'alert'], false], 0.75, 0.5],
      },
    });
    /* MapLibre feature-state needs a stable id per feature; the file has none, so index
     * by position and keep a name -> index map for the alert updates. */
    geo.features.forEach((f, i) => {
      f.id = i;
      const name = normaliseOblast(f.properties.region || f.properties.key || '');
      oblastIndex.set(name, i);
      /* The file carries Kyiv city and Kyiv oblast as separate shapes, which is exactly
       * the pair the status line needs: roughly a fifth of Neptun's tracks arrive with no
       * `region` at all, and for those the geometry is the only way to tell whether the
       * thing is over us. */
      if (name === 'київ' || name === 'київська') kyivShapes.push(f.geometry);
    });
    map.getSource('oblasts').setData(geo);
    applyAlerts();
  } catch (err) {
    console.warn('oblast layer failed', err);
  }
}

const oblastIndex = new Map();
const kyivShapes = [];           // Kyiv city + Kyiv oblast geometry, filled on load

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

/* Is this track over Kyiv or the oblast? The reported region is authoritative when it is
 * there; geometry is the fallback. Memoised per track, because the polygons run to
 * thousands of points and this must not happen inside the animation frame. */
const kyivCache = new Map();
function overKyiv(threat) {
  const stamp = `${threat.updatedAt || ''}|${threat.lat}|${threat.lon}`;
  const hit = kyivCache.get(threat.id);
  if (hit && hit.stamp === stamp) return hit.value;

  let value = false;
  const region = normaliseOblast(threat.region || '');
  if (region) {
    value = region === 'київ' || region === 'київська';
  } else if (Number.isFinite(threat.lat) && Number.isFinite(threat.lon)) {
    value = kyivShapes.some(g => inGeometry(g, threat.lon, threat.lat));
  }
  /* Tracks come and go all night; without this the cache is a slow leak. */
  if (kyivCache.size > 500) kyivCache.clear();
  kyivCache.set(threat.id, { stamp, value });
  return value;
}

/* What is over us right now, in the order the legend uses - severity first, so a lone
 * missile is read before twenty drones. */
function kyivComposition() {
  const counts = Object.create(null);
  for (const t of threats.values()) if (overKyiv(t)) counts[t.type] = (counts[t.type] || 0) + 1;
  const parts = [];
  for (const t of TYPES) if (counts[t.key]) parts.push(`${t.label} ${counts[t.key]}`);
  if (counts.unknown) parts.push(`Невідомі ${counts.unknown}`);
  return parts.join(' · ');
}
function normaliseOblast(name) {
  return name.toLowerCase()
    .replace(/^м\.\s*/, '')
    .replace(/\s+область$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* --------------------------------------------------------------------- state */

const threats = new Map();       // id -> threat
const markers = new Map();       // id -> { marker, el, type }
let alertedOblasts = new Set();
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

/** Point the marker along the track's course.
 *
 * Icons are drawn pointing north, so the rotation IS the compass heading. A track with no
 * reported course keeps the drawing upright and is marked, so "north" is never mistaken
 * for a measurement. */
function applyHeading(el, rot, threat) {
  const heading = headingOf(threat);
  rot.style.transform = heading === null ? '' : `rotate(${heading}deg)`;
  el.classList.toggle('threat--noheading', heading === null);
}

function showPopup(threat) {
  const when = threat.updatedAt ? new Date(threat.updatedAt) : null;
  const parts = [threat.locality, threat.district, threat.region].filter(Boolean);
  new maplibregl.Popup({ offset: 14, closeButton: false })
    .setLngLat([threat.lon, threat.lat])
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
      (when ? ` · ${when.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}` : '') +
      (threat.sourceCount ? ` · підтверджень: ${threat.sourceCount}` : '') +
      `</div>`,
    )
    .addTo(map);
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

function updateCounts(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const ballistic = counts.ballistic || 0;
  document.getElementById('counts').textContent =
    ballistic ? `${total} · балістика ${ballistic}` : String(total);
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

  ws.onopen = () => { retries = 0; socketState = 'live'; fetchAlerts(); paintStatus(); };
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
      case 'alerts':
        setAlerts(env.data);
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

async function fetchAlerts() {
  try {
    setAlerts(await fetch(`${NEPTUN}/api/v1/alerts`).then(r => r.json()));
  } catch (err) {
    console.warn('alerts fetch failed', err);
  }
}

function setAlerts(data) {
  const next = new Set();
  for (const r of (data?.raions || [])) if (r.oblast) next.add(normaliseOblast(r.oblast));
  for (const o of (data?.oblasts || [])) if (o.name) next.add(normaliseOblast(o.name));
  alertedOblasts = next;
  applyAlerts();
}

function applyAlerts() {
  if (!mapReady || !map.getSource('oblasts')) return;
  for (const [name, id] of oblastIndex) {
    map.setFeatureState({ source: 'oblasts', id }, { alert: alertedOblasts.has(name) });
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
  paintStatus();
}

const el = {
  bar: document.getElementById('status'),
  headline: document.getElementById('headline'),
  reason: document.getElementById('reason'),
  kyiv: document.getElementById('kyiv'),
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
 * Line two: is any of it ballistic. Absent when it is not - silence is the honest answer
 * and it keeps the panel quiet on the ~11 ordinary alerts a week. Yellow for a
 * declaration, bright red and pulsing only for ballistics aimed at Kyiv.
 *
 * The reason text ("ракета на Одесу") is gone on purpose: a launch at another city is
 * not information this page exists to carry. */
function alertHeadline(kyiv, oblast) {
  if (kyiv && oblast) return 'Тривога в Києві та області';
  if (kyiv) return 'Тривога в Києві';
  if (oblast) return 'Тривога в Київській області';
  return 'Тривог немає';
}

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
      alerted = Boolean(status.kyiv_alert || status.kyiv_oblast_alert);
      headline = alertHeadline(status.kyiv_alert, status.kyiv_oblast_alert);

      if (status.state === 'alarm') {
        cls = 'alarm';
        subCls = 'alarm';
        /* No "take cover" here: an alert already means take cover, so the words add
         * nothing and cost the line its bluntness. The pulse is the instruction. */
        sub = status.degraded ? 'ФІЛЬТР НЕ ПРАЦЮЄ — ТИП НЕВІДОМИЙ' : 'Балістика на Київ';
      } else if (status.state === 'armed') {
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
         * city is quiet would be trivia. */
        if (alerted) { sub = kyivComposition(); subCls = sub ? 'info' : ''; }
      }
    }
    el.kyiv.textContent = status.kyiv_alert ? 'тривога' : 'тихо';
    el.oblast.textContent = status.kyiv_oblast_alert ? 'тривога' : 'тихо';
  } else {
    sub = 'сервіс сповіщень не відповідає';
    el.kyiv.textContent = '—';
    el.oblast.textContent = '—';
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
    : socketState === 'reconnecting' ? 'перепідключення…'
    : 'з\'єднання…';
}

/* ------------------------------------------------------------------ lifecycle */

document.getElementById('recenter').addEventListener('click', () => {
  map.flyTo({ center: KYIV, zoom: 7.2, duration: 800 });
});

/* Coming back from the lock screen: a phone suspends timers and sockets, so without this
 * the map shows a frozen picture that looks current. */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  fetchStatus();
  if (!ws || ws.readyState > 1) { retries = 0; connect(); }
  else fetchAlerts();
});

setInterval(fetchStatus, 5000);
setInterval(paintStatus, 15000);   // keeps the freshness line honest while idle
setInterval(fetchAlerts, 60000);

fetchStatus();
connect();
