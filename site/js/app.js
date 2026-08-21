
// ── State ─────────────────────────────────────────────────
let activities   = [];
let trails       = [];
let filtered     = [];
let polylineLayers = new Map();
let startMarkers   = [];
let selectedName = null;
let activeTypes  = new Set(Object.keys(ACTIVITY_TYPES));
const canvas     = L.canvas();
let els = {};

function fitPadding({ drawer = false } = {}) {
  const sidebarOpen = !document.body.classList.contains('sidebar-collapsed');
  return {
    paddingTopLeft:     [sidebarOpen ? 380 : 80, 60],
    paddingBottomRight: [60, drawer ? 260 : 60],
  };
}

// ── Map ───────────────────────────────────────────────────
const DEFAULT_CENTER  = [37.58, -122.05];
const DEFAULT_ZOOM    = 10.5;
const BAY_AREA_BOUNDS = L.latLngBounds([37.20, -122.60], [38.00, -121.70]);

const map = L.map('map', {
  scrollWheelZoom: false,
  zoomSnap: 0,
  zoomControl: true,
  minZoom: 2,
}).setView(DEFAULT_CENTER, DEFAULT_ZOOM);

const RecenterControl = L.Control.extend({
  options: { position: 'topleft' },
  onAdd() {
    const c = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-recenter');
    const a = L.DomUtil.create('a', '', c);
    a.href = '#'; a.title = 'Reset view';
    a.setAttribute('aria-label', 'Reset view');
    a.innerHTML = `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="10" cy="10" r="6"/><circle cx="10" cy="10" r="1.5" fill="currentColor"/>
      <line x1="10" y1="1.5" x2="10" y2="4"/><line x1="10" y1="16" x2="10" y2="18.5"/>
      <line x1="1.5" y1="10" x2="4" y2="10"/><line x1="16" y1="10" x2="18.5" y2="10"/>
    </svg>`;
    L.DomEvent.on(a, 'click', e => {
      L.DomEvent.preventDefault(e);
      if (selectedName) clearSelection();
      map.fitBounds(BAY_AREA_BOUNDS, { ...fitPadding(), animate: true });
    });
    L.DomEvent.disableClickPropagation(c);
    return c;
  },
});
new RecenterControl().addTo(map);

// Custom wheel zoom
;(function () {
  let zoomTarget = map.getZoom();
  let rafPending = false;
  let lastMouseEvent = null;
  window.addEventListener('wheel', e => {
    if (!map.getContainer().contains(e.target)) return;
    e.preventDefault();
    lastMouseEvent = e;
    const factor = e.ctrlKey ? 0.018 : 0.004;
    zoomTarget -= e.deltaY * factor;
    zoomTarget = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), zoomTarget));
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(() => {
        const point = map.mouseEventToContainerPoint(lastMouseEvent);
        map.setZoomAround(point, zoomTarget, { animate: false });
        rafPending = false;
      });
    }
  }, { passive: false, capture: true });
})();

// ── Init ──────────────────────────────────────────────────
async function init() {
  // Keep current map style (CartoDB Voyager) as requested
  L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png',
    { attribution: '&copy; <a href="https://carto.com">CARTO</a> &copy; OpenStreetMap', maxZoom: 20, subdomains: 'abcd' }
  ).addTo(map);
  L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png',
    { maxZoom: 20, subdomains: 'abcd', pane: 'overlayPane' }
  ).addTo(map);

  const params = new URLSearchParams(window.location.search);
  const typeParam = params.get('type');
  if (typeParam && ACTIVITY_TYPES[typeParam]) activeTypes = new Set([typeParam]);

  cacheEls();
  bindHandlers();

  let resizeTO;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTO);
    resizeTO = setTimeout(() => map.invalidateSize(), 150);
  });

  await loadActivities();
}

function cacheEls() {
  els.sidebarCountText = document.getElementById('sidebar-count-text');
  els.yearSeg          = document.getElementById('year-seg');
  els.typeList         = document.getElementById('type-list');
  els.activityList     = document.getElementById('activity-list');
}

function bindHandlers() {
  document.getElementById('activity-list').addEventListener('click', e => {
    const row = e.target.closest('[data-key]');
    if (row) selectTrail(row.dataset.key);
  });
  document.getElementById('type-list').addEventListener('click', e => {
    const row = e.target.closest('[data-type]');
    if (row) toggleType(row.dataset.type);
  });
  document.getElementById('year-seg').addEventListener('click', e => {
    const btn = e.target.closest('[data-year]');
    if (btn) onYearSegClick(btn.dataset.year);
  });
  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    document.body.classList.toggle('sidebar-collapsed');
    document.getElementById('sidebar').classList.toggle('collapsed');
    setTimeout(() => map.invalidateSize(), 300);
  });
}

// ── Year filter ───────────────────────────────────────────
let selectedYear = '';  // '' = all

function selectedYearVal() { return selectedYear; }

function activitiesForYear() {
  return selectedYear
    ? activities.filter(a => a.date.startsWith(selectedYear))
    : activities;
}

function isMapVisible(trail) {
  if (!activeTypes.has(trail.category)) return false;
  if (selectedYear && !trail.date.startsWith(selectedYear)) return false;
  return true;
}

function onYearSegClick(year) {
  selectedYear = year === 'ALL' ? '' : year;
  if (selectedName) clearSelection();
  renderYearSeg();
  applyFilters();
  renderMap();
}

function renderYearSeg() {
  const years = [...new Set(activities.map(a => a.date.slice(0, 4)))].sort().reverse();
  const seg = els.yearSeg;
  if (!seg) return;
  const cols = years.length + 1; // +1 for ALL
  seg.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  const items = [...years, 'ALL'];
  seg.innerHTML = items.map(y => {
    const isActive = (y === 'ALL' && selectedYear === '') || y === selectedYear;
    return `<button class="year-seg-btn ${isActive ? 'active' : ''}" data-year="${y}">${y}</button>`;
  }).join('');
}

function populateYearFilter() {
  renderYearSeg();
}

// ── Type filter ───────────────────────────────────────────
function renderTypeList() {
  const el = els.typeList;
  if (!el) return;

  const counts = {};
  activitiesForYear().forEach(a => { counts[a.category] = (counts[a.category] || 0) + 1; });

  el.innerHTML = Object.entries(ACTIVITY_TYPES).map(([key, cfg]) => {
    const count = counts[key] || 0;
    if (count === 0) return '';
    const on = activeTypes.has(key);
    const c  = cfg.color;
    return `<button class="type-row ${on ? 'active' : ''}" data-type="${key}"
      style="${on ? `border-color:${c};background:${c}1a` : ''}">
      <span class="type-dot" style="background:${c};box-shadow:${on ? `0 0 8px ${c}` : 'none'}"></span>
      <span class="type-icon">${cfg.icon}</span>
      <span class="type-name">${cfg.label}</span>
      <span class="type-count">${count}</span>
    </button>`;
  }).join('');
}

function toggleType(category) {
  const allKeys = Object.keys(ACTIVITY_TYPES);
  const allActive = allKeys.every(k => activeTypes.has(k));
  if (allActive) {
    activeTypes = new Set([category]);
  } else if (activeTypes.has(category)) {
    activeTypes.delete(category);
    if (activeTypes.size === 0) activeTypes = new Set(allKeys);
  } else {
    activeTypes.add(category);
  }
  renderTypeList();
  applyFilters();
  renderMap();
  updateSidebarCount();
}

// ── Data ──────────────────────────────────────────────────
async function loadActivities() {
  let data;
  try {
    const res = await fetch('/data/activities.json');
    if (!res.ok) throw new Error('no data');
    data = await res.json();
  } catch {
    els.activityList.innerHTML =
      '<li style="padding:1rem;color:var(--ink-3);font-size:13px;font-family:var(--mono)">No activities yet.</li>';
    return;
  }

  activities = data;
  trails = activities.map(a => ({
    key:          a.category + ':' + a.id,
    name:         a.name,
    id:           a.id,
    category:     a.category || 'Hike',
    distance_mi:  a.distance_mi,
    elev_gain_ft: a.elev_gain_ft,
    moving_time:  a.moving_time || 0,
    speed_mph:    a.speed_mph || 0,
    pace_min_mi:  a.pace_min_mi || 0,
    date:         a.date,
    coords:       a.coords,
  })).sort((a, b) => b.date.localeCompare(a.date));

  filtered = trails.filter(t => activeTypes.has(t.category));

  populateYearFilter();
  renderTypeList();
  renderSidebar();
  updateSidebarCount();
  renderMap();
  map.fitBounds(BAY_AREA_BOUNDS, fitPadding());
}

function updateSidebarCount() {
  const el = els.sidebarCountText;
  if (!el) return;
  const yearLabel = selectedYear ? ` · ${selectedYear}` : '';
  el.textContent = `${filtered.length} activities${yearLabel}`;
}

// ── Filters ───────────────────────────────────────────────
function applyFilters() {
  const query = (document.getElementById('search')?.value || '').trim().toLowerCase();
  filtered = trails.filter(t => {
    const matchType = activeTypes.has(t.category);
    const matchName = !query || t.name.toLowerCase().includes(query);
    const matchYear = !selectedYear || t.date.startsWith(selectedYear);
    return matchType && matchName && matchYear;
  });
  renderTypeList();
  renderSidebar();
  updateSidebarCount();
}

function resetFilters() {
  const search = document.getElementById('search');
  if (search) search.value = '';
  selectedYear = '';
  activeTypes  = new Set(Object.keys(ACTIVITY_TYPES));
  if (selectedName) clearSelection();
  renderYearSeg();
  renderTypeList();
  applyFilters();
  renderMap();
  map.fitBounds(BAY_AREA_BOUNDS, fitPadding());
}

// ── Mini route SVG (for sidebar) ──────────────────────────
function sidebarMiniRoute(coords, color, W = 56, H = 38) {
  if (!coords || coords.length < 2) {
    return `<svg width="${W}" height="${H}"><path d="M4,${H/2} Q${W*0.25},${H*0.25} ${W*0.5},${H/2} T${W-4},${H/2}"
      fill="none" stroke="${color}" stroke-width="1.3" stroke-linecap="round" opacity="0.5"/></svg>`;
  }
  const step = Math.max(1, Math.floor(coords.length / 30));
  const pts  = coords.filter((_, i) => i % step === 0);
  const lats = pts.map(([lat]) => lat);
  const lngs = pts.map(([, lng]) => lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const dLat = maxLat - minLat || 0.001, dLng = maxLng - minLng || 0.001;
  const pad  = 4;
  const scale = Math.min((W - pad*2) / dLng, (H - pad*2) / dLat);
  const offX  = (W - dLng * scale) / 2;
  const offY  = (H - dLat * scale) / 2;
  const svgPts = pts.map(([lat, lng]) => [
    (offX + (lng - minLng) * scale).toFixed(1),
    (H - offY - (lat - minLat) * scale).toFixed(1),
  ]);
  const d = svgPts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join(' ');
  return `<svg width="${W}" height="${H}" style="overflow:visible">
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${svgPts[0][0]}" cy="${svgPts[0][1]}" r="2" fill="${color}"/>
  </svg>`;
}

// ── Map rendering ─────────────────────────────────────────
function renderMap() {
  polylineLayers.forEach(({ glow, core }) => { map.removeLayer(glow); map.removeLayer(core); });
  polylineLayers.clear();
  startMarkers.forEach(m => map.removeLayer(m));
  startMarkers = [];

  trails.forEach(trail => {
    const visible = isMapVisible(trail);
    const latlngs = trail.coords.map(([lat, lng]) => [lat, lng]);
    const cfg     = typeForCategory(trail.category);
    const color   = cfg.color;
    const coreW   = 2.8;

    const glow = L.polyline(latlngs, { color, weight: coreW + 5, opacity: visible ? 0.08 : 0, renderer: canvas }).addTo(map);
    const core = L.polyline(latlngs, { color, weight: coreW, opacity: visible ? 0.55 : 0, renderer: canvas }).addTo(map);

    [glow, core].forEach(p => {
      p.on('mouseover', () => { if (selectedName !== trail.key && visible) core.setStyle({ opacity: 0.9, weight: coreW + 1 }); });
      p.on('mouseout',  () => { if (selectedName !== trail.key && visible) core.setStyle({ opacity: 0.55, weight: coreW }); });
      p.on('click',     () => { if (visible) selectTrail(trail.key); });
    });
    polylineLayers.set(trail.key, { glow, core, category: trail.category, coreW });

    if (visible && latlngs.length > 0) {
      const pinSvg = (c, size) => `
        <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${Math.round(size*1.4)}" viewBox="0 0 24 34">
          <path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 22 12 22s12-13 12-22C24 5.4 18.6 0 12 0z"
                fill="${c}" stroke="rgba(255,255,255,0.3)" stroke-width="1.5"/>
          <circle cx="12" cy="11" r="4.5" fill="rgba(255,255,255,0.9)"/>
        </svg>`;

      const icon = L.divIcon({
        html: pinSvg(color, 16),
        className: 'start-pin',
        iconSize: [16, 22], iconAnchor: [8, 22], tooltipAnchor: [0, -22],
      });

      const startPin = L.marker(latlngs[0], { icon, pane: 'overlayPane' }).addTo(map);
      startPin.bindTooltip(`
        <div style="font-size:13px;line-height:1.6;font-family:var(--body)">
          <strong>${trail.name}</strong><br>
          ${trail.distance_mi} mi &nbsp;·&nbsp; ${trail.elev_gain_ft.toLocaleString()} ft gain<br>
          <span style="color:var(--ink-3);font-size:11px;font-family:var(--mono)">${trail.date}</span>
        </div>`, { direction: 'top', offset: [0, 0], opacity: 1 });

      startPin._trailKey = trail.key;
      startPin._color    = color;
      startPin._pinSvg   = pinSvg;
      startPin.on('click', () => selectTrail(trail.key));
      startMarkers.push(startPin);
    }
  });
}

// ── Select ────────────────────────────────────────────────
function selectTrail(key) {
  if (selectedName === key) { clearSelection(); return; }
  selectedName = key;
  const trail = trails.find(t => t.key === key);
  if (!trail) return;
  const selColor = typeForCategory(trail.category).color;

  polylineLayers.forEach(({ glow, core, category: c, coreW }, k) => {
    const sel        = k === selectedName;
    const layerTrail = trails.find(t => t.key === k);
    const visible    = layerTrail && isMapVisible(layerTrail);
    if (!visible) return;
    const baseColor = typeForCategory(c).color;
    glow.setStyle({ opacity: sel ? 0.5 : 0.03, color: sel ? selColor : baseColor });
    core.setStyle({ opacity: sel ? 1.0 : 0.12, weight: sel ? coreW + 3 : coreW, color: sel ? selColor : baseColor });
  });

  const latlngs = trail.coords.map(([lat, lng]) => [lat, lng]);
  map.fitBounds(L.latLngBounds(latlngs), { ...fitPadding({ drawer: true }), maxZoom: 14 });

  startMarkers.forEach(m => {
    if (m._trailKey === key) {
      m.setIcon(L.divIcon({
        html: m._pinSvg(m._color, 22),
        className: 'start-pin start-pin-active',
        iconSize: [22, 31], iconAnchor: [11, 31], tooltipAnchor: [0, -31],
      }));
      m.setOpacity(1);
    } else {
      m.setOpacity(0.25);
    }
  });

  showDrawer(trail);
  renderSidebar();
}

function clearSelection() {
  selectedName = null;
  renderSidebar();
  hideDrawer();
  polylineLayers.forEach(({ glow, core, category, coreW }, key) => {
    const layerTrail = trails.find(t => t.key === key);
    const visible    = layerTrail && isMapVisible(layerTrail);
    const color      = typeForCategory(category).color;
    glow.setStyle({ opacity: visible ? 0.08 : 0, color });
    core.setStyle({ opacity: visible ? 0.55 : 0, weight: coreW, color });
  });
  startMarkers.forEach(m => {
    m.setIcon(L.divIcon({
      html: m._pinSvg(m._color, 16),
      className: 'start-pin',
      iconSize: [16, 22], iconAnchor: [8, 22], tooltipAnchor: [0, -22],
    }));
    m.setOpacity(1);
  });
}

// ── Drawer ────────────────────────────────────────────────
function showDrawer(trail) {
  const cfg   = typeForCategory(trail.category);
  const color = cfg.color;

  // Build metrics
  const metrics = [];
  cfg.stats.forEach(stat => {
    switch (stat) {
      case 'miles':     metrics.push({ label: 'Distance', val: trail.distance_mi, unit: 'mi' }); break;
      case 'elevation': metrics.push({ label: 'Elev Gain', val: trail.elev_gain_ft.toLocaleString(), unit: 'ft' }); break;
      case 'time':      metrics.push({ label: 'Time', val: formatTime(trail.moving_time), unit: '' }); break;
      case 'speed':     metrics.push({ label: 'Avg Speed', val: trail.speed_mph > 0 ? trail.speed_mph.toFixed(1) : '--', unit: 'mph' }); break;
      case 'pace':      metrics.push({ label: 'Avg Pace', val: formatPace(trail.pace_min_mi), unit: '' }); break;
    }
  });

  const metricCols = metrics.length + 1; // +1 for elev chart column

  document.getElementById('drawer-content').innerHTML = `
    <div class="drawer-header">
      <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0">
        <div class="drawer-badge" style="background:${color}22;border:1px solid ${color};box-shadow:0 0 14px ${color}55">
          <span style="font-size:17px">${cfg.icon}</span>
        </div>
        <div class="drawer-title-block">
          <div class="drawer-title">
            <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${trail.name}</span>
            <span class="drawer-type-chip" style="background:${color};color:#0e1320">${cfg.label}</span>
          </div>
          <div class="drawer-meta">
            <span>${trail.date}</span>
            ${trail.moving_time ? `<span>${formatTime(trail.moving_time)}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="drawer-actions">
        <div class="drawer-action-btn" title="Close" onclick="clearSelection()">✕</div>
      </div>
    </div>

    <div class="drawer-metrics" style="grid-template-columns:repeat(${metrics.length},1fr)">
      ${metrics.map(m => `
        <div class="drawer-metric">
          <div class="drawer-metric-label">${m.label}</div>
          <div class="drawer-metric-value">${m.val}<span class="drawer-metric-unit">${m.unit}</span></div>
        </div>`).join('')}
    </div>

    <div class="drawer-elev-section">
      <div class="drawer-elev-header">
        <span class="drawer-elev-label">elevation</span>
        <span class="drawer-elev-peaks" id="elev-peaks">loading…</span>
      </div>
      <div id="elev-chart-wrap">
        <canvas id="elev-chart"></canvas>
      </div>
    </div>`;

  document.getElementById('drawer-wrap').classList.add('open');
  document.body.classList.add('drawer-open');
  loadElevationProfile(trail.id, trail.category);
}

let elevProfile = null;
let elevMarker  = null;

function removeElevMarker() {
  if (elevMarker) { map.removeLayer(elevMarker); elevMarker = null; }
}

async function loadElevationProfile(activityId, category) {
  elevProfile = null;
  removeElevMarker();

  const chartCanvas = document.getElementById('elev-chart');
  if (!chartCanvas) return;
  const ctx  = chartCanvas.getContext('2d');
  const wrap = document.getElementById('elev-chart-wrap');
  const dpr  = window.devicePixelRatio || 1;
  chartCanvas.width  = wrap.clientWidth  * dpr;
  chartCanvas.height = wrap.clientHeight * dpr;
  ctx.scale(dpr, dpr);
  const W = wrap.clientWidth, H = wrap.clientHeight;

  const cfg = typeForCategory(category);

  ctx.fillStyle = 'var(--ink-3)';
  ctx.font = '11px Inter, sans-serif';
  ctx.fillText('Loading elevation…', 8, H / 2);

  try {
    const res = await fetch(`/data/streams/${activityId}.json`);
    if (!res.ok) throw new Error('no stream');
    const { distance, altitude, latlng } = await res.json();
    if (!distance.length || !altitude.length) throw new Error('empty');

    const distMi  = distance.map(d => d / 1609.34);
    const elevFt  = altitude.map(a => a * 3.28084);
    const latlngs = latlng || [];
    const maxDist = distMi[distMi.length - 1];
    const minElev = Math.min(...elevFt), maxElev = Math.max(...elevFt);
    const elevRange = maxElev - minElev || 1;

    const padL = 44, padR = 12, padT = 6, padB = 22;
    const cW = W - padL - padR, cH = H - padT - padB;

    elevProfile = { distMi, elevFt, latlngs, maxDist, minElev, elevRange, padL, padR, padT, padB, cW, cH, W, H, cfg };

    // Update elev peaks
    const peaksEl = document.getElementById('elev-peaks');
    if (peaksEl) {
      peaksEl.innerHTML = `peak <strong>${Math.round(maxElev).toLocaleString()} ft</strong> · low <strong>${Math.round(minElev).toLocaleString()} ft</strong>`;
    }

    if (latlngs.length > 0) {
      const entry = polylineLayers.get(selectedName);
      if (entry) { entry.glow.setLatLngs(latlngs); entry.core.setLatLngs(latlngs); }
    }

    drawElevChart(ctx, dpr);
    chartCanvas.onmousemove  = e => handleElevHover(e, chartCanvas, ctx, dpr);
    chartCanvas.onmouseleave = () => { drawElevChart(ctx, dpr); removeElevMarker(); };
  } catch {
    ctx.clearRect(0, 0, W * dpr, H * dpr);
    ctx.fillStyle = '#8a8294';
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Elevation data unavailable', 8, H / 2);
  }
}

function drawElevChart(ctx, dpr) {
  if (!elevProfile) return;
  const { distMi, elevFt, maxDist, minElev, elevRange, padL, padT, padB, cW, cH, W, H, cfg } = elevProfile;

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = '#343c52';
  ctx.lineWidth   = 0.5;
  ctx.fillStyle   = '#8a8294';
  ctx.font        = '9px Inter, sans-serif';
  ctx.textAlign   = 'right';
  for (let i = 0; i <= 4; i++) {
    const y   = padT + cH - (i / 4) * cH;
    const val = Math.round(minElev + (i / 4) * elevRange);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + cW, y); ctx.stroke();
    ctx.fillText(`${val.toLocaleString()}`, padL - 5, y + 3);
  }
  ctx.textAlign = 'center';
  const xTicks = Math.min(5, Math.floor(maxDist));
  for (let i = 0; i <= xTicks; i++) {
    const val = (i / xTicks) * maxDist;
    ctx.fillText(`${val.toFixed(1)}`, padL + (i / xTicks) * cW, H - 4);
  }

  // Fill
  ctx.beginPath();
  ctx.moveTo(padL, padT + cH);
  for (let i = 0; i < distMi.length; i++) {
    const x = padL + (distMi[i] / maxDist) * cW;
    const y = padT + cH - ((elevFt[i] - minElev) / elevRange) * cH;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(padL + (distMi[distMi.length - 1] / maxDist) * cW, padT + cH);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, padT, 0, padT + cH);
  grad.addColorStop(0, cfg.chartColor + ' 0.22)');
  grad.addColorStop(1, cfg.chartColor + ' 0.03)');
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  for (let i = 0; i < distMi.length; i++) {
    const x = padL + (distMi[i] / maxDist) * cW;
    const y = padT + cH - ((elevFt[i] - minElev) / elevRange) * cH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = cfg.color;
  ctx.lineWidth   = 1.5;
  ctx.stroke();

  ctx.restore();
}

function handleElevHover(e, chartCanvas, ctx, dpr) {
  if (!elevProfile || !elevProfile.latlngs.length) return;
  const { distMi, elevFt, latlngs, maxDist, minElev, elevRange, padL, padT, cW, cH, H, cfg } = elevProfile;

  const rect       = chartCanvas.getBoundingClientRect();
  const mx         = e.clientX - rect.left;
  const distAtMouse = ((mx - padL) / cW) * maxDist;
  if (distAtMouse < 0 || distAtMouse > maxDist) { removeElevMarker(); return; }

  let idx = 0;
  for (let i = 1; i < distMi.length; i++) {
    if (Math.abs(distMi[i] - distAtMouse) < Math.abs(distMi[idx] - distAtMouse)) idx = i;
  }

  const elev   = elevFt[idx];
  const dist   = distMi[idx];
  const chartX = padL + (dist / maxDist) * cW;
  const chartY = padT + cH - ((elev - minElev) / elevRange) * cH;

  drawElevChart(ctx, dpr);

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.strokeStyle = cfg.color; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(chartX, padT); ctx.lineTo(chartX, padT + cH); ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath(); ctx.arc(chartX, chartY, 4, 0, Math.PI * 2);
  ctx.fillStyle = cfg.color; ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();

  const label = `${Math.round(elev).toLocaleString()} ft  ·  ${dist.toFixed(1)} mi`;
  ctx.font = '10px Inter, sans-serif';
  const tw = ctx.measureText(label).width + 12;
  const tx = Math.min(Math.max(chartX - tw / 2, padL), padL + cW - tw);
  const ty = chartY - 26;
  ctx.fillStyle = 'rgba(26, 32, 48, 0.92)';
  ctx.beginPath(); ctx.roundRect(tx, ty, tw, 18, 4); ctx.fill();
  ctx.fillStyle = '#f1e7d2'; ctx.textAlign = 'left';
  ctx.fillText(label, tx + 6, ty + 13);

  ctx.restore();

  if (idx < latlngs.length) {
    const [lat, lng] = latlngs[idx];
    if (!elevMarker) {
      elevMarker = L.circleMarker([lat, lng], {
        radius: 7, color: '#fff', fillColor: cfg.color,
        fillOpacity: 1, weight: 2.5, pane: 'overlayPane',
      }).addTo(map);
    } else {
      elevMarker.setLatLng([lat, lng]);
    }
  }
}

function hideDrawer() {
  document.getElementById('drawer-wrap').classList.remove('open');
  document.body.classList.remove('drawer-open');
  elevProfile = null;
  removeElevMarker();
}

// ── Sidebar list ──────────────────────────────────────────
function renderSidebar() {
  const list = els.activityList;
  if (!list) return;

  list.innerHTML = filtered.map(trail => {
    const cfg      = typeForCategory(trail.category);
    const color    = cfg.color;
    const isSel    = trail.key === selectedName;
    const routeSvg = sidebarMiniRoute(trail.coords, color);

    const selStyle = isSel
      ? `background:${color}1c;border-color:${color};box-shadow:0 0 14px ${color}40,inset 0 0 0 1px ${color}`
      : '';

    return `
      <li class="${isSel ? 'active' : ''}" style="${selStyle}" data-key="${trail.key}">
        <div class="mini-thumb">${routeSvg}</div>
        <div style="flex:1;min-width:0">
          <div class="mini-meta">
            <span class="mini-dot" style="background:${color};box-shadow:0 0 5px ${color}"></span>
            <span class="mini-date">${trail.date}</span>
          </div>
          <div class="mini-name">${trail.name}</div>
          <div class="mini-stats">${trail.distance_mi} mi · ↑${trail.elev_gain_ft.toLocaleString()}ft${trail.moving_time ? ' · ' + formatTime(trail.moving_time) : ''}</div>
        </div>
      </li>`;
  }).join('');
}

init();
