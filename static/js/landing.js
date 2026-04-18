// Map category → CSS pill modifier class. Pill colors live in landing.css.
const PILL_CLASS = {
  Hike: 'pill-hike', Ride: 'pill-ride', Run: 'pill-run', TrailRun: 'pill-trailrun',
};

function setupScrollObservers() {
  const revealObs = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        revealObs.unobserve(entry.target);
      }
    });
  }, { threshold: 0.2 });

  document.querySelectorAll('.fc, .pc').forEach(el => revealObs.observe(el));

  const counterObs = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting && !entry.target.dataset.counted) {
        entry.target.dataset.counted = '1';
        const target = parseInt(entry.target.dataset.target);
        const suffix = entry.target.dataset.suffix || '';
        const duration = 1500;
        const start = performance.now();
        function update(now) {
          const progress = Math.min((now - start) / duration, 1);
          const eased = 1 - Math.pow(1 - progress, 3);
          entry.target.textContent = Math.round(eased * target).toLocaleString() + suffix;
          if (progress < 1) requestAnimationFrame(update);
        }
        requestAnimationFrame(update);
        counterObs.unobserve(entry.target);
      }
    });
  }, { threshold: 0.5 });

  document.querySelectorAll('[data-target]').forEach(el => counterObs.observe(el));
}

async function init() {
  const res = await fetch('/api/activities/stats');
  const stats = await res.json();

  // Nav links
  const nav = document.getElementById('nav-links');
  if (stats.authenticated) {
    nav.innerHTML = '<a class="nav-cta" href="/app">Open Map</a>';
  } else {
    nav.innerHTML = '<a class="nav-cta" href="/auth/login">Connect Strava</a>';
  }

  // Hero CTA
  const cta = document.getElementById('hero-cta');
  if (stats.authenticated && stats.total > 0) {
    cta.innerHTML = '<a class="btn-hero" href="/app">Explore the Map <span class="ar">&rarr;</span></a>';
  } else if (stats.authenticated) {
    cta.innerHTML = '<a class="btn-hero" href="/app">Open Map & Sync <span class="ar">&rarr;</span></a>';
  } else {
    cta.innerHTML = '<a class="btn-hero" href="/auth/login">Connect with Strava <span class="ar">&rarr;</span></a>';
  }

  if (stats.total > 0) {
    // Hero subtitle with real numbers
    document.getElementById('hero-sub').textContent =
      `${stats.total.toLocaleString()} activities. ${stats.miles.toLocaleString()} miles. ${stats.years} years of exploring.`;

    // Activity pills
    const pills = document.getElementById('hero-pills');
    const types = Object.entries(stats.by_type);
    if (types.length > 0) {
      pills.style.display = 'flex';
      pills.innerHTML = types.map(([cat, data]) => {
        const t = ACTIVITY_TYPES[cat];
        const pIcon = t?.pIcon || 'ph-map-pin';
        const label = t?.label || cat;
        const pillCls = PILL_CLASS[cat] || 'pill-hike';
        return `<div class="pill ${pillCls}"><i class="ph-duotone ${pIcon}"></i> ${data.count} ${label}</div>`;
      }).join('');
    }

    // Stats section
    const statsSection = document.getElementById('stats-section');
    statsSection.style.display = 'block';
    document.getElementById('rs-total').dataset.target = stats.total;
    document.getElementById('rs-miles').dataset.target = stats.miles;
    document.getElementById('rs-elev').dataset.target = Math.round(stats.elevation / 1000);
    document.getElementById('rs-years').dataset.target = stats.years;

    // Activity cards
    const grid = document.getElementById('cards-grid');
    if (types.length > 0) {
      document.getElementById('cards-section').style.display = 'block';
      grid.innerHTML = types.map(([cat, data], i) => {
        const t = ACTIVITY_TYPES[cat];
        const pIcon = t?.pIcon || 'ph-map-pin';
        const label = t?.label || cat;
        return `
          <a class="pc" data-type="${cat}" href="/app?type=${cat}" style="transition-delay:${i * 0.1}s">
            <div class="pci"><i class="ph-duotone ${pIcon}" style="font-size:32px"></i></div>
            <div>
              <div class="pcl">${label}</div>
              <div class="pcc">${data.count}</div>
              <div class="pcm">${Math.round(data.miles).toLocaleString()} miles explored</div>
              <div class="pca">View on map <span>&rarr;</span></div>
            </div>
          </a>`;
      }).join('');
    }
  } else if (!stats.authenticated) {
    document.getElementById('connect-section').style.display = 'block';
  }

  setupScrollObservers();
}

init();
