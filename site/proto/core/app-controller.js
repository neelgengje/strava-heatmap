// ── v2 app controller ─────────────────────────────────────────
// Interaction logic for the dashboard: filters, activity list,
// selection, hover, and the inline detail panel. Wires a Dashboard
// instance (shell.js) to the DOM.

function statBlock(cfg, t) {
  return cfg.stats.map(s => {
    let v, l;
    if (s === 'miles') { v = t.distance_mi; l = 'Miles'; }
    else if (s === 'elevation') { v = t.elev_gain_ft.toLocaleString(); l = 'Ft Gain'; }
    else if (s === 'time') { v = formatTime(t.moving_time); l = 'Time'; }
    else if (s === 'speed') { v = t.speed_mph > 0 ? t.speed_mph.toFixed(1) : '--'; l = 'MPH'; }
    else if (s === 'pace') { v = formatPace(t.pace_min_mi); l = 'Pace'; }
    return `<div class="dstat"><div class="dstat-v">${v}</div><div class="dstat-l">${l}</div></div>`;
  }).join('');
}

function initV2App({ tileTheme = 'light', controlsPosition = 'topright', inlineDetail = false } = {}) {
  const els = {
    sportSelectEl: document.getElementById('sport-select'),
    yearSelectEl: document.getElementById('year-select'),
    clearFiltersBtn: document.getElementById('clear-filters-btn'),
    statCount: document.getElementById('stat-count'),
    statMiles: document.getElementById('stat-miles'),
    statElev: document.getElementById('stat-elev'),
    drawer: document.getElementById('drawer'),
    drawerToggle: document.getElementById('drawer-toggle'),
    list: document.getElementById('activity-list'),
    hoverLabel: document.getElementById('hover-label'),
    panel: document.getElementById('detail-panel'),
    panelClose: document.getElementById('detail-close'),
    title: document.getElementById('detail-title'),
    date: document.getElementById('detail-date'),
    stats: document.getElementById('detail-stats'),
    chart: document.getElementById('detail-chart'),
    replayBtn: document.getElementById('replay-btn'),
  };

  let profile = null;
  let hoverMarker = null;
  let itemByKey = new Map();
  let linkedKey = undefined; // distinct from null so the first call always applies
  let yearSelect = null;
  let sportSelect = null;
  let inlineRelayoutTO = null;

  function renderList(dash) {
    const ordered = [...dash.tracks].sort((a, b) => b.date.localeCompare(a.date));
    els.list.innerHTML = ordered.map(t => {
      const cfg = typeForCategory(t.category);
      return `
        <li class="activity-item" data-key="${t.key}" style="--item-color:${cfg.color}">
          <span class="activity-thumb">
            ${routeSparklineSvg(t.coords, 38, 1.4, cfg.color)}
            <span class="activity-emoji">${cfg.icon}</span>
          </span>
          <span class="activity-body">
            <span class="activity-name">${t.name}</span>
            <span class="activity-meta">
              <span>${t.distance_mi} mi</span>
              <span>${t.date}</span>
            </span>
          </span>
        </li>`;
    }).join('');

    itemByKey = new Map(ordered.map(t => [t.key, els.list.querySelector(`[data-key="${t.key}"]`)]));

    // Hover highlights the trail only — no camera move, no scrolling.
    els.list.addEventListener('mousemove', e => {
      const item = e.target.closest('[data-key]');
      if (!item || dash.selectedKey) return;
      if (dash.layer.setHover(item.dataset.key)) setLinked(item.dataset.key);
    });
    els.list.addEventListener('mouseleave', () => {
      if (dash.selectedKey) return;
      dash.layer.setHover(null);
      setLinked(null);
    });
    els.list.addEventListener('click', e => {
      const item = e.target.closest('[data-key]');
      if (item) dash.select(item.dataset.key);
    });
  }

  // Gated on an actual change: onHover fires on every mousemove, so without
  // this every mousemove would walk all ~390 items for nothing.
  function setLinked(key) {
    if (key === linkedKey) return;
    linkedKey = key;
    itemByKey.forEach((item, k) => item.classList.toggle('linked', k === key));
  }

  function markerAt(dash, latlng) {
    if (!hoverMarker) {
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#c44535';
      hoverMarker = L.circleMarker(latlng, { radius: 9, color: '#fff', weight: 2, fillColor: accent, fillOpacity: 1, pane: 'overlayPane' }).addTo(dash.map);
    } else hoverMarker.setLatLng(latlng);
  }
  function removeMarker(dash) {
    if (hoverMarker) { dash.map.removeLayer(hoverMarker); hoverMarker = null; }
  }

  async function main() {
    const dash = new Dashboard({
      mapElId: 'map',
      tileTheme,
      controlsPosition,
      onDataLoaded: () => {
        sportSelect = new SportMultiSelect(els.sportSelectEl, { dash });
        renderList(dash);
        yearSelect = new YearMultiSelect(els.yearSelectEl, { years: dash.years, yearTotals: dash.yearTotals, dash });
        dash.playDrawIn();
      },
      onFiltersChange: (visible, stats) => {
        els.statCount.textContent = stats.count.toLocaleString();
        els.statMiles.textContent = Math.round(stats.miles).toLocaleString();
        els.statElev.textContent = Math.round(stats.elev / 1000) + 'K';

        const visibleKeys = new Set(visible.map(t => t.key));
        itemByKey.forEach((item, k) => item.style.display = visibleKeys.has(k) ? '' : 'none');
      },
      onSelect: (t) => {
        const cfg = typeForCategory(t.category);
        itemByKey.forEach((item, k) => item.classList.toggle('selected', k === t.key));
        setLinked(null);

        els.title.textContent = t.name;
        els.date.textContent = t.date;
        els.stats.innerHTML = statBlock(cfg, t);

        // The single #detail-panel node moves to sit right after the
        // selected row instead of a separate panel showing/hiding elsewhere.
        if (inlineDetail) {
          const item = itemByKey.get(t.key);
          if (item && item.nextElementSibling !== els.panel) item.insertAdjacentElement('afterend', els.panel);
        }
        els.panel.classList.add('open');
        els.hoverLabel.classList.remove('show');

        if (!profile) profile = new ElevationProfile(els.chart, {
          onMove: latlng => { if (latlng) markerAt(dash, latlng); },
          onLeave: () => removeMarker(dash),
        });
        profile.setColor(cfg.color);
        profile.load(t.id).catch(() => {});

        if (inlineDetail) {
          // Panel opens from height:0 and animates over 0.42s — the chart
          // needs the container's final size, and the scroll target needs
          // the panel's final height, so both wait for that to finish.
          clearTimeout(inlineRelayoutTO);
          inlineRelayoutTO = setTimeout(() => {
            profile?.relayout();
            els.panel.scrollIntoView({ behavior: 'auto', block: 'start' });
          }, 460);
        }
      },
      onDeselect: () => {
        itemByKey.forEach(item => item.classList.remove('selected'));
        els.panel.classList.remove('open');
        removeMarker(dash);
        profile?.stopReplay();
        if (inlineDetail) {
          clearTimeout(inlineRelayoutTO);
          // Detach only after the collapse transition finishes, and only if
          // nothing new was selected in the meantime (which would have
          // already re-parented the panel elsewhere).
          setTimeout(() => { if (!dash.selectedKey) els.panel.remove(); }, 460);
        }
      },
      onHover: (t, pos) => {
        if (!t) { els.hoverLabel.classList.remove('show'); setLinked(null); return; }
        const cfg = typeForCategory(t.category);
        els.hoverLabel.innerHTML = `
          <div class="hl-name" style="color:${cfg.color}">${t.name}</div>
          <div class="hl-meta">${t.distance_mi} mi · ${t.elev_gain_ft.toLocaleString()} ft · ${t.date}</div>`;
        els.hoverLabel.style.left = pos.x + 'px';
        els.hoverLabel.style.top = pos.y + 'px';
        els.hoverLabel.classList.add('show');
        setLinked(t.key);
      },
    });

    els.panelClose.addEventListener('click', () => dash.deselect());
    els.replayBtn.addEventListener('click', () => profile?.replay(6000));
    els.clearFiltersBtn.addEventListener('click', () => {
      dash.clearAllFilters();
      sportSelect?.refresh();
      yearSelect?.refresh();
    });
    els.drawerToggle.addEventListener('click', () => {
      document.body.classList.toggle('drawer-collapsed');
      dash.refitToOcclusion();
    });

    await dash.init();
  }

  main();
}
