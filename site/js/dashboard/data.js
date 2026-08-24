// ── Shared data layer ────────────────────────────────────────
// Loads activities.json once, normalizes it, and builds the month/year
// histogram. No filtering logic here — the dashboard owns filter state.

const BAY_AREA_BOUNDS_LL = [[37.20, -122.60], [38.00, -121.70]];

async function loadTrailData() {
  const res = await fetch('/data/activities.json');
  const raw = await res.json();

  const tracks = raw
    .filter(a => a.coords && a.coords.length > 1)
    .map(a => ({
      key: (a.category || 'Hike') + ':' + a.id,
      id: a.id,
      name: a.name,
      category: a.category || 'Hike',
      date: a.date,
      year: a.date.slice(0, 4),
      month: a.date.slice(0, 7), // YYYY-MM
      distance_mi: a.distance_mi,
      elev_gain_ft: a.elev_gain_ft,
      moving_time: a.moving_time || 0,
      speed_mph: a.speed_mph || 0,
      pace_min_mi: a.pace_min_mi || 0,
      coords: a.coords,
    }))
    .sort((a, b) => a.date.localeCompare(b.date)); // oldest first — draw-in order

  const { colorTable, buckets } = buildDensityIndex(tracks, 20);

  return { tracks, colorTable, buckets, ...buildHistogram(tracks) };
}

// Per-month counts, per category, for the timeline. Also returns the
// sorted list of months present and per-year totals for a coarser view.
function buildHistogram(tracks) {
  const monthMap = new Map(); // 'YYYY-MM' -> { total, byCategory: {cat: n} }
  const yearMap = new Map();  // 'YYYY' -> n

  tracks.forEach(t => {
    if (!monthMap.has(t.month)) monthMap.set(t.month, { total: 0, byCategory: {} });
    const m = monthMap.get(t.month);
    m.total++;
    m.byCategory[t.category] = (m.byCategory[t.category] || 0) + 1;
    yearMap.set(t.year, (yearMap.get(t.year) || 0) + 1);
  });

  const months = [...monthMap.keys()].sort();
  // Fill gaps so the timeline has a continuous month axis.
  const filled = [];
  if (months.length) {
    let [y, m] = months[0].split('-').map(Number);
    const [ey, em] = months[months.length - 1].split('-').map(Number);
    while (y < ey || (y === ey && m <= em)) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      filled.push({ key, ...(monthMap.get(key) || { total: 0, byCategory: {} }) });
      m++; if (m > 12) { m = 1; y++; }
    }
  }

  const years = [...yearMap.keys()].sort();

  return { months: filled, years, yearTotals: yearMap };
}

function statsFor(tracks) {
  const count = tracks.length;
  const miles = tracks.reduce((s, t) => s + t.distance_mi, 0);
  const elev  = tracks.reduce((s, t) => s + t.elev_gain_ft, 0);
  const time  = tracks.reduce((s, t) => s + t.moving_time, 0);
  return { count, miles, elev, time };
}

// Always the fixed Bay Area box, never derived from the data — ~100 of
// the activities are trips (Hawaii, Utah, Nevada...) far outside it, and
// a data-driven fitBounds would zoom out to fit the outlier instead.
function boundsForTracks() {
  return L.latLngBounds(BAY_AREA_BOUNDS_LL);
}
