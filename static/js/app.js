
// ── State ─────────────────────────────────────────────────
let activities   = [];   // raw from API
let trails       = [];   // deduplicated, aggregated
let filtered     = [];   // current filtered view
let polylineLayers = new Map(); // trail.key → { glow, core, category, coreW }
let startMarkers   = []; // start-of-trail pins
let selectedName = null;
let activeTypes  = new Set(Object.keys(ACTIVITY_TYPES));
const canvas     = L.canvas();
let els = {};   // cached DOM refs, populated by cacheEls()

// ── Map ───────────────────────────────────────────────────
const DEFAULT_CENTER = [37.58, -122.05];
const DEFAULT_ZOOM   = 10.5;
const map = L.map('map', {
  scrollWheelZoom: false,
  zoomSnap: 0,
  zoomControl: true,
  minZoom: 2,
}).setView(DEFAULT_CENTER, DEFAULT_ZOOM);

// Re-center control — sits below the +/− zoom buttons
const RecenterControl = L.Control.extend({
  options: { position: 'bottomleft' },
  onAdd() {
    const c = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-recenter');
    const a = L.DomUtil.create('a', '', c);
    a.href = '#';
    a.title = 'Reset view';
    a.setAttribute('aria-label', 'Reset view');
    a.innerHTML = `
      <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="10" cy="10" r="6"/><circle cx="10" cy="10" r="1.5" fill="currentColor"/>
        <line x1="10" y1="1.5" x2="10" y2="4"/><line x1="10" y1="16" x2="10" y2="18.5"/>
        <line x1="1.5" y1="10" x2="4" y2="10"/><line x1="16" y1="10" x2="18.5" y2="10"/>
      </svg>`;
    L.DomEvent.on(a, 'click', e => {
      L.DomEvent.preventDefault(e);
      if (selectedName) clearSelection();
      map.setView(DEFAULT_CENTER, DEFAULT_ZOOM, { animate: true });
    });
    L.DomEvent.disableClickPropagation(c);
    return c;
  },
});
new RecenterControl().addTo(map);

// Custom wheel zoom:
// - macOS trackpad pinch fires wheel with ctrlKey=true and tiny deltaY (~1-5px)
// - scroll wheel fires with ctrlKey=false and large deltaY (~100px)
;(function () {
  let zoomTarget = map.getZoom();
  let rafPending = false;
  let lastMouseEvent = null;

  window.addEventListener('wheel', e => {
    if (!map.getContainer().contains(e.target)) return;
    e.preventDefault();

    lastMouseEvent = e;
    const factor = e.ctrlKey ? 0.018 : 0.004;  // pinch vs scroll
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
  const res = await fetch('/api/config');
  const cfg = await res.json();

  L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png',
    { attribution: '&copy; <a href="https://carto.com">CARTO</a> &copy; OpenStreetMap', maxZoom: 20, subdomains: 'abcd' }
  ).addTo(map);
  // Add labels on top so trails render between base and labels
  L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}{r}.png',
    { maxZoom: 20, subdomains: 'abcd', pane: 'overlayPane' }
  ).addTo(map);

  // Check URL params for pre-selected type
  const params = new URLSearchParams(window.location.search);
  const typeParam = params.get('type');
  if (typeParam && ACTIVITY_TYPES[typeParam]) {
    activeTypes = new Set([typeParam]);
  }

  cacheEls();
  bindDelegatedHandlers();

  if (cfg.authenticated) {
    renderNavAuth(true);
    await loadActivities();
  } else {
    renderNavAuth(false);
    document.getElementById('connect-cta').style.display = 'flex';
  }
}

function cacheEls() {
  els.statCount      = document.getElementById('stat-count');
  els.statMiles      = document.getElementById('stat-miles');
  els.statElev       = document.getElementById('stat-elev');
  els.statCountLabel = document.getElementById('stat-count-label');
  els.timeStats      = document.getElementById('time-stats');
}

function bindDelegatedHandlers() {
  document.getElementById('type-filters').addEventListener('click', e => {
    const pill = e.target.closest('[data-type]');
    if (pill) toggleType(pill.dataset.type);
  });
  document.getElementById('activity-list').addEventListener('click', e => {
    const row = e.target.closest('[data-key]');
    if (row) selectTrail(row.dataset.key);
  });
}

// ── Nav Auth ─────────────────────────────────────────────
function renderNavAuth(authenticated) {
  const el = document.getElementById('nav-actions');
  if (authenticated) {
    el.innerHTML = `
      <button class="btn-primary" id="sync-btn" title="Click: incremental · Shift+Click: full resync">Sync</button>
      <a class="btn-outline" href="/auth/logout">Disconnect</a>`;
    document.getElementById('sync-btn').addEventListener('click',
      e => syncActivities({ full: e.shiftKey })
    );
  }
}

async function syncActivities(opts = {}) {
  const btn = document.getElementById('sync-btn');
  const full = !!opts.full;
  btn.textContent = full ? 'Full resync…' : 'Syncing…';
  btn.disabled = true;
  const res = await fetch('/api/activities/sync' + (full ? '?full=1' : ''));
  const data = await res.json().catch(() => ({}));
  btn.textContent = data.new === 0 ? 'Up to date' : `+${data.new} new`;
  setTimeout(() => { btn.textContent = 'Sync'; btn.disabled = false; }, 1800);
  await loadActivities();
}

// ── Type Filter Pills ────────────────────────────────────
function renderTypePills() {
  const el = document.getElementById('type-filters');
  // Count activities per category
  const counts = {};
  activities.forEach(a => {
    const cat = a.category || 'Hike';
    counts[cat] = (counts[cat] || 0) + 1;
  });

  el.innerHTML = Object.entries(ACTIVITY_TYPES).map(([key, cfg]) => {
    const count = counts[key] || 0;
    if (count === 0) return '';
    const active = activeTypes.has(key) ? 'active' : '';
    return `
      <button class="type-pill ${active}" data-type="${key}">
        ${cfg.icon} ${cfg.label} <span class="pill-count">${count}</span>
      </button>`;
  }).join('');
}

function toggleType(category) {
  // Clicking a pill solo-selects that type; clicking the already-solo type resets to all
  if (activeTypes.size === 1 && activeTypes.has(category)) {
    activeTypes = new Set(Object.keys(ACTIVITY_TYPES));
  } else {
    activeTypes = new Set([category]);
  }
  renderTypePills();
  applyFilters();
  renderMap();
  renderStats();
}

// ── Data ──────────────────────────────────────────────────
async function loadActivities() {
  const res = await fetch('/api/activities');
  if (!res.ok) return;
  activities = await res.json();

  // Each activity is its own trail entry — no deduplication.
  // Overlapping routes visually "heat up" through stacked polylines.
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

  renderTypePills();
  renderStats();
  populateYearFilter();
  renderSidebar();
  renderMap();

  document.getElementById('stats-bar').classList.remove('hidden');
  document.getElementById('controls').style.display  = 'flex';
  document.getElementById('connect-cta').style.display = 'none';
}

// ── Stats ─────────────────────────────────────────────────
function renderStats() {
  const active = activities.filter(a => activeTypes.has(a.category || 'Hike'));
  const totalCount = active.length;
  const totalMiles = active.reduce((s, a) => s + a.distance_mi, 0);
  const totalElev  = active.reduce((s, a) => s + a.elev_gain_ft, 0);

  els.statCount.textContent = totalCount.toLocaleString();
  els.statMiles.textContent = Math.round(totalMiles).toLocaleString();
  els.statElev.textContent  = Math.round(totalElev / 1000) + 'K';

  // Dynamic count label
  const label = activeTypes.size === 1
    ? typeForCategory([...activeTypes][0]).label
    : 'Activities';
  els.statCountLabel.textContent = label;

  // Per-type time bars
  const timeLabels = { Hike: 'Hiking', Ride: 'Riding', Run: 'Running', TrailRun: 'Trail Runs' };
  const timeByCat = {};
  active.forEach(a => {
    const cat = a.category || 'Hike';
    timeByCat[cat] = (timeByCat[cat] || 0) + (a.moving_time || 0);
  });

  const cats = Object.keys(ACTIVITY_TYPES).filter(k => timeByCat[k] > 0);
  const maxSecs = Math.max(...cats.map(k => timeByCat[k]), 1);

  els.timeStats.innerHTML = cats.map(cat => {
    const secs = timeByCat[cat];
    const hrs = Math.round(secs / 3600);
    const display = `${hrs}h`;
    const pct = Math.round((secs / maxSecs) * 100);
    const color = typeForCategory(cat).color;
    return `
      <div class="time-bar-item">
        <span class="time-bar-label">${timeLabels[cat] || cat}</span>
        <div class="time-bar-wrap">
          <div class="time-bar-fill" style="width:${pct}%;background:${color}"></div>
        </div>
        <span class="time-bar-value">${display}</span>
      </div>`;
  }).join('');
}

// ── Year filter ───────────────────────────────────────────
function populateYearFilter() {
  const years = new Set();
  activities.forEach(a => years.add(a.date.slice(0, 4)));
  const sel = document.getElementById('year-filter');
  while (sel.options.length > 1) sel.remove(1);
  [...years].sort().reverse().forEach(y => {
    const opt = document.createElement('option');
    opt.value = y; opt.textContent = y;
    sel.appendChild(opt);
  });
}

function applyFilters() {
  const query = document.getElementById('search').value.trim().toLowerCase();
  const year  = document.getElementById('year-filter').value;

  filtered = trails.filter(t => {
    const matchType = activeTypes.has(t.category);
    const matchName = !query || t.name.toLowerCase().includes(query);
    const matchYear = !year  || t.date.startsWith(year);
    return matchType && matchName && matchYear;
  });

  renderSidebar();
}

// ── Map rendering ─────────────────────────────────────────
function renderMap() {
  polylineLayers.forEach(({ glow, core }) => { map.removeLayer(glow); map.removeLayer(core); });
  polylineLayers.clear();
  startMarkers.forEach(m => map.removeLayer(m));
  startMarkers = [];

  trails.forEach(trail => {
    const visible = activeTypes.has(trail.category);
    const latlngs = trail.coords.map(([lat, lng]) => [lat, lng]);
    const cfg     = typeForCategory(trail.category);
    const color   = cfg.color;
    const coreW   = 2.8;

    // Semi-transparent lines — overlapping routes stack and intensify
    const glow = L.polyline(latlngs, {
      color, weight: coreW + 5, opacity: visible ? 0.08 : 0, renderer: canvas
    }).addTo(map);
    const core = L.polyline(latlngs, {
      color, weight: coreW, opacity: visible ? 0.55 : 0, renderer: canvas
    }).addTo(map);

    [glow, core].forEach(p => {
      p.on('mouseover', () => {
        if (selectedName !== trail.key && visible) core.setStyle({ opacity: 0.9, weight: coreW + 1 });
      });
      p.on('mouseout', () => {
        if (selectedName !== trail.key && visible) core.setStyle({ opacity: 0.55, weight: coreW });
      });
      p.on('click', () => { if (visible) selectTrail(trail.key); });
    });

    polylineLayers.set(trail.key, { glow, core, category: trail.category, coreW });

    // Start-of-trail pin (teardrop / map pin shape)
    if (visible && latlngs.length > 0) {
      const pinSvg = (c, size) => `
        <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${Math.round(size * 1.4)}" viewBox="0 0 24 34">
          <path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 22 12 22s12-13 12-22C24 5.4 18.6 0 12 0z"
                fill="${c}" stroke="#fff" stroke-width="2"/>
          <circle cx="12" cy="11" r="4.5" fill="#fff"/>
        </svg>`;

      const icon = L.divIcon({
        html: pinSvg(color, 16),
        className: 'start-pin',
        iconSize: [16, 22],
        iconAnchor: [8, 22],
        tooltipAnchor: [0, -22],
      });

      const startPin = L.marker(latlngs[0], { icon, pane: 'overlayPane' }).addTo(map);

      startPin.bindTooltip(`
        <div style="font-size:13px;line-height:1.6">
          <strong>${trail.name}</strong><br>
          ${trail.distance_mi} mi &nbsp;\u00b7&nbsp; ${trail.elev_gain_ft.toLocaleString()} ft gain<br>
          <span style="color:var(--text-3);font-size:11px">${trail.date}</span>
        </div>
      `, { direction: 'top', offset: [0, 0], opacity: 1 });

      startPin._trailKey = trail.key;
      startPin._color = color;
      startPin._pinSvg = pinSvg;
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
    const sel = k === selectedName;
    const visible = activeTypes.has(c);
    if (!visible) return;
    const baseColor = typeForCategory(c).color;
    glow.setStyle({ opacity: sel ? 0.5 : 0.03, color: sel ? selColor : baseColor });
    core.setStyle({ opacity: sel ? 1.0 : 0.12, weight: sel ? coreW + 3 : coreW, color: sel ? selColor : baseColor });
  });

  const latlngs = trail.coords.map(([lat, lng]) => [lat, lng]);
  // Extra bottom padding to account for the 210px drawer
  map.fitBounds(L.latLngBounds(latlngs), { paddingTopLeft: [60, 60], paddingBottomRight: [60, 240], maxZoom: 14 });

  // Highlight selected pin, dim others
  startMarkers.forEach(m => {
    if (m._trailKey === key) {
      m.setIcon(L.divIcon({
        html: m._pinSvg(m._color, 22),
        className: 'start-pin start-pin-active',
        iconSize: [22, 31],
        iconAnchor: [11, 31],
        tooltipAnchor: [0, -31],
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

  polylineLayers.forEach(({ glow, core, category, coreW }) => {
    const visible = activeTypes.has(category);
    const color = typeForCategory(category).color;
    glow.setStyle({ opacity: visible ? 0.08 : 0, color });
    core.setStyle({ opacity: visible ? 0.55 : 0, weight: coreW, color });
  });

  // Restore start pins to default size and opacity
  startMarkers.forEach(m => {
    m.setIcon(L.divIcon({
      html: m._pinSvg(m._color, 16),
      className: 'start-pin',
      iconSize: [16, 22],
      iconAnchor: [8, 22],
      tooltipAnchor: [0, -22],
    }));
    m.setOpacity(1);
  });
}

// ── Drawer ────────────────────────────────────────────────
function showDrawer(trail) {
  const cfg = typeForCategory(trail.category);

  let statsHtml = '';
  cfg.stats.forEach(stat => {
    let value, label;
    switch (stat) {
      case 'miles':
        value = trail.distance_mi; label = 'Miles'; break;
      case 'elevation':
        value = trail.elev_gain_ft.toLocaleString(); label = 'Ft Gain'; break;
      case 'time':
        value = formatTime(trail.moving_time); label = 'Time'; break;
      case 'speed':
        value = trail.speed_mph > 0 ? trail.speed_mph.toFixed(1) : '--'; label = 'Avg MPH'; break;
      case 'pace':
        value = formatPace(trail.pace_min_mi); label = 'Pace'; break;
    }
    statsHtml += `
      <div class="drawer-stat">
        <div class="drawer-stat-value">${value}</div>
        <div class="drawer-stat-label">${label}</div>
      </div>`;
  });

  document.getElementById('drawer-content').innerHTML = `
    <div class="drawer-top">
      <div>
        <div class="drawer-title">${trail.name}</div>
        <div style="font-size:11px;color:var(--text-3);margin-top:3px">${trail.date}</div>
      </div>
      <div class="drawer-stats">${statsHtml}</div>
    </div>
    <div id="elev-chart-wrap">
      <canvas id="elev-chart"></canvas>
    </div>`;
  document.getElementById('detail-drawer').classList.add('open');
  document.body.classList.add('drawer-open');
  loadElevationProfile(trail.id, trail.category);
}

// Elevation profile state for interactive hover
let elevProfile = null;  // { distMi, elevFt, latlngs, maxDist, minElev, elevRange, padL, padR, padT, padB, cW, cH, W, H, cfg }
let elevMarker = null;

function removeElevMarker() {
  if (elevMarker) { map.removeLayer(elevMarker); elevMarker = null; }
}

async function loadElevationProfile(activityId, category) {
  elevProfile = null;
  removeElevMarker();

  const chartCanvas = document.getElementById('elev-chart');
  if (!chartCanvas) return;
  const ctx = chartCanvas.getContext('2d');
  const wrap = document.getElementById('elev-chart-wrap');
  const dpr = window.devicePixelRatio || 1;
  chartCanvas.width = wrap.clientWidth * dpr;
  chartCanvas.height = wrap.clientHeight * dpr;
  ctx.scale(dpr, dpr);
  const W = wrap.clientWidth;
  const H = wrap.clientHeight;

  const cfg = typeForCategory(category);
  const chartColorBase = cfg.chartColor;

  ctx.fillStyle = '#9c958b';
  ctx.font = '11px Inter, sans-serif';
  ctx.fillText('Loading elevation\u2026', 8, H / 2);

  try {
    const res = await fetch(`/api/activities/${activityId}/streams`);
    if (!res.ok) throw new Error('Failed');
    const { distance, altitude, latlng } = await res.json();
    if (!distance.length || !altitude.length) return;

    const distMi = distance.map(d => d / 1609.34);
    const elevFt = altitude.map(a => a * 3.28084);
    const latlngs = latlng || [];

    const maxDist = distMi[distMi.length - 1];
    const minElev = Math.min(...elevFt);
    const maxElev = Math.max(...elevFt);
    const elevRange = maxElev - minElev || 1;

    const padL = 44, padR = 12, padT = 6, padB = 22;
    const cW = W - padL - padR;
    const cH = H - padT - padB;

    // Store for hover interaction
    elevProfile = { distMi, elevFt, latlngs, maxDist, minElev, elevRange, padL, padR, padT, padB, cW, cH, W, H, cfg, chartColorBase };

    // Update selected polyline to use hi-res streams coords so hover marker aligns exactly
    if (latlngs.length > 0) {
      const entry = polylineLayers.get(selectedName);
      if (entry) {
        entry.glow.setLatLngs(latlngs);
        entry.core.setLatLngs(latlngs);
      }
    }

    drawElevChart(ctx, dpr);

    // Attach hover handlers
    chartCanvas.onmousemove = (e) => handleElevHover(e, chartCanvas, ctx, dpr);
    chartCanvas.onmouseleave = () => { drawElevChart(ctx, dpr); removeElevMarker(); };

  } catch (e) {
    ctx.clearRect(0, 0, W * dpr, H * dpr);
    ctx.fillStyle = '#9c958b';
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Elevation data unavailable', 8, H / 2);
  }
}

function drawElevChart(ctx, dpr) {
  if (!elevProfile) return;
  const { distMi, elevFt, maxDist, minElev, elevRange, padL, padT, padB, cW, cH, W, H, cfg, chartColorBase } = elevProfile;

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // Grid
  const yTicks = 4;
  ctx.strokeStyle = '#d5d0c8';
  ctx.lineWidth = 0.5;
  ctx.fillStyle = '#9c958b';
  ctx.font = '9px Inter, sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= yTicks; i++) {
    const y = padT + cH - (i / yTicks) * cH;
    const val = Math.round(minElev + (i / yTicks) * elevRange);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + cW, y);
    ctx.stroke();
    ctx.fillText(`${val.toLocaleString()}`, padL - 6, y + 3);
  }

  ctx.textAlign = 'center';
  const xTicks = Math.min(5, Math.floor(maxDist));
  for (let i = 0; i <= xTicks; i++) {
    const val = (i / xTicks) * maxDist;
    const x = padL + (i / xTicks) * cW;
    ctx.fillText(`${val.toFixed(1)}`, x, H - 4);
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

  const gradient = ctx.createLinearGradient(0, padT, 0, padT + cH);
  gradient.addColorStop(0, chartColorBase + ' 0.2)');
  gradient.addColorStop(1, chartColorBase + ' 0.02)');
  ctx.fillStyle = gradient;
  ctx.fill();

  // Line
  ctx.beginPath();
  for (let i = 0; i < distMi.length; i++) {
    const x = padL + (distMi[i] / maxDist) * cW;
    const y = padT + cH - ((elevFt[i] - minElev) / elevRange) * cH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = cfg.color;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.restore();
}

function handleElevHover(e, chartCanvas, ctx, dpr) {
  if (!elevProfile || !elevProfile.latlngs.length) return;
  const { distMi, elevFt, latlngs, maxDist, minElev, elevRange, padL, padT, cW, cH, H, cfg } = elevProfile;

  const rect = chartCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;

  // Convert mouse X to distance
  const distAtMouse = ((mx - padL) / cW) * maxDist;
  if (distAtMouse < 0 || distAtMouse > maxDist) { removeElevMarker(); return; }

  // Find nearest stream index
  let idx = 0;
  for (let i = 1; i < distMi.length; i++) {
    if (Math.abs(distMi[i] - distAtMouse) < Math.abs(distMi[idx] - distAtMouse)) idx = i;
  }

  const elev = elevFt[idx];
  const dist = distMi[idx];
  const chartX = padL + (dist / maxDist) * cW;
  const chartY = padT + cH - ((elev - minElev) / elevRange) * cH;

  // Redraw base chart then overlay crosshair
  drawElevChart(ctx, dpr);

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Vertical line
  ctx.strokeStyle = cfg.color;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(chartX, padT);
  ctx.lineTo(chartX, padT + cH);
  ctx.stroke();
  ctx.setLineDash([]);

  // Dot on the profile line
  ctx.beginPath();
  ctx.arc(chartX, chartY, 4, 0, Math.PI * 2);
  ctx.fillStyle = cfg.color;
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Tooltip
  ctx.fillStyle = 'rgba(44, 40, 37, 0.88)';
  const label = `${Math.round(elev).toLocaleString()} ft  \u00b7  ${dist.toFixed(1)} mi`;
  ctx.font = '10px Inter, sans-serif';
  const tw = ctx.measureText(label).width + 12;
  const tx = Math.min(Math.max(chartX - tw / 2, padL), padL + cW - tw);
  const ty = chartY - 24;
  ctx.beginPath();
  ctx.roundRect(tx, ty, tw, 18, 4);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  ctx.fillText(label, tx + 6, ty + 13);

  ctx.restore();

  // Move marker on map
  if (idx < latlngs.length) {
    const [lat, lng] = latlngs[idx];
    if (!elevMarker) {
      elevMarker = L.circleMarker([lat, lng], {
        radius: 7,
        color: '#fff',
        fillColor: cfg.color,
        fillOpacity: 1,
        weight: 2.5,
        pane: 'overlayPane',
      }).addTo(map);
    } else {
      elevMarker.setLatLng([lat, lng]);
    }
  }
}

function hideDrawer() {
  document.getElementById('detail-drawer').classList.remove('open');
  document.body.classList.remove('drawer-open');
  elevProfile = null;
  removeElevMarker();
}

// ── Sidebar ───────────────────────────────────────────────
function renderSidebar() {
  const list = document.getElementById('activity-list');

  list.innerHTML = filtered.map(trail => {
    const cfg = typeForCategory(trail.category);
    const isSelected = trail.key === selectedName;

    return `
      <li class="${isSelected ? 'active' : ''}"
          style="border-left-color: ${cfg.color}"
          data-key="${trail.key}">
        <div class="trail-name">${trail.name}</div>
        <div class="trail-meta">
          <span>\u2194 ${trail.distance_mi} mi</span>
          <span>\u2191 ${trail.elev_gain_ft.toLocaleString()} ft</span>
          <span class="trail-date">${trail.date}</span>
        </div>
      </li>`;
  }).join('');
}

init();
