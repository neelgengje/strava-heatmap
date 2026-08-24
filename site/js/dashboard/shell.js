// ── Shared dashboard shell ──────────────────────────────────
// Map bootstrapping, filter state, selection, and hover. Each
// prototype builds its own DOM/CSS and wires it to a Dashboard
// instance via the callbacks below.

const TILE_THEMES = {
  light: {
    base:   'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png',
    labels: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png',
  },
  dark: {
    base:   'https://{s}.basemaps.cartocdn.com/rastertiles/dark_nolabels/{z}/{x}/{y}{r}.png',
    labels: 'https://{s}.basemaps.cartocdn.com/rastertiles/dark_only_labels/{z}/{x}/{y}{r}.png',
  },
};

class Dashboard {
  constructor({ mapElId, tileTheme = 'light', controlsPosition = 'topright', onFiltersChange, onSelect, onDeselect, onHover, onDataLoaded }) {
    this.mapElId = mapElId;
    this.tileTheme = TILE_THEMES[tileTheme] || TILE_THEMES.light;
    this.controlsPosition = controlsPosition;
    this.onFiltersChange = onFiltersChange || (() => {});
    this.onSelect = onSelect || (() => {});
    this.onDeselect = onDeselect || (() => {});
    this.onHover = onHover || (() => {});
    this.onDataLoaded = onDataLoaded || (() => {});

    this.activeSports = null;      // Set, filled once data loads
    this.activeYears = new Set();  // empty = no year filter
    this.selectedKey = null;
  }

  async init() {
    this.map = L.map(this.mapElId, {
      scrollWheelZoom: false,
      zoomSnap: 0,
      zoomControl: false,
      minZoom: 3,
    });

    this._baseTileLayer = L.tileLayer(
      this.tileTheme.base,
      { maxZoom: 20, subdomains: 'abcd' }
    ).addTo(this.map);

    this._bindWheelZoom();

    const { tracks, colorTable, buckets, months, years, yearTotals } = await loadTrailData();
    this.tracks = tracks;
    this.months = months;
    this.years = years;
    this.yearTotals = yearTotals;
    this.byKey = new Map(tracks.map(t => [t.key, t]));

    this.activeSports = new Set(); // empty = no filter, same convention as activeYears
    this.sportTotals = new Map();
    tracks.forEach(t => this.sportTotals.set(t.category, (this.sportTotals.get(t.category) || 0) + 1));

    this.layer = createTrackLayer({ tracks, colorTable, buckets });
    this.layer.addTo(this.map);

    this.pins = createPinLayer(tracks, {
      colorForCategory: cat => typeForCategory(cat).color,
      onClick: key => this.select(key),
    });
    this.pins.addTo(this.map);

    // Added after the track layer/pins so place-name labels stay legible over dense trail clusters.
    this._labelsTileLayer = L.tileLayer(
      this.tileTheme.labels,
      { maxZoom: 20, subdomains: 'abcd', pane: 'overlayPane' }
    ).addTo(this.map);

    this._addMapControls();

    const bounds = boundsForTracks();
    this._homeBounds = bounds;
    // Occlusion-aware padding, not flat [80,80]: the drawer covers part of the
    // container, so symmetric padding would center content off to one side.
    this.map.fitBounds(bounds, this._occlusionPadding());

    this.map.on('click', e => {
      const key = this.layer.hitTest(this.map.latLngToContainerPoint(e.latlng), 10);
      if (key) this.select(key); else this.deselect();
    });
    this.map.on('mousemove', e => {
      if (this.selectedKey) return;
      const key = this.layer.hitTest(this.map.latLngToContainerPoint(e.latlng), 10);
      const changed = this.layer.setHover(key);
      if (changed) this.layer.redraw();
      const container = this.map.getContainer().getBoundingClientRect();
      this.onHover(key ? this.byKey.get(key) : null, {
        x: e.originalEvent.clientX - container.left,
        y: e.originalEvent.clientY - container.top,
      });
    });

    this.onDataLoaded({ tracks, months, years, yearTotals });
    // Non-silent, after onDataLoaded: callers build their DOM there, and
    // onFiltersChange is what populates it with real numbers.
    this._applyFilters();
  }

  // Zoom + recenter controls on the map itself. Default corner is top-right;
  // pass controlsPosition to the constructor for a layout where bottom-left
  // is the one clear of the drawer/detail panel.
  _addMapControls() {
    L.control.zoom({ position: this.controlsPosition }).addTo(this.map);

    const dash = this;
    const RecenterControl = L.Control.extend({
      options: { position: this.controlsPosition },
      onAdd() {
        const c = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-recenter');
        const a = L.DomUtil.create('a', '', c);
        a.href = '#';
        a.title = 'Reset view';
        a.setAttribute('aria-label', 'Reset view');
        a.innerHTML = `
          <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="10" cy="10" r="6"/><circle cx="10" cy="10" r="1.4" fill="currentColor"/>
            <line x1="10" y1="1.5" x2="10" y2="4"/><line x1="10" y1="16" x2="10" y2="18.5"/>
            <line x1="1.5" y1="10" x2="4" y2="10"/><line x1="16" y1="10" x2="18.5" y2="10"/>
          </svg>`;
        L.DomEvent.on(a, 'click', e => { L.DomEvent.preventDefault(e); dash.resetView(); });
        L.DomEvent.disableClickPropagation(c);
        return c;
      },
    });
    new RecenterControl().addTo(this.map);
  }

  _bindWheelZoom() {
    const map = this.map;
    let zoomTarget = null;
    let rafPending = false;
    let lastEvt = null;
    map.whenReady(() => { zoomTarget = map.getZoom(); });

    // Resync whenever something else moves the map (flyTo, pinch-zoom via
    // ctrlKey+wheel) — otherwise the next scroll starts from a stale value
    // and the map visibly snaps back before continuing to zoom.
    map.on('zoomend', () => { zoomTarget = map.getZoom(); });

    window.addEventListener('wheel', e => {
      if (!map.getContainer().contains(e.target)) return;
      e.preventDefault();
      if (zoomTarget == null) zoomTarget = map.getZoom();
      lastEvt = e;
      const factor = e.ctrlKey ? 0.018 : 0.004;
      zoomTarget -= e.deltaY * factor;
      zoomTarget = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), zoomTarget));
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(() => {
          const point = map.mouseEventToContainerPoint(lastEvt);
          map.setZoomAround(point, zoomTarget, { animate: false });
          rafPending = false;
        });
      }
    }, { passive: false, capture: true });
  }

  // ── Filters ─────────────────────────────────────────────
  // Empty set = all sports shown, same convention as toggleYear below.
  toggleSport(category) {
    if (this.activeSports.has(category)) this.activeSports.delete(category);
    else this.activeSports.add(category);
    this._applyFilters();
  }

  clearSportFilter() {
    this.activeSports = new Set();
    this._applyFilters();
  }

  // Empty set = no year filter (show all).
  toggleYear(year) {
    if (this.activeYears.has(year)) this.activeYears.delete(year);
    else this.activeYears.add(year);
    this._applyFilters();
  }

  clearYearFilter() {
    this.activeYears = new Set();
    this._applyFilters();
  }

  clearAllFilters() {
    this.activeSports = new Set();
    this.activeYears = new Set();
    this._applyFilters();
  }

  isTrackVisible(t) {
    if (this.activeSports.size > 0 && !this.activeSports.has(t.category)) return false;
    if (this.activeYears.size > 0 && !this.activeYears.has(t.year)) return false;
    return true;
  }

  _applyFilters(silent = false) {
    // A filter change that hides the current selection must deselect first,
    // rather than leaving the "dim everything but selection" state stale.
    if (this.selectedKey && !this.isTrackVisible(this.byKey.get(this.selectedKey))) {
      this.deselect();
      return;
    }

    this.tracks.forEach(t => {
      const v = this.isTrackVisible(t);
      this.layer.setVisible(t.key, v);
      this.pins.setVisible(t.key, v);
    });
    this.layer.redraw();
    if (!silent) {
      const visible = this.tracks.filter(t => this.isTrackVisible(t));
      this.onFiltersChange(visible, statsFor(visible));
    }
  }

  visibleTracks() {
    return this.tracks.filter(t => this.isTrackVisible(t));
  }

  // ── Selection ───────────────────────────────────────────
  select(key) {
    const t = this.byKey.get(key);
    if (!t) return;
    this.selectedKey = key;
    this.layer.setHover(null);
    this.layer.setSelected(key);
    this.pins.setActive(key);
    this.pins.setDimOthers(true, key);

    const bounds = L.latLngBounds(t.coords);
    const pad = this._occlusionPadding();
    // maxZoom 17 (not a lower cap): a 1-2mi loop needs a much closer fit
    // than an 11mi point-to-point trail to read clearly.
    this._flyToBoundsSafely(bounds, { ...pad, maxZoom: 17 }, 0.9);

    this.onSelect(t);
  }

  // A flyTo can start and then never fire moveend, leaving the canvas/pins
  // desynced and the map stuck short of its target. If moveend hasn't
  // fired within a generous window, stop it and snap to the bounds
  // instantly — a synchronous call that can't itself get stuck.
  _flyToBoundsSafely(bounds, fitOptions, durationSec) {
    this.map.flyToBounds(bounds, { ...fitOptions, duration: durationSec, easeLinearity: 0.25 });
    clearTimeout(this._settleTO);
    let settled = false;
    const onSettled = () => { settled = true; };
    this.map.once('moveend', onSettled);
    this._settleTO = setTimeout(() => {
      this.map.off('moveend', onSettled);
      if (settled) return;
      this.map.stop();
      this.map.fitBounds(bounds, { ...fitOptions, animate: false });
    }, durationSec * 1000 + 1000);
  }

  // Instant, not animated — used for the drawer-toggle recenter. An
  // animated move here can run long and end up racing the drawer's own
  // CSS slide, which is what reads as "map moves, then trail snaps".
  // Instant can't desync from anything since there's no animation to race.
  _setViewSafely(bounds, fitOptions) {
    this.map.fitBounds(bounds, { ...fitOptions, animate: false });
  }

  // Each layout publishes its own chrome footprint as --occlusion-* custom
  // properties (see v2-layout.css) rather than this file hardcoding one
  // layout's pixel geometry.
  _occlusionPadding() {
    const cs = getComputedStyle(document.body);
    const num = (name, fallback) => {
      const v = parseFloat(cs.getPropertyValue(name));
      return Number.isFinite(v) ? v : fallback;
    };
    return {
      paddingTopLeft: L.point(num('--occlusion-left', 100), num('--occlusion-top', 100)),
      paddingBottomRight: L.point(num('--occlusion-right', 100), num('--occlusion-bottom', 100)),
    };
  }

  // Re-centers into whatever space is currently free — call after
  // something changes how much of the map the chrome covers.
  refitToOcclusion() {
    const pad = this._occlusionPadding();
    if (this.selectedKey) {
      const t = this.byKey.get(this.selectedKey);
      if (t) this._setViewSafely(L.latLngBounds(t.coords), { ...pad, maxZoom: 17 });
    } else {
      this._setViewSafely(this._homeBounds, pad);
    }
  }

  deselect() {
    if (!this.selectedKey) return;
    this.selectedKey = null;
    this.layer.clearSelection();
    this.pins.clearActive();
    this.pins.setDimOthers(false, null);
    this._applyFilters();
    this.onDeselect();
  }

  resetView() {
    this.deselect();
    const pad = this._occlusionPadding();
    this._flyToBoundsSafely(this._homeBounds, pad, 0.8);
  }

  playDrawIn() {
    this.layer.playDrawIn(2200);
  }

}
