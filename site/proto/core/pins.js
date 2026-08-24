// ── Start-of-trail pins ─────────────────────────────────────
// A marker at each trail's starting point — one plain Leaflet marker per
// track (~390), toggled with setVisible() rather than torn down and
// rebuilt on every filter change.

function pinSvg(color, size) {
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${Math.round(size * 1.4)}" viewBox="0 0 24 34">
      <path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 22 12 22s12-13 12-22C24 5.4 18.6 0 12 0z"
            fill="${color}" stroke="#fff" stroke-width="2"/>
      <circle cx="12" cy="11" r="4.5" fill="#fff"/>
    </svg>`;
}

function pinIcon(color, size) {
  return L.divIcon({
    html: pinSvg(color, size),
    className: 'start-pin',
    iconSize: [size, Math.round(size * 1.4)],
    iconAnchor: [size / 2, Math.round(size * 1.4)],
    tooltipAnchor: [0, -Math.round(size * 1.4)],
  });
}

// Quiet baseline opacity — ~390 pins at full strength reads as clutter;
// dimming keeps each one geographically exact while only the
// active/selected one actually draws the eye.
const PIN_REST_OPACITY = 0.6;
const PIN_REST_SIZE = 13;   // 20% up from the original 11
const PIN_ACTIVE_SIZE = 29; // 20% up from the original 24

class PinLayer {
  constructor(tracks, { colorForCategory, onClick } = {}) {
    this._tracks = tracks.filter(t => t.coords && t.coords.length > 0);
    this._colorForCategory = colorForCategory;
    this._onClick = onClick || (() => {});
    this._markers = new Map(); // key -> L.Marker
    this._activeKey = null;
  }

  addTo(map) {
    this._map = map;
    this._tracks.forEach(t => {
      const color = this._colorForCategory(t.category);
      const marker = L.marker(t.coords[0], { icon: pinIcon(color, PIN_REST_SIZE), opacity: PIN_REST_OPACITY, pane: 'overlayPane' });
      marker.bindTooltip(`
        <div style="font-size:13px;line-height:1.6">
          <strong>${t.name}</strong><br>
          ${t.distance_mi} mi &nbsp;·&nbsp; ${t.elev_gain_ft.toLocaleString()} ft gain<br>
          <span style="opacity:.6;font-size:11px">${t.date}</span>
        </div>`, { direction: 'top', offset: [0, -2], opacity: 1 });
      marker.on('click', () => this._onClick(t.key));
      marker._color = color;
      this._markers.set(t.key, marker);
      marker.addTo(map); // visibility toggled via show/hide below, not add/remove — cheaper
    });
    return this;
  }

  setVisible(key, visible) {
    const m = this._markers.get(key);
    if (!m) return;
    const el = m.getElement();
    if (el) el.style.display = visible ? '' : 'none';
  }

  setActive(key) {
    if (this._activeKey === key) return;
    if (this._activeKey) this._resetPin(this._activeKey);
    this._activeKey = key;
    if (!key) return;
    const m = this._markers.get(key);
    if (!m) return;
    m.setIcon(pinIcon(m._color, PIN_ACTIVE_SIZE));
    m.setOpacity(1);
    m.setZIndexOffset(1000);
  }

  clearActive() {
    if (!this._activeKey) return;
    this._resetPin(this._activeKey);
    this._activeKey = null;
  }

  _resetPin(key) {
    const m = this._markers.get(key);
    if (!m) return;
    m.setIcon(pinIcon(m._color, PIN_REST_SIZE));
    m.setOpacity(PIN_REST_OPACITY);
    m.setZIndexOffset(0);
  }

  // Dims every pin except the active one — mirrors TrackLayer's
  // selection dimming so pins and trails read as one coherent state.
  setDimOthers(dim, activeKey) {
    this._markers.forEach((m, k) => {
      if (k === activeKey) return;
      m.setOpacity(dim ? 0.22 : PIN_REST_OPACITY);
    });
  }
}

function createPinLayer(tracks, options) {
  return new PinLayer(tracks, options);
}
