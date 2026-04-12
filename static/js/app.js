
// ── State ─────────────────────────────────────────────────
let activities   = [];   // raw from API (all hikes, incl. duplicates)
let trails       = [];   // deduplicated, aggregated
let filtered     = [];   // current filtered view
let polylineLayers = []; // [{ glow, core, name }]
let selectedName = null;
const canvas     = L.canvas();

// ── Map ───────────────────────────────────────────────────
const map = L.map('map', {
  scrollWheelZoom: false,
  zoomSnap: 0,
  zoomControl: true,
  minZoom: 2,
}).setView([37.75, -122.2], 9);

// Custom wheel zoom:
// - macOS trackpad pinch fires wheel with ctrlKey=true and tiny deltaY (~1-5px)
// - scroll wheel fires with ctrlKey=false and large deltaY (~100px)
// These need very different sensitivity factors.
;(function () {
  let zoomTarget = map.getZoom();
  let rafPending = false;

  window.addEventListener('wheel', e => {
    if (!map.getContainer().contains(e.target)) return;
    e.preventDefault();

    const factor = e.ctrlKey ? 0.018 : 0.002;  // pinch vs scroll
    zoomTarget -= e.deltaY * factor;
    zoomTarget = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), zoomTarget));

    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(() => {
        map.setZoom(zoomTarget, { animate: false });
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
    `https://{s}.tile.thunderforest.com/outdoors/{z}/{x}/{y}.png?apikey=${cfg.thunderforest_key}`,
    { attribution: '&copy; <a href="https://www.thunderforest.com">Thunderforest</a> &copy; OpenStreetMap', maxZoom: 22 }
  ).addTo(map);

  if (cfg.authenticated) {
    renderAuthBar(true);
    await loadActivities();
  } else {
    renderAuthBar(false);
  }
}

// ── Auth ──────────────────────────────────────────────────
function renderAuthBar(authenticated) {
  const el = document.getElementById('auth-actions');
  if (authenticated) {
    el.innerHTML = `
      <button class="btn-sync" id="sync-btn" onclick="syncActivities()">Sync</button>
      <a class="btn-logout" href="/auth/logout">Disconnect</a>`;
  } else {
    document.getElementById('connect-cta').style.display = 'flex';
  }
}

async function syncActivities() {
  const btn = document.getElementById('sync-btn');
  btn.textContent = '…';
  btn.disabled = true;
  await fetch('/api/activities/sync');
  btn.textContent = 'Sync';
  btn.disabled = false;
  await loadActivities();
}

// ── Data ──────────────────────────────────────────────────
async function loadActivities() {
  const res = await fetch('/api/activities');
  if (!res.ok) return;
  activities = await res.json();

  // Strip leading tags like "#H4 ", "#3 ", "H2 " from Strava titles
  function cleanName(raw) {
    return raw.replace(/^#?[A-Za-z]*\d+\s+/, '').trim() || raw;
  }

  // Aggregate duplicates into trail objects (keyed by cleaned name)
  const map_ = new Map();
  activities.forEach(a => {
    const key = cleanName(a.name);
    if (!map_.has(key)) {
      map_.set(key, {
        name:         key,
        id:           a.id,
        distance_mi:  a.distance_mi,
        elev_gain_ft: a.elev_gain_ft,
        frequency:    0,
        last_date:    a.date,
        coords:       a.coords,
        years:        new Set(),
      });
    }
    const t = map_.get(key);
    t.frequency++;
    if (a.date > t.last_date) {
      t.last_date    = a.date;
      t.coords       = a.coords;       // use most recent GPS track
      t.distance_mi  = a.distance_mi;
      t.elev_gain_ft = a.elev_gain_ft;
    }
    t.years.add(a.date.slice(0, 4));
  });

  trails = [...map_.values()].sort((a, b) => b.frequency - a.frequency || b.last_date.localeCompare(a.last_date));
  filtered = trails;

  renderStats();
  populateYearFilter();
  renderSidebar();
  renderMap();

  document.getElementById('stats-bar').style.display = 'flex';
  document.getElementById('controls').style.display  = 'flex';
  document.getElementById('connect-cta').style.display = 'none';
}

// ── Stats ─────────────────────────────────────────────────
function renderStats() {
  const totalHikes = activities.length;
  const totalMiles = activities.reduce((s, a) => s + a.distance_mi, 0);
  const totalElev  = activities.reduce((s, a) => s + a.elev_gain_ft, 0);

  document.getElementById('stat-hikes').textContent = totalHikes.toLocaleString();
  document.getElementById('stat-miles').textContent = Math.round(totalMiles).toLocaleString();
  document.getElementById('stat-elev').textContent  = Math.round(totalElev / 1000) + 'K';
}

// ── Year filter ───────────────────────────────────────────
function populateYearFilter() {
  const years = new Set();
  activities.forEach(a => years.add(a.date.slice(0, 4)));
  const sel = document.getElementById('year-filter');
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
    const matchName = !query || t.name.toLowerCase().includes(query);
    const matchYear = !year  || t.years.has(year);
    return matchName && matchYear;
  });

  renderSidebar();
}

// ── Colors ────────────────────────────────────────────────
function freqColor(freq) {
  if (freq >= 6) return '#7a0000';
  if (freq >= 4) return '#a80000';
  if (freq >= 3) return '#c91a00';
  if (freq >= 2) return '#e63000';
  return '#ff4422';
}

// ── Map rendering ─────────────────────────────────────────
function renderMap() {
  polylineLayers.forEach(({ glow, core }) => { map.removeLayer(glow); map.removeLayer(core); });
  polylineLayers = [];

  trails.forEach(trail => {
    const latlngs = trail.coords.map(([lat, lng]) => [lat, lng]);
    const color   = freqColor(trail.frequency);
    const coreW   = 1.5 + Math.min(trail.frequency * 0.35, 2);

    const glow = L.polyline(latlngs, { color, weight: coreW + 6, opacity: 0.15, renderer: canvas }).addTo(map);
    const core = L.polyline(latlngs, { color, weight: coreW,     opacity: 0.82, renderer: canvas }).addTo(map);

    [glow, core].forEach(p => {
      p.on('mouseover', () => { if (selectedName !== trail.name) core.setStyle({ opacity: 1, weight: coreW + 1 }); });
      p.on('mouseout',  () => { if (selectedName !== trail.name) core.setStyle({ opacity: 0.82, weight: coreW }); });
      p.on('click',     () => selectTrail(trail.name));
    });

    polylineLayers.push({ glow, core, name: trail.name, coreW });
  });
}

// ── Select ────────────────────────────────────────────────
function selectTrail(name) {
  if (selectedName === name) { clearSelection(); return; }
  selectedName = name;

  const trail = trails.find(t => t.name === name);
  if (!trail) return;

  // Highlight selected, dim rest
  polylineLayers.forEach(({ glow, core, name: n, coreW }) => {
    const sel = n === name;
    glow.setStyle({ opacity: sel ? 0.5  : 0.05, color: sel ? '#c044ff' : freqColor(trails.find(t=>t.name===n)?.frequency||1) });
    core.setStyle({ opacity: sel ? 1.0  : 0.15, weight: sel ? coreW + 3 : coreW, color: sel ? '#c044ff' : freqColor(trails.find(t=>t.name===n)?.frequency||1) });
  });

  // Fly to trail
  const latlngs = trail.coords.map(([lat, lng]) => [lat, lng]);
  map.fitBounds(L.latLngBounds(latlngs), { padding: [60, 60], maxZoom: 14 });

  // Show drawer
  showDrawer(trail);

  // Highlight sidebar item
  renderSidebar();
}

function clearSelection() {
  selectedName = null;
  renderSidebar();
  hideDrawer();

  // Restore all trails
  polylineLayers.forEach(({ glow, core, name, coreW }) => {
    const color = freqColor(trails.find(t => t.name === name)?.frequency || 1);
    glow.setStyle({ opacity: 0.15, color });
    core.setStyle({ opacity: 0.82, weight: coreW, color });
  });
}

// ── Drawer ────────────────────────────────────────────────
function showDrawer(trail) {
  const timesLabel = trail.frequency === 1 ? '1 time' : `${trail.frequency}×`;
  document.getElementById('drawer-content').innerHTML = `
    <div>
      <div class="drawer-title">${trail.name}</div>
      <div style="font-size:11px;color:var(--text-3);margin-top:3px">Last hiked ${trail.last_date}</div>
    </div>
    <div class="drawer-stats">
      <div class="drawer-stat">
        <div class="drawer-stat-value">${trail.distance_mi}</div>
        <div class="drawer-stat-label">Miles</div>
      </div>
      <div class="drawer-stat">
        <div class="drawer-stat-value">${trail.elev_gain_ft.toLocaleString()}</div>
        <div class="drawer-stat-label">Ft Gain</div>
      </div>
      <div class="drawer-stat">
        <div class="drawer-stat-value" style="color:var(--selected)">${timesLabel}</div>
        <div class="drawer-stat-label">Hiked</div>
      </div>
    </div>`;
  document.getElementById('detail-drawer').classList.add('open');
}

function hideDrawer() {
  document.getElementById('detail-drawer').classList.remove('open');
}

// ── Sidebar ───────────────────────────────────────────────
function renderSidebar() {
  const list = document.getElementById('activity-list');

  list.innerHTML = filtered.map(trail => {
    const color   = freqColor(trail.frequency);
    const isSelected = trail.name === selectedName;
    const badgeBg = color + '22';

    return `
      <li class="${isSelected ? 'active' : ''}"
          style="border-left-color: ${isSelected ? 'var(--selected)' : color}"
          onclick="selectTrail('${trail.name.replace(/'/g, "\\'")}')">
        <div class="trail-name">${trail.name}</div>
        <div class="trail-meta">
          <span>↔ ${trail.distance_mi} mi</span>
          <span>↑ ${trail.elev_gain_ft.toLocaleString()} ft</span>
          <span class="freq-badge" style="background:${badgeBg};color:${color}">
            ${trail.frequency}×
          </span>
        </div>
      </li>`;
  }).join('');
}

init();
