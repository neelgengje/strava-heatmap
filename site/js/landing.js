// ── Helpers ───────────────────────────────────────────────────
function landingFormatDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return null;
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }).toLowerCase();
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

  // ── Fill figures ──────────────────────────────────────────
  if (stats) {
    const countEl = document.getElementById('stat-count');
    const milesEl = document.getElementById('stat-miles');
    const elevEl  = document.getElementById('stat-elev');
    const hoursEl = document.getElementById('stat-hours');

    if (countEl) countEl.textContent = stats.total.toLocaleString();
    if (milesEl) milesEl.textContent = Math.round(stats.miles).toLocaleString();
    if (elevEl)  elevEl.textContent  = stats.elevation.toLocaleString();

    if (activities.length > 0) {
      const totalSecs = activities.reduce((s, a) => s + (a.moving_time || 0), 0);
      if (hoursEl) hoursEl.textContent = Math.round(totalSecs / 3600).toLocaleString();
    }

    const sports = new Set(activities.map(a => a.category)).size;
    const sportsEl = document.getElementById('stat-sports');
    if (sportsEl) sportsEl.textContent = sports || 5;
  }

  // ── Last entry ────────────────────────────────────────────
  if (activities.length > 0) {
    const lastEntryEl = document.getElementById('last-entry');
    const formatted = landingFormatDate(activities[0].date);
    if (lastEntryEl && formatted) lastEntryEl.textContent = formatted;
  }
}

init();
