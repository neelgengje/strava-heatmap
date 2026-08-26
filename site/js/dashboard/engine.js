// ── Track Canvas Engine ─────────────────────────────────────
// Single canvas layer rendering every track, batched-stroked by (category,
// density bucket) — ~160 canvas calls per redraw instead of ~156,000.

// ── 1. Density index ─────────────────────────────────────────

const EARTH_R_LAT_M = 111320; // meters per degree latitude, ~constant
const DENSITY_BUCKETS = 16;

function cellSizeDeg(lat, cellMeters) {
  const latSize = cellMeters / EARTH_R_LAT_M;
  const lngSize = cellMeters / (EARTH_R_LAT_M * Math.max(0.15, Math.cos(lat * Math.PI / 180)));
  return { latSize, lngSize };
}

// A single number, not a string — Map lookups on numeric keys skip string
// hashing entirely. Safe from collisions because |cLng| never approaches
// 1e8: the worst case is at the equator (cos(lat)=1 minimizes lngSize,
// maximizing the cell count across +-180deg), which even at a tight 4m
// grid keeps |cLng| under 5e6 — well clear of cLat's 1e8 stride, and the
// composite stays an exact float64 integer.
function cellKey(lat, lng, latSize, lngSize) {
  const cLat = Math.floor(lat / latSize);
  const cLng = Math.floor(lng / lngSize);
  return cLat * 1e8 + cLng;
}

function maxOf(arr) {
  let m = -Infinity;
  for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
  return m;
}

// Grid-snaps every point and counts distinct activities per cell for an
// exact repeat count (blend modes like multiply/lighter can't produce a
// readable ramp — multiply crushes to black, lighter washes to white).
// Counts are quantized into log-scale buckets per category so rendering
// can batch-stroke by bucket instead of per segment.
//
// Cell counts are a plain number, not a Set of activity ids: a track only
// ever touches a given cell once (deduped below via `seen`), so "how many
// distinct activities visited this cell" is exactly "how many times a
// track's first visit incremented it" — no need to store the ids
// themselves. That, plus caching each point's cell key in a typed array on
// the first pass instead of recomputing it on the frequency-lookup pass,
// and indexed for-loops instead of `.forEach(([lat,lng]) => ...)` (which
// allocates an array-destructure per point), took this from ~250ms to
// ~50ms on a ~86k-point dataset — was the single largest chunk of load time.
function buildDensityIndex(tracks, cellMeters = 20, buckets = DENSITY_BUCKETS) {
  const grids = new Map(); // category -> cellKey -> count

  tracks.forEach(t => {
    let grid = grids.get(t.category);
    if (!grid) grids.set(t.category, grid = new Map());
    const { latSize, lngSize } = cellSizeDeg(t.coords[0]?.[0] ?? 37.5, cellMeters);
    t._latSize = latSize;
    t._lngSize = lngSize;
    const n = t.coords.length;
    const keys = t._cellKeys = new Float64Array(n);
    const seen = new Set(); // a track shouldn't inflate its own cell count via dense points
    for (let i = 0; i < n; i++) {
      const c = t.coords[i];
      const k = cellKey(c[0], c[1], latSize, lngSize);
      keys[i] = k;
      if (!seen.has(k)) { seen.add(k); grid.set(k, (grid.get(k) || 0) + 1); }
    }
  });

  const maxByCategory = {};
  tracks.forEach(t => {
    const grid = grids.get(t.category);
    const keys = t._cellKeys;
    const n = keys.length;
    const freq = t.pointFreq = new Array(n);
    let maxF = -Infinity;
    for (let i = 0; i < n; i++) {
      const f = grid.get(keys[i]) || 1;
      freq[i] = f;
      if (f > maxF) maxF = f;
    }
    t._maxFreq = maxF;
    if (!maxByCategory[t.category] || maxF > maxByCategory[t.category]) {
      maxByCategory[t.category] = maxF;
    }
  });

  tracks.forEach(t => {
    const maxF = Math.max(2, maxByCategory[t.category] || 1);
    const n = t.pointFreq.length;
    t.pointBucket = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      t.pointBucket[i] = bucketForFreq(t.pointFreq[i], maxF, buckets);
    }
  });

  const colorTable = {};
  tracks.forEach(t => {
    if (colorTable[t.category]) return;
    colorTable[t.category] = buildBucketColors(t.category, buckets);
  });

  return { tracks, colorTable, buckets };
}

function bucketForFreq(freq, maxF, buckets) {
  if (freq <= 1) return 0;
  const t = Math.log(freq) / Math.log(maxF);
  return Math.max(0, Math.min(buckets - 1, Math.round(t * (buckets - 1))));
}

function buildBucketColors(category, buckets) {
  const stops = typeForCategory(category).freqColors; // 5 stops, cold -> hot
  const arr = [];
  for (let b = 0; b < buckets; b++) {
    const t = buckets > 1 ? b / (buckets - 1) : 0;
    const scaled = t * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(scaled));
    const localT = scaled - i;
    arr.push(lerpColor(stops[i], stops[i + 1], localT));
  }
  return arr;
}

// ── 2. Canvas track layer ────────────────────────────────────

const TrackLayer = L.Layer.extend({

  initialize(options) {
    this._tracks = options.tracks || [];
    this._colorTable = options.colorTable || {};
    this._buckets = options.buckets || DENSITY_BUCKETS;
    this._baseWidth = options.baseWidth ?? 2.2;
    this._hoverWidth = options.hoverWidth ?? 3.2;
    this._selectedWidth = options.selectedWidth ?? 4.2;

    this._state = new Map(); // track.key -> { visible, drawProgress }
    this._trackByKey = new Map();

    // Segment grouping key is (category, bucket), both fixed once buckets
    // are assigned — precomputing it as one int per segment here means the
    // draw-in animation's per-frame regroup (_collectSegments, called on
    // every rAF tick for every visible track) hashes a small integer
    // instead of concatenating and hashing a fresh string per segment,
    // ~86k times a frame across ~130 frames.
    const categoryIndex = new Map();
    this._tracks.forEach(t => {
      if (!categoryIndex.has(t.category)) categoryIndex.set(t.category, categoryIndex.size);
    });
    this._tracks.forEach(t => {
      this._trackByKey.set(t.key, t);
      this._state.set(t.key, { visible: true, drawProgress: 1 });
      const n = t.coords.length;
      const catBase = categoryIndex.get(t.category) * this._buckets;
      const segKey = t._segKey = new Int32Array(Math.max(0, n - 1));
      for (let i = 0; i < segKey.length; i++) segKey[i] = catBase + t.pointBucket[i];
    });

    this._hoverKey = null;
    this._selectedKey = null;

    // Hover/select fade in as an overlay on top of the base pass, and the
    // rest of the map dims via one shared animated scalar — see
    // _draw()/_tick(). Each entry is {value, target}, eased every frame.
    this._hoverFades = new Map();
    this._selectFades = new Map();
    this._dimBlend = { value: 0, target: 0 };
    this._animating = false;

    // Cached grouped segment geometry — see _draw()'s base-pass comment.
    this._restGroupsCache = null;
    this._restGroupsDirty = true;
  },

  onAdd(map) {
    this._map = map;
    this._canvas = L.DomUtil.create('canvas', 'track-layer-canvas');
    // Required for _onFlyMove's scale to anchor at the canvas's own local
    // (0,0) — matching how its offset is computed as a top-left position —
    // rather than the CSS default (center), which would scale around the
    // middle of the viewport and throw the translate math off.
    this._canvas.style.transformOrigin = '0 0';
    const pane = map.getPane('overlayPane');
    pane.appendChild(this._canvas);
    this._ctx = this._canvas.getContext('2d');

    // viewreset alongside moveend/zoomend/resize: the same event Leaflet's
    // own markers listen to, so firing it manually (Dashboard._settleAfter)
    // forces every layer back in sync in one shot.
    map.on('moveend zoomend resize viewreset', this._reset, this);
    map.on('zoomanim', this._onZoomAnim, this);
    // flyTo (select/reset-view) drives the map through a continuous run of
    // 'move' events and never fires 'zoomanim' — confirmed by instrumenting
    // Leaflet's event stream during a flight, only movestart/move/zoom/moveend
    // fired. Without this, the canvas is left completely static for the whole
    // flight (the tiles/pane pan for free, but nothing reprojects our points)
    // and only catches up once moveend hits _reset(), reading as stray trails
    // that snap into place.
    map.on('move', this._onFlyMove, this);
    this._reset();
  },

  onRemove(map) {
    L.DomUtil.remove(this._canvas);
    clearTimeout(this._flyMoveTO);
    map.off('moveend zoomend resize viewreset', this._reset, this);
    map.off('zoomanim', this._onZoomAnim, this);
    map.off('move', this._onFlyMove, this);
  },

  // Translating the canvas element every frame (cheap: a DOM write) kept it
  // glued to the basemap through a pan, but a flyTo also changes zoom
  // continuously — and between the throttled full reprojects below, the
  // already-drawn bitmap (rasterized at the zoom level of the last _reset())
  // was displayed at that stale size while the basemap kept zooming under it,
  // popping back to the correct size each throttle tick. That's what read as
  // the trails flickering. Scaling the canvas element itself — the same trick
  // _onZoomAnim uses for a discrete zoom step — keeps the raster's apparent
  // size tracking the live zoom every frame, not just at each reproject.
  _onFlyMove() {
    const map = this._map;
    const scale = map.getZoomScale(map.getZoom(), this._resetZoom);
    const offset = map.latLngToLayerPoint(this._originLatLng);
    L.DomUtil.setTransform(this._canvas, offset, scale);
    if (this._flyMoveTO) return;
    this._flyMoveTO = setTimeout(() => {
      this._flyMoveTO = null;
      this._reset();
    }, 80);
  },

  // Repositions the canvas and reprojects every point. Panning is free
  // (pane transform); this runs on zoom/resize/viewreset.
  _reset() {
    const map = this._map;
    const size = map.getSize();
    const topLeft = map.containerPointToLayerPoint([0, 0]);
    // A plain setPosition (translate only) also clears any scale left over
    // from _onFlyMove/_onZoomAnim, which is correct here: fresh content is
    // about to be drawn at the current zoom's native resolution.
    L.DomUtil.setPosition(this._canvas, topLeft);

    // Capped at 2x: a CPU profile of the load animation showed the
    // per-frame "Commit" (main-thread rasterize + hand-off to the
    // compositor) dominating total frame cost, and that cost scales with
    // canvas pixel area — dpr² — not with anything else this layer does.
    // Above 2x the visual gain on a ~2px-wide trail line is imperceptible,
    // so this trades zero visible quality for meaningfully less to commit
    // on any 3x display (many phones, some Retina Macs) or a 4K Windows
    // panel at 200%+ scaling.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._canvas.width = size.x * dpr;
    this._canvas.height = size.y * dpr;
    this._canvas.style.width = size.x + 'px';
    this._canvas.style.height = size.y + 'px';
    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this._origin = map.containerPointToLayerPoint([0, 0]);
    // Reference point/zoom for _onFlyMove's live scale-and-translate tracking
    // until the next reset.
    this._originLatLng = map.containerPointToLatLng([0, 0]);
    this._resetZoom = map.getZoom();
    this._project();
    this._restGroupsDirty = true;
    this._draw();
  },

  // Scale/translate the canvas during the zoom animation so it doesn't
  // pop, matching how Leaflet's own canvas renderer behaves.
  _onZoomAnim(e) {
    const map = this._map;
    const scale = map.getZoomScale(e.zoom);
    const offset = map._latLngToNewLayerPoint(map.getBounds().getNorthWest(), e.zoom, e.center);
    L.DomUtil.setTransform(this._canvas, offset, scale);
  },

  // Projects every track into pixel space and caches each one's bbox for
  // a cheap reject in hitTest(). Cached until the next _reset().
  _project() {
    const map = this._map;
    this._tracks.forEach(t => {
      const n = t.coords.length;
      const px = t._px = new Float64Array(n * 2);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < n; i++) {
        const p = map.latLngToLayerPoint(t.coords[i]);
        const x = p.x - this._origin.x, y = p.y - this._origin.y;
        px[i * 2] = x; px[i * 2 + 1] = y;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      t._bbox = { minX, minY, maxX, maxY };
    });
  },

  _draw() {
    const ctx = this._ctx;
    const size = this._map.getSize();
    ctx.clearRect(0, 0, size.x, size.y);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Base pass: every visible track, batched by (category, bucket), stroked
    // ascending so hot segments paint over cold. Alpha is one shared
    // animated scalar (dimBlend); cached geometry is reused across a fade's
    // frames, rebuilt only when visibility/projection/draw-in changes.
    if (this._restGroupsDirty || !this._restGroupsCache) {
      const restGroups = new Map();
      this._tracks.forEach(t => {
        const st = this._state.get(t.key);
        if (!st.visible) return;
        this._collectSegments(t, st, restGroups);
      });
      this._restGroupsCache = restGroups;
      this._restGroupsDirty = false;
    }
    const restAlpha = 0.72 - (0.72 - 0.10) * this._dimBlend.value;
    this._strokeGroups(this._restGroupsCache, restAlpha, this._baseWidth);

    // Hover overlay: real per-bucket density colour, eased in on top of
    // the base pass so a repeat-heavy stretch still reads hot.
    this._hoverFades.forEach((entry, key) => {
      if (entry.value <= 0.001) return;
      const t = this._trackByKey.get(key);
      const st = this._state.get(key);
      if (!t || !st || !st.visible) return;
      const hoverGroups = new Map();
      this._collectSegments(t, st, hoverGroups);
      const width = this._baseWidth + (this._hoverWidth - this._baseWidth) * entry.value;
      this._strokeGroups(hoverGroups, entry.value, width);
    });

    // Select overlay: flat accent colour, distinct from the density heatmap.
    this._selectFades.forEach((entry, key) => {
      if (entry.value <= 0.001) return;
      const t = this._trackByKey.get(key);
      const st = this._state.get(key);
      if (!t || !st || !st.visible) return;
      this._drawSelected(t, st, entry.value);
    });
  },

  // Advances eased values toward their targets and redraws, rescheduling
  // itself via rAF until everything's converged.
  _tick() {
    let animating = false;

    const dimDiff = this._dimBlend.target - this._dimBlend.value;
    if (Math.abs(dimDiff) < 0.003) this._dimBlend.value = this._dimBlend.target;
    else { this._dimBlend.value += dimDiff * 0.16; animating = true; }

    if (this._easeFades(this._hoverFades, 0.26)) animating = true;
    if (this._easeFades(this._selectFades, 0.2)) animating = true;

    this._draw();
    if (animating) requestAnimationFrame(() => this._tick());
    else this._animating = false;
  },

  _easeFades(map, factor) {
    let animating = false;
    map.forEach((entry, key) => {
      const diff = entry.target - entry.value;
      if (Math.abs(diff) < 0.004) {
        entry.value = entry.target;
        if (entry.target === 0) map.delete(key);
      } else {
        entry.value += diff * factor;
        animating = true;
      }
    });
    return animating;
  },

  _ensureAnimating() {
    if (this._animating) return;
    this._animating = true;
    requestAnimationFrame(() => this._tick());
  },

  _collectSegments(t, st, groups) {
    const n = t.coords.length;
    if (n < 2) return;
    const drawUpTo = Math.max(2, Math.floor(n * st.drawProgress));
    const px = t._px, buckets = t.pointBucket, segKey = t._segKey;

    for (let i = 0; i < drawUpTo - 1; i++) {
      const key = segKey[i];
      let g = groups.get(key);
      if (!g) groups.set(key, g = { category: t.category, bucket: buckets[i], segs: [] });
      g.segs.push(px[i * 2], px[i * 2 + 1], px[(i + 1) * 2], px[(i + 1) * 2 + 1]);
    }
  },

  _strokeGroups(groups, alpha, baseWidth) {
    if (groups.size === 0) return;
    const ctx = this._ctx;
    ctx.globalAlpha = alpha;
    const ordered = [...groups.values()].sort((a, b) => a.bucket - b.bucket);
    ordered.forEach(g => {
      ctx.strokeStyle = this._colorTable[g.category][g.bucket];
      ctx.lineWidth = baseWidth + (g.bucket / (this._buckets - 1)) * 1.6;
      ctx.beginPath();
      const segs = g.segs;
      for (let i = 0; i < segs.length; i += 4) {
        ctx.moveTo(segs[i], segs[i + 1]);
        ctx.lineTo(segs[i + 2], segs[i + 3]);
      }
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
  },

  // Flat accent colour (not density-coloured) — a deliberate "this one is
  // chosen" signal. `value` (0..1, eased) drives both opacity and width.
  _drawSelected(t, st, value) {
    const n = t.coords.length;
    if (n < 2) return;
    const ctx = this._ctx;
    const px = t._px;
    const drawUpTo = Math.max(2, Math.floor(n * st.drawProgress));

    ctx.globalAlpha = value;
    ctx.strokeStyle = '#c44535';
    ctx.lineWidth = this._baseWidth + (this._selectedWidth - this._baseWidth) * value;
    ctx.beginPath();
    for (let i = 0; i < drawUpTo; i++) {
      i === 0 ? ctx.moveTo(px[i * 2], px[i * 2 + 1]) : ctx.lineTo(px[i * 2], px[i * 2 + 1]);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  },

  // ── Public API ────────────────────────────────────────────

  setVisible(key, visible) {
    const st = this._state.get(key);
    if (st && st.visible !== visible) {
      st.visible = visible;
      this._restGroupsDirty = true;
    }
  },

  setDim() {}, // legacy no-op — dimming is now the single _dimBlend scalar

  setSelected(key) {
    if (this._selectedKey === key) return;
    if (this._selectedKey) this._fadeTo(this._selectFades, this._selectedKey, 0);
    this._selectedKey = key;
    if (key) this._fadeTo(this._selectFades, key, 1);
    this._dimBlend.target = key ? 1 : 0;
    this._ensureAnimating();
  },

  clearSelection() {
    if (!this._selectedKey) return;
    this._fadeTo(this._selectFades, this._selectedKey, 0);
    this._selectedKey = null;
    this._dimBlend.target = 0;
    this._ensureAnimating();
  },

  _fadeTo(map, key, target) {
    const entry = map.get(key) || { value: 0, target: 0 };
    entry.target = target;
    map.set(key, entry);
  },

  redraw() {
    this._draw();
  },

  // Full reposition + reproject, bypassing the moveend/zoomend/resize
  // events _reset() normally waits for — a safety net for after a
  // programmatic flyTo that doesn't cleanly settle.
  forceResync() {
    this._reset();
  },

  // Nearest track to a point, within `tolerance` px. Delegates to the pure
  // hitTestTracks() below (testable without a real Leaflet map) once the
  // container point is transformed into this layer's local coordinates.
  hitTest(containerPoint, tolerance = 10) {
    const layerPoint = this._map.containerPointToLayerPoint(containerPoint);
    const target = { x: layerPoint.x - this._origin.x, y: layerPoint.y - this._origin.y };
    return hitTestTracks(target, this._tracks, key => this._state.get(key).visible, tolerance);
  },

  // True if the hover target changed; redraw is driven by the fade loop, not the caller.
  setHover(key) {
    if (this._hoverKey === key) return false;
    if (this._hoverKey) this._fadeTo(this._hoverFades, this._hoverKey, 0);
    this._hoverKey = key;
    if (key) this._fadeTo(this._hoverFades, key, 1);
    this._ensureAnimating();
    return true;
  },

  // Animates every visible track's draw-in 0->1, oldest first (caller
  // pre-sorts tracks by date).
  playDrawIn(durationMs = 2200) {
    const start = performance.now();
    const keys = this._tracks.map(t => t.key);
    keys.forEach(k => { this._state.get(k).drawProgress = 0; });
    // Synchronous, not just inside step() — a redraw() sandwiched between
    // this line and the first rAF tick would otherwise flash the full map
    // for a frame before snapping to empty.
    this._restGroupsDirty = true;

    // Rendered at a capped ~30fps rather than every rAF tick: a CPU/timeline
    // profile of this exact animation showed the main-thread "Commit" (the
    // canvas rasterize + hand-off to the compositor) as by far the largest
    // single cost of the whole page load — far more than the JS above it —
    // and that cost is paid once per _draw() call. Progress is still driven
    // by real elapsed time, so the animation's duration and easing are
    // unchanged; only how often the (expensive) frame is actually committed
    // drops, which halves that cost with no perceptible difference at 2.2s.
    const minFrameMs = 1000 / 30;
    let lastDraw = -Infinity;
    const step = (now) => {
      const elapsed = now - start;
      const overallT = Math.min(1, elapsed / durationMs);
      const isLast = overallT >= 1;
      if (isLast || now - lastDraw >= minFrameMs) {
        lastDraw = now;
        keys.forEach((k, i) => {
          const trackStart = (i / keys.length) * 0.7;
          const trackDur = 0.3;
          const local = Math.min(1, Math.max(0, (overallT - trackStart) / trackDur));
          this._state.get(k).drawProgress = local;
        });
        this._restGroupsDirty = true;
        this._draw();
      }
      if (!isLast) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  },

  getPixelForLatLng(latlng) {
    const p = this._map.latLngToLayerPoint(latlng);
    return { x: p.x - this._origin.x, y: p.y - this._origin.y };
  },
});

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Pure hit-test core, extracted from TrackLayer.hitTest() above so it's
// testable without a real Leaflet map: given a target point already in
// layer-local coordinates and a list of tracks carrying pre-computed
// _px/_bbox (see _reset()/buildDensityIndex), finds the closest track
// within tolerance. Rejects on cached bbox first so a mouse move over
// empty map doesn't walk every segment of every track.
function hitTestTracks(target, tracks, isVisible, tolerance) {
  let best = null, bestDist = tolerance;
  tracks.forEach(t => {
    if (!isVisible(t.key)) return;
    const b = t._bbox;
    if (!b) return;
    if (target.x < b.minX - tolerance || target.x > b.maxX + tolerance ||
        target.y < b.minY - tolerance || target.y > b.maxY + tolerance) return;

    const px = t._px;
    for (let i = 0; i < t.coords.length - 1; i++) {
      const d = distToSegment(target.x, target.y, px[i * 2], px[i * 2 + 1], px[(i + 1) * 2], px[(i + 1) * 2 + 1]);
      if (d < bestDist) { bestDist = d; best = t.key; }
    }
  });
  return best;
}

function createTrackLayer(options) {
  return new TrackLayer(options);
}

// ── 3. Continuous density colour (diagnostics only) ──────────
// freqColorForType() (config.js) is a 5-stop ramp that saturates hard on
// real repeat counts (routes done up to 62x); this exact-frequency
// version is for a legend swatch or similar, never called by TrackLayer.
function makeContinuousColorFn(tracks) {
  const maxByCategory = {};
  tracks.forEach(t => {
    const m = t._maxFreq ?? maxOf(t.pointFreq);
    if (!maxByCategory[t.category] || m > maxByCategory[t.category]) maxByCategory[t.category] = m;
  });

  return function colorForFreq(category, freq) {
    const cfg = typeForCategory(category);
    const stops = cfg.freqColors;
    const maxF = Math.max(2, maxByCategory[category] || 1);
    if (freq <= 1) return stops[0];
    const t = Math.log(freq) / Math.log(maxF);
    const scaled = t * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(scaled));
    const localT = scaled - i;
    return lerpColor(stops[i], stops[i + 1], localT);
  };
}

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map(c => Math.round(c).toString(16).padStart(2, '0')).join('');
}
function lerpColor(hexA, hexB, t) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  return rgbToHex(a.map((v, i) => v + (b[i] - v) * t));
}

// Node-only export for the test suite (tests/js/) — a no-op in the browser,
// where this file loads as a plain <script> and `module` is undefined.
// Only the pure, Leaflet-independent helpers are exported; TrackLayer
// itself extends L.Layer and needs a real Leaflet + DOM environment.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    distToSegment, hitTestTracks, cellSizeDeg, cellKey, maxOf, bucketForFreq,
    hexToRgb, rgbToHex, lerpColor,
  };
}
