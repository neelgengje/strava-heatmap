// ── Activity color map (neon palette from design) ────────────
const LANDING_COLORS = {
  Hike:     '#C5FF3D',
  Ride:     '#06D6F5',
  Run:      '#FF5E3A',
  TrailRun: '#FF3E8E',
  Kayak:    '#C44EFF',
};

// ── Helpers ───────────────────────────────────────────────────
function landingFormatTime(seconds) {
  if (!seconds) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Render a mini SVG route from actual coords (lat/lng pairs)
function miniRouteSvg(coords, color, W = 140, H = 56) {
  if (!coords || coords.length < 2) {
    // Decorative fallback — a gentle wavy line
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <path d="M8,${H/2} Q${W*0.25},${H*0.25} ${W*0.5},${H/2} T${W-8},${H/2}"
            fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" opacity="0.5"/>
    </svg>`;
  }

  // Downsample to ~40 points for small render
  const step = Math.max(1, Math.floor(coords.length / 40));
  const pts = coords.filter((_, i) => i % step === 0);
  if (pts.length < 2) return miniRouteSvg(null, color, W, H);

  const lats = pts.map(([lat]) => lat);
  const lngs = pts.map(([, lng]) => lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const dLat = maxLat - minLat || 0.001;
  const dLng = maxLng - minLng || 0.001;

  const pad = 8;
  // Maintain aspect ratio
  const scaleX = (W - pad * 2) / dLng;
  const scaleY = (H - pad * 2) / dLat;
  const scale = Math.min(scaleX, scaleY);
  const offX = (W - dLng * scale) / 2;
  const offY = (H - dLat * scale) / 2;

  const svgPts = pts.map(([lat, lng]) => {
    const x = offX + (lng - minLng) * scale;
    const y = H - offY - (lat - minLat) * scale;
    return [x.toFixed(1), y.toFixed(1)];
  });

  const d = svgPts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join(' ');
  const [sx, sy] = svgPts[0];

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="overflow:visible">
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.5"
          stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${sx}" cy="${sy}" r="2.8" fill="${color}"/>
  </svg>`;
}

// ── Main ──────────────────────────────────────────────────────
async function init() {
  let stats = null;
  let activities = [];

  try {
    const [sr, ar] = await Promise.all([
      fetch('/data/stats.json'),
      fetch('/data/activities.json'),
    ]);
    if (sr.ok)  stats      = await sr.json();
    if (ar.ok)  activities = await ar.json();
  } catch { /* no data yet */ }

  // Sort newest-first
  activities.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  // ── Fill stat block ──────────────────────────────────────
  if (stats) {
    const countEl  = document.getElementById('stat-count');
    const milesEl  = document.getElementById('stat-miles');
    const elevEl   = document.getElementById('stat-elev');
    const hoursEl  = document.getElementById('stat-hours');
    const totalEl  = document.getElementById('total-count');

    if (countEl)  countEl.textContent  = stats.total.toLocaleString();
    if (milesEl)  milesEl.textContent  = Math.round(stats.miles).toLocaleString();
    if (elevEl)   elevEl.textContent   = (stats.elevation / 1000).toFixed(0) + 'k';
    if (totalEl)  totalEl.textContent  = stats.total.toLocaleString();

    // Compute total hours from activities
    if (activities.length > 0) {
      const totalSecs = activities.reduce((s, a) => s + (a.moving_time || 0), 0);
      if (hoursEl) hoursEl.textContent = Math.round(totalSecs / 3600).toLocaleString();
    }

    // Count distinct sports
    const sports = new Set(activities.map(a => a.category)).size;
    const sportsEl = document.getElementById('stat-sports');
    if (sportsEl) sportsEl.textContent = sports || 5;
  }

  // ── Latest activity for photo caption ────────────────────
  if (activities.length > 0) {
    const latest = activities[0];
    const cfg    = ACTIVITY_TYPES?.[latest.category] || {};
    const t      = landingFormatTime(latest.moving_time);

    const nameEl   = document.getElementById('caption-name');
    const statsEl  = document.getElementById('caption-stats');
    const stampEl  = document.getElementById('photo-stamp');

    if (nameEl)  nameEl.textContent = latest.name;
    if (statsEl) {
      const parts = [
        `${latest.distance_mi} mi`,
        latest.elev_gain_ft ? `${latest.elev_gain_ft.toLocaleString()} ft up` : null,
        t,
      ].filter(Boolean);
      statsEl.innerHTML = parts.map(p => `<span>${p}</span>`).join('');
    }
    if (stampEl) {
      const shortName = latest.name.length > 22 ? latest.name.slice(0, 22) + '…' : latest.name;
      stampEl.textContent = `◐ ${shortName} · ${latest.date || '—'}`;
    }
  }

  // ── Render waypoints ──────────────────────────────────────
  const grid   = document.getElementById('waypoints-grid');
  const recent = activities.slice(0, 5);

  if (!grid) return;

  if (recent.length === 0) {
    grid.innerHTML = `<div style="grid-column:1/-1;display:flex;align-items:center;justify-content:center;
      font-family:var(--mono);font-size:11px;color:var(--ink-3)">No activities yet.</div>`;
    return;
  }

  grid.innerHTML = recent.map(a => {
    const color  = LANDING_COLORS[a.category] || '#E5F53B';
    const cfg    = ACTIVITY_TYPES?.[a.category] || { icon: '⛰' };
    const t      = landingFormatTime(a.moving_time);
    const route  = miniRouteSvg(a.coords, color);

    const statParts = [
      `${a.distance_mi} mi`,
      a.elev_gain_ft ? `↑${a.elev_gain_ft.toLocaleString()}ft` : null,
      t,
    ].filter(Boolean);

    return `
      <div class="waypoint-card">
        <div class="waypoint-card-header">
          <span class="waypoint-icon">${cfg.icon || '⛰'}</span>
          <span class="waypoint-date">${a.date || ''}</span>
        </div>
        <div class="waypoint-route">${route}</div>
        <div class="waypoint-name" title="${a.name}">${a.name}</div>
        <div class="waypoint-stats">
          ${statParts.map(p => `<span>${p}</span>`).join('')}
        </div>
      </div>`;
  }).join('');
}

init();
