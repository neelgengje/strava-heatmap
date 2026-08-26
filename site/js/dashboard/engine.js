// ── Track Canvas Engine ─────────────────────────────────────
// Single canvas layer rendering every track, batched-stroked by (category,
// density bucket) — ~160 canvas calls per redraw instead of ~156,000.

// ── 1. Density index ─────────────────────────────────────────

const EARTH_R_LAT_M = 111320; // meters per degree latitude, ~constant
const DENSITY_BUCKETS = 16;

// Reference alpha the base pass is rasterized at when cached as a bitmap
// (see TrackLayer._draw()) — must match the highest restAlpha _draw() ever
// computes (dimBlend.value === 0) so every real restAlpha, always <= this,
// scales down from it rather than needing to scale up past opaque.
const BASE_REF_ALPHA = 0.72;

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

    // Offscreen bitmap the base pass is rasterized into once and reused
    // across fade frames (see _draw()) — created lazily in _reset() once a
    // canvas size is known. Bypassed during playDrawIn, whose geometry
    // changes every frame; see that method's own comment.
    this._baseCanvas = null;
    this._baseCtx = null;
    this._bypassBaseCache = false;
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
    //
    // All four are bound to _scheduleReset, not _reset directly: a discrete
    // (non-animated) view change — our own wheel-zoom handler in shell.js
    // calls setZoomAround(..., {animate:false}) once per rAF while the wheel
    // is active — routes through Leaflet's _resetView, which fires zoomend,
    // moveend, AND viewreset synchronously on every single call. Bound
    // directly to _reset, that's a full reproject-and-redraw of all ~86k
    // points three times per rendered frame for the whole gesture. Note
    // moveend isn't a reliable "the gesture is over" signal on its own here —
    // _resetView fires it on every call, animated or not — so it has to
    // share _scheduleReset's debounce with the other three rather than get
    // its own faster path, or a sustained wheel-zoom would still force a full
    // reset every frame via moveend alone. (This debounce is not what keeps
    // an in-flight zoom's CSS scale bounded, though — that's _onFlyMove's
    // own throttle below; see its comment for why those have to be two
    // different mechanisms.)
    map.on('moveend zoomend resize viewreset', this._scheduleReset, this);
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
    clearTimeout(this._resetTO);
    clearTimeout(this._flyMoveTO);
    map.off('moveend zoomend resize viewreset', this._scheduleReset, this);
    map.off('zoomanim', this._onZoomAnim, this);
    map.off('move', this._onFlyMove, this);
  },

  // Debounced trailing edge for the four discrete events above, not a
  // per-event or per-frame reset: a real _reset() reprojects and redraws
  // the whole dataset, so this waits until they actually stop for 120ms
  // before paying that cost, rather than once per event (moveend/zoomend/
  // viewreset all fire on every single _resetView() call — see onAdd's
  // comment). This is the fix for the reset-storm; it is deliberately NOT
  // also what bounds an in-flight zoom's blur — _onFlyMove's own throttle
  // handles that, and needs a different (throttle, not debounce) shape to
  // do it. Also catches 'resize', which _onFlyMove never sees (window
  // resize doesn't fire 'move').
  _scheduleReset() {
    clearTimeout(this._resetTO);
    this._resetTO = setTimeout(() => {
      this._resetTO = null;
      this._reset();
    }, 120);
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

    // Pure pan (zoom unchanged since the last real reset): the transform
    // above is already an exact identity-scale placement, so there's
    // nothing to reproject until the pan actually settles — which
    // _scheduleReset()'s debounce (bound to moveend below) already handles.
    // Skipping the throttle entirely here is what makes a pan free.
    if (map.getZoom() === this._resetZoom) return;

    // Zoom is actively changing (flyTo, wheel-zoom, pinch) — _resetZoom is
    // going stale as this keeps running, and the CSS scale above grows
    // with it. This must be a THROTTLE (arm-and-lock), not a debounce: a
    // debounce (tried here first, then reverted after review) never fires
    // until the whole gesture stops, since 'move' fires every frame for its
    // entire duration — leaving _resetZoom pinned at whatever zoom the
    // gesture started at. select()'s flyTo goes from the home view (~z11)
    // to maxZoom 17; getZoomScale(17, 11) is 2^6 = 64x, so a debounce here
    // renders every trail as a wildly blurred band for nearly the whole
    // ~0.9s flight before snapping sharp only once it's over. Firing once
    // per ~80ms and then re-arming instead keeps _resetZoom refreshed
    // regularly, bounding the drift to at most that much of the total zoom
    // change no matter how long the gesture runs — the original cadence
    // this had before _reset() was ever coalesced.
    if (this._flyMoveTO) return;
    this._flyMoveTO = setTimeout(() => {
      this._flyMoveTO = null;
      this._reset();
    }, 80);
  },

  // Repositions the canvas and reprojects every point. Called directly (not
  // through _scheduleReset) by onAdd's initial call and by forceResync()'s
  // safety net; clears any pending debounce so neither races a second reset
  // in shortly after.
  _reset() {
    clearTimeout(this._resetTO);
    this._resetTO = null;
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

    // Mirrors the main canvas's own device-pixel size/transform so the base
    // pass can be stroked into it once (in the same CSS-pixel coordinate
    // space _project()/_collectSegments already use) and later blitted back
    // wholesale — see _draw()'s base-pass comment. Resizing it here also
    // clears its old contents, which is correct: _restGroupsDirty is set
    // below regardless, so the next _draw() rebuilds it from scratch anyway.
    if (!this._baseCanvas) this._baseCanvas = document.createElement('canvas');
    this._baseCanvas.width = this._canvas.width;
    this._baseCanvas.height = this._canvas.height;
    this._baseCtx = this._baseCanvas.getContext('2d');
    this._baseCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Setting .width above resets every other piece of context state too,
    // not just the transform — without these, the base pass would rasterize
    // at the canvas default 'butt' cap. _strokeGroupsInto emits each segment
    // as its own moveTo/lineTo subpath, so round caps are what visually
    // joins consecutive segments of one track; missing them would show as a
    // notch at every vertex on a switchback-heavy trail.
    this._baseCtx.lineJoin = 'round';
    this._baseCtx.lineCap = 'round';

    this._origin = map.containerPointToLayerPoint([0, 0]);
    // Reference point/zoom for _onFlyMove's live scale-and-translate tracking
    // until the next reset.
    this._originLatLng = map.containerPointToLatLng([0, 0]);
    this._resetZoom = map.getZoom();
    this._project();
    // Rebuilt from the fresh projection above — see buildHitGrid()'s comment.
    // Culled to the viewport (plus the largest hitTest tolerance actually
    // used — 22px for a touch tap, see shell.js), same reasoning as _draw()'s
    // base-pass culling: hitTest() only ever queries a point on screen, so a
    // segment nowhere near the viewport can never be its nearest match.
    // Measured at ~2.8ms for the full unculled dataset, unconditionally, on
    // every reset — worth culling even though _reset() itself now runs far
    // less often than before Phase 1's debounce.
    const hitMargin = 22;
    this._hitGrid = buildHitGrid(
      this._tracks, HIT_GRID_CELL_PX,
      -hitMargin, -hitMargin, size.x + hitMargin, size.y + hitMargin
    );
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

    // Viewport for culling the base pass below, in the same layer-local
    // coordinate space as t._bbox/t._px (see _project()): the canvas's own
    // (0,0)-(size.x,size.y) rect. Padded by the widest a stroke can ever get
    // (selected width, plus a couple px for anti-aliasing) so a line whose
    // center sits just off-canvas doesn't have its visible edge clipped.
    const margin = this._selectedWidth + 2;
    const viewMinX = -margin, viewMinY = -margin, viewMaxX = size.x + margin, viewMaxY = size.y + margin;

    // Base pass: every visible track, batched by (category, bucket), stroked
    // ascending so hot segments paint over cold. Alpha is one shared
    // animated scalar (dimBlend); cached geometry is reused across a fade's
    // frames, rebuilt only when visibility/projection/draw-in changes.
    //
    // Measured against the real dataset (420 tracks/86k points): at typical
    // interaction zoom levels only 10-15% of segments are ever on screen —
    // rising to under 6% at the zoom level activity selection flies to — so
    // rejecting off-screen tracks/segments here is the single biggest win
    // available in this pass. _project() above still runs on every track
    // regardless (bbox/hitTest need it); only the collect+stroke work below
    // is skipped.
    const rebuildBase = this._restGroupsDirty || !this._restGroupsCache;
    if (rebuildBase) {
      const restGroups = new Map();
      this._tracks.forEach(t => {
        const st = this._state.get(t.key);
        if (!st.visible) return;
        const b = t._bbox;
        if (b && (b.maxX < viewMinX || b.minX > viewMaxX || b.maxY < viewMinY || b.minY > viewMaxY)) return;
        this._collectSegments(t, st, restGroups, viewMinX, viewMinY, viewMaxX, viewMaxY);
      });
      this._restGroupsCache = restGroups;
      this._restGroupsDirty = false;
    }
    const restAlpha = BASE_REF_ALPHA - (BASE_REF_ALPHA - 0.10) * this._dimBlend.value;

    // Hover/select fades (below) animate only this alpha over otherwise
    // fixed geometry — restAlpha is a constant BASE_REF_ALPHA through an
    // entire hover fade, so the base pass is byte-identical across all ~15 of its
    // frames yet was being fully re-stroked on every one. Rasterizing it
    // once into an offscreen bitmap at a fixed reference alpha and
    // compositing that with a scaled globalAlpha turns every fade frame
    // into one drawImage, independent of dataset size — but only while
    // rebuildBase tracks real geometry changes; playDrawIn changes geometry
    // every frame on purpose and bypasses this whole path (see its comment).
    if (this._bypassBaseCache) {
      this._strokeGroups(this._restGroupsCache, restAlpha, this._baseWidth);
    } else {
      if (rebuildBase) {
        this._baseCtx.clearRect(0, 0, size.x, size.y);
        this._strokeGroupsInto(this._baseCtx, this._restGroupsCache, BASE_REF_ALPHA, this._baseWidth);
      }
      if (this._restGroupsCache.size > 0) {
        // save/restore rather than tracking dpr separately: it captures and
        // later restores both the dpr transform _reset() set on this ctx
        // and globalAlpha in one shot. The transform is reset to identity
        // for the blit itself because the bitmap is already rasterized at
        // device-pixel size — drawing it through the dpr transform again
        // would double-scale it.
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = restAlpha / BASE_REF_ALPHA;
        ctx.drawImage(this._baseCanvas, 0, 0);
        ctx.restore();
      }
    }

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

  // The four viewMin/viewMax args are optional (undefined for the
  // hover/select overlays below, which touch one already-relevant track and
  // aren't worth culling) — when given, segments entirely outside that
  // rect are skipped rather than pushed into a group that would just get
  // stroked off-canvas.
  _collectSegments(t, st, groups, viewMinX, viewMinY, viewMaxX, viewMaxY) {
    const n = t.coords.length;
    if (n < 2) return;
    const drawUpTo = Math.max(2, Math.floor(n * st.drawProgress));
    const px = t._px, buckets = t.pointBucket, segKey = t._segKey;
    const cull = viewMinX !== undefined;

    for (let i = 0; i < drawUpTo - 1; i++) {
      const x1 = px[i * 2], y1 = px[i * 2 + 1], x2 = px[(i + 1) * 2], y2 = px[(i + 1) * 2 + 1];
      if (cull) {
        if ((x1 < viewMinX && x2 < viewMinX) || (x1 > viewMaxX && x2 > viewMaxX) ||
            (y1 < viewMinY && y2 < viewMinY) || (y1 > viewMaxY && y2 > viewMaxY)) continue;
      }
      const key = segKey[i];
      let g = groups.get(key);
      if (!g) groups.set(key, g = { category: t.category, bucket: buckets[i], segs: [] });
      g.segs.push(x1, y1, x2, y2);
    }
  },

  // Thin wrapper over _strokeGroupsInto targeting this layer's main ctx —
  // kept as its own method since the hover/select overlays below and the
  // playDrawIn bypass call it exactly as before the base-bitmap cache
  // existed. _draw()'s cached path calls _strokeGroupsInto directly to
  // target the offscreen _baseCtx instead.
  _strokeGroups(groups, alpha, baseWidth) {
    this._strokeGroupsInto(this._ctx, groups, alpha, baseWidth);
  },

  _strokeGroupsInto(ctx, groups, alpha, baseWidth) {
    if (groups.size === 0) return;
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

  // Full reposition + reproject, bypassing _scheduleReset's debounce and the
  // moveend/zoomend/resize/viewreset events that feed it — a safety net for
  // after a programmatic flyTo that doesn't cleanly settle.
  forceResync() {
    this._reset();
  },

  // Nearest track to a point, within `tolerance` px. Delegates to the pure
  // hitTestGrid() below (testable without a real Leaflet map) once the
  // container point is transformed into this layer's local coordinates.
  hitTest(containerPoint, tolerance = 10) {
    const layerPoint = this._map.containerPointToLayerPoint(containerPoint);
    const target = { x: layerPoint.x - this._origin.x, y: layerPoint.y - this._origin.y };
    return hitTestGrid(target, this._hitGrid, this._tracks, key => this._state.get(key).visible, tolerance);
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
    // This animation changes every track's geometry (drawProgress) every
    // frame on purpose, so caching a base-pass bitmap here would mean
    // rebuilding it every one of the ~66 frames below instead of today's
    // plain stroke — strictly worse than the cache existing at all. Bypass
    // it for the animation's duration; _draw() falls back to stroking
    // _restGroupsCache directly while this is set, exactly as it did before
    // that cache existed.
    this._bypassBaseCache = true;

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
        // Every track is fully drawn in by the last frame — safe to resume
        // caching the base pass from here on. Cleared before this frame's
        // _draw() call, not after, so that call is the one that builds the
        // fresh cache instead of stroking directly one more time.
        if (isLast) this._bypassBaseCache = false;
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
  // sqrt, not hypot: hypot's extra work (rescaling to guard against
  // overflow/underflow on huge or tiny inputs) is wasted on plain screen-
  // pixel coordinates, which never come close to either extreme, and it
  // measurably loses to a plain sqrt of the sum of squares for that case —
  // this runs per segment per mousemove, thousands of times in a dense
  // cluster.
  const ex = px - cx, ey = py - cy;
  return Math.sqrt(ex * ex + ey * ey);
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

// ── Hit-test grid ─────────────────────────────────────────────
// hitTestTracks() above is correct but walks every segment of every track
// whose cached bbox merely overlaps the cursor — measured at ~12,500
// segments per mousemove in the densest real cluster (Mission Peak, ~170
// overlapping bboxes). Bucketing segments into a uniform grid over
// layer-local pixel space turns that into "check the ~9 cells around the
// cursor." hitTestTracks() is kept as-is (and still exported) since it's
// simple and tested — this is an accelerated path alongside it, not a
// replacement.
const HIT_GRID_CELL_PX = 64;

// Same numeric-composite-key trick cellKey() above uses for lat/lng cells:
// one Map lookup on a plain number instead of a string. cy is offset by a
// half-stride so it stays a non-negative int (Map keys distinguish -0/0
// fine, but a negative multiplicand here could collide with a different
// (cx,cy) pair's stride the way a signed cLng could not for cellKey's much
// larger stride) — 5e4 is comfortably larger than any cy this layer's
// tracks (a fixed Bay Area bounding box, plus a handful of far-flung trips)
// ever produce at cellSize 64.
const HIT_GRID_STRIDE = 100000;
const HIT_GRID_Y_OFFSET = 50000;

function hitGridKey(cx, cy) {
  return cx * HIT_GRID_STRIDE + (cy + HIT_GRID_Y_OFFSET);
}

// Called once per _reset() (segments don't move until the next reproject),
// not per mousemove. Each segment is added to every cell its own small
// bounding box overlaps — almost always just one cell, since a segment is
// two consecutive GPS points and cellSize (64px) comfortably exceeds the
// gap between them at any zoom this app renders at.
//
// The four viewMin/viewMax args are optional (undefined skips culling
// entirely, e.g. for tests) — when given, a track is skipped via its cached
// bbox first (cheap, rejects most of the dataset at typical zoom levels —
// same reasoning as _draw()'s base-pass culling), and segments of a
// partially-overlapping track are culled individually the same way
// _collectSegments does. hitTest() only ever queries a point at or near the
// visible viewport, so a segment nowhere near it can never be its nearest
// match — measured at ~2.8ms to build unculled on the real dataset,
// unconditionally, on every reset.
function buildHitGrid(tracks, cellSize = HIT_GRID_CELL_PX, viewMinX, viewMinY, viewMaxX, viewMaxY) {
  const grid = new Map();
  const cull = viewMinX !== undefined;
  for (let ti = 0; ti < tracks.length; ti++) {
    const t = tracks[ti];
    const px = t._px;
    const n = t.coords.length;
    if (!px || n < 2) continue;
    if (cull) {
      const b = t._bbox;
      if (b && (b.maxX < viewMinX || b.minX > viewMaxX || b.maxY < viewMinY || b.minY > viewMaxY)) continue;
    }
    for (let i = 0; i < n - 1; i++) {
      const x1 = px[i * 2], y1 = px[i * 2 + 1], x2 = px[(i + 1) * 2], y2 = px[(i + 1) * 2 + 1];
      if (cull) {
        if ((x1 < viewMinX && x2 < viewMinX) || (x1 > viewMaxX && x2 > viewMaxX) ||
            (y1 < viewMinY && y2 < viewMinY) || (y1 > viewMaxY && y2 > viewMaxY)) continue;
      }
      const cx0 = Math.floor(Math.min(x1, x2) / cellSize), cx1 = Math.floor(Math.max(x1, x2) / cellSize);
      const cy0 = Math.floor(Math.min(y1, y2) / cellSize), cy1 = Math.floor(Math.max(y1, y2) / cellSize);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const key = hitGridKey(cx, cy);
          let bucket = grid.get(key);
          if (!bucket) grid.set(key, bucket = []);
          bucket.push(ti, i);
        }
      }
    }
  }
  return { grid, cellSize };
}

// Nearest track to `target` (layer-local pixel coords) within `tolerance`,
// using a grid from buildHitGrid() instead of every track's every segment.
// Checking only the 3x3 block of cells centered on the cursor is exact
// (not an approximation) as long as tolerance never exceeds cellSize — true
// here: tolerance tops out at 22px for a touch tap, cellSize defaults to
// 64px — because any segment closer than `tolerance` to a point inside the
// center cell must itself pass through the center cell or one of its
// 8 neighbors.
function hitTestGrid(target, hitGrid, tracks, isVisible, tolerance) {
  const { grid, cellSize } = hitGrid;
  const cx = Math.floor(target.x / cellSize), cy = Math.floor(target.y / cellSize);
  let best = null, bestDist = tolerance;
  // A segment can land in >1 cell (see buildHitGrid) and a long track can
  // put several segments in the same cell — dedupe (track, segment) pairs
  // so a neighboring cell doesn't re-test one already checked this call.
  const seen = new Set();
  for (let gx = cx - 1; gx <= cx + 1; gx++) {
    for (let gy = cy - 1; gy <= cy + 1; gy++) {
      const bucket = grid.get(hitGridKey(gx, gy));
      if (!bucket) continue;
      for (let k = 0; k < bucket.length; k += 2) {
        const ti = bucket[k], i = bucket[k + 1];
        const pairKey = ti * 1e6 + i; // segments-per-track never approaches 1e6
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);
        const t = tracks[ti];
        if (!isVisible(t.key)) continue;
        const px = t._px;
        const d = distToSegment(target.x, target.y, px[i * 2], px[i * 2 + 1], px[(i + 1) * 2], px[(i + 1) * 2 + 1]);
        if (d < bestDist) { bestDist = d; best = t.key; }
      }
    }
  }
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
    hexToRgb, rgbToHex, lerpColor, buildHitGrid, hitTestGrid,
  };
}
