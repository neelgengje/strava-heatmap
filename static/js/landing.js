const TYPE_META = {
  Hike:     { label: 'Hikes',      icon: '\u26F0', param: 'Hike' },
  Ride:     { label: 'Rides',      icon: '\uD83D\uDEB4', param: 'Ride' },
  Run:      { label: 'Runs',       icon: '\uD83C\uDFC3', param: 'Run' },
  TrailRun: { label: 'Trail Runs', icon: '\uD83C\uDF32', param: 'TrailRun' },
};

async function init() {
  const res = await fetch('/api/activities/stats');
  const stats = await res.json();

  // Nav links
  const nav = document.getElementById('nav-links');
  if (stats.authenticated) {
    nav.innerHTML = '<a class="btn-primary" href="/app">Open Map</a>';
  } else {
    nav.innerHTML = '<a class="btn-primary" href="/auth/login">Connect Strava</a>';
  }

  // Hero CTA
  const cta = document.getElementById('hero-cta');
  if (stats.authenticated && stats.total > 0) {
    cta.innerHTML = '<a class="btn-primary" href="/app">Explore the Map</a>';
  } else if (stats.authenticated) {
    cta.innerHTML = '<a class="btn-primary" href="/app">Open Map & Sync</a>';
  } else {
    cta.innerHTML = '<a class="btn-primary" href="/auth/login">Connect with Strava</a>';
  }

  if (stats.total > 0) {
    // Hero subtitle with real numbers
    document.getElementById('hero-sub').textContent =
      `${stats.total.toLocaleString()} activities. ${stats.miles.toLocaleString()} miles. ${stats.years} years of exploring.`;

    // Stats ribbon
    document.getElementById('stats-ribbon').style.display = 'flex';
    document.getElementById('rs-total').textContent = stats.total.toLocaleString();
    document.getElementById('rs-miles').textContent = stats.miles.toLocaleString();
    document.getElementById('rs-elev').textContent = Math.round(stats.elevation / 1000).toLocaleString() + 'K';
    document.getElementById('rs-years').textContent = stats.years;

    // Activity cards
    const grid = document.getElementById('cards-grid');
    const types = Object.entries(stats.by_type);
    if (types.length > 0) {
      document.getElementById('cards-section').style.display = 'block';
      grid.innerHTML = types.map(([cat, data]) => {
        const meta = TYPE_META[cat] || { label: cat, icon: '\uD83C\uDFDE', param: cat };
        return `
          <a class="activity-card" data-type="${cat}" href="/app?type=${meta.param}">
            <div class="card-icon">${meta.icon}</div>
            <div class="card-label">${meta.label}</div>
            <div class="card-meta">
              <span>${data.count} activities</span>
              <span>${Math.round(data.miles).toLocaleString()} miles</span>
            </div>
          </a>`;
      }).join('');
    }
  } else if (!stats.authenticated) {
    document.getElementById('connect-section').style.display = 'block';
  }
}

init();
