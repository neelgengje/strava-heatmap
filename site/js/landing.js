// Map category → CSS pill modifier class. Pill colors live in landing.css.
const PILL_CLASS = {
  Hike: 'pill-hike', Ride: 'pill-ride', Run: 'pill-run', TrailRun: 'pill-trailrun', Kayak: 'pill-kayak',
};

function animateCounters() {
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
  // Nav — always show the map link
  document.getElementById('nav-links').innerHTML = '<a class="nav-cta" href="/app.html">Open Map</a>';

  let stats;
  try {
    const res = await fetch('/data/stats.json');
    if (!res.ok) throw new Error('no data');
    stats = await res.json();
  } catch {
    // No data yet — show a coming-soon state
    document.getElementById('hero-cta').innerHTML =
      '<a class="btn-hero" href="/app.html">Explore the Map <span class="ar">&rarr;</span></a>';
    return;
  }

  // Hero CTA
  document.getElementById('hero-cta').innerHTML =
    '<a class="btn-hero" href="/app.html">Explore the Map <span class="ar">&rarr;</span></a>';

  if (stats.total > 0) {
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

    // Hero KPIs
    const kpis = document.getElementById('hero-kpis');
    kpis.style.display = 'flex';
    document.getElementById('hk-total').dataset.target = stats.total;
    document.getElementById('hk-miles').dataset.target = stats.miles;
    document.getElementById('hk-elev').dataset.target = Math.round(stats.elevation / 1000);
    document.getElementById('hk-years').dataset.target = stats.years;
  }

  animateCounters();
}

init();
