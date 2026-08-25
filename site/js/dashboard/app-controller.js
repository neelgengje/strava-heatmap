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

// Reused for both Avg HR and Max HR tiles.
const HEART_ICON_SVG = '<svg class="hr-icon" width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M20.8 8.6c0 4.5-8.8 10.3-8.8 10.3S3.2 13.1 3.2 8.6a4.7 4.7 0 0 1 8.8-2.3 4.7 4.7 0 0 1 8.8 2.3Z"/></svg>';

// Second, quieter stat tier — HR/calories, unlike statBlock() above, are
// per-ACTIVITY (not per-sport-type), so this isn't driven by cfg.stats.
// Each stat only appears when the activity actually has it: most
// historical activities predate any HR strap, and omitting the tile reads
// better than a '--' placeholder that implies data that's just missing.
function secondaryStatBlock(t) {
  const items = [];
  if (t.avg_hr != null) items.push([`${HEART_ICON_SVG}${t.avg_hr}`, 'Avg HR']);
  if (t.max_hr != null) items.push([`${HEART_ICON_SVG}${t.max_hr}`, 'Max HR']);
  if (t.calories != null) items.push([`<span class="cal-emoji">🔥</span>${t.calories.toLocaleString()}`, 'Calories']);
  return items.map(([v, l]) => `<div class="dstat2nd"><div class="dstat2nd-v">${v}</div><div class="dstat2nd-l">${l}</div></div>`).join('');
}

function initV2App({ tileTheme = 'light', controlsPosition = 'topright', inlineDetail = false } = {}) {
  const els = {
    sportSelectEl: document.getElementById('sport-select'),
    yearSelectEl: document.getElementById('year-select'),
    searchInput: document.getElementById('activity-search'),
    clearFiltersBtn: document.getElementById('clear-filters-btn'),
    statCount: document.getElementById('stat-count'),
    statMiles: document.getElementById('stat-miles'),
    statElev: document.getElementById('stat-elev'),
    drawer: document.getElementById('drawer'),
    drawerToggle: document.getElementById('drawer-toggle'),
    mobileViewToggle: document.getElementById('mobile-view-toggle'),
    list: document.getElementById('activity-list'),
    hoverLabel: document.getElementById('hover-label'),
    panel: document.getElementById('detail-panel'),
    panelClose: document.getElementById('detail-close'),
    title: document.getElementById('detail-title'),
    date: document.getElementById('detail-date'),
    stats: document.getElementById('detail-stats'),
    statsSecondary: document.getElementById('detail-stats-secondary'),
    hrToggle: document.getElementById('hr-toggle'),
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
  let hrVisible = false; // the HR toggle's on/off state, reset on every selection

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
        els.statsSecondary.innerHTML = secondaryStatBlock(t);

        // Reset every time — #detail-panel is one reused node, so a switch
        // left on from a previously-selected activity would otherwise carry
        // over onto this one.
        hrVisible = false;
        els.hrToggle.classList.remove('on');
        els.hrToggle.setAttribute('aria-checked', 'false');
        els.hrToggle.classList.toggle('visible', t.avg_hr != null);

        // The single #detail-panel node moves to sit right after the
        // selected row instead of a separate panel showing/hiding elsewhere.
        if (inlineDetail) {
          const item = itemByKey.get(t.key);
          if (item && item.nextElementSibling !== els.panel) item.insertAdjacentElement('afterend', els.panel);
        }

        // Panel content is now variable per activity (0, 1, or 2 extra rows
        // depending on whether it has HR/calorie data), so the open height
        // is measured from actual content rather than a fixed CSS number —
        // all the content above must already be in the DOM before this, or
        // an HR-having activity would open short. Animates from whatever
        // height the panel is already at (0 if it was closed, its previous
        // height if swapping between two already-open activities).
        const wasOpen = els.panel.classList.contains('open');
        els.panel.classList.add('open');
        els.panel.style.height = 'auto';
        const targetHeight = els.panel.offsetHeight; // forces layout
        if (!wasOpen) {
          els.panel.style.height = '0px';
          void els.panel.offsetHeight; // force a reflow before animating
        }
        els.panel.style.height = targetHeight + 'px';

        els.hoverLabel.classList.remove('show');

        if (!profile) profile = new ElevationProfile(els.chart, {
          onMove: latlng => { if (latlng) markerAt(dash, latlng); },
          onLeave: () => removeMarker(dash),
        });
        profile.setColor(cfg.color);
        profile.setShowHeartRate(false);
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
        // Clears the inline height the open sequence set — otherwise it
        // would keep overriding the CSS height:0 and block the collapse.
        els.panel.style.height = '';
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
    els.hrToggle.addEventListener('click', () => {
      hrVisible = !hrVisible;
      els.hrToggle.classList.toggle('on', hrVisible);
      els.hrToggle.setAttribute('aria-checked', String(hrVisible));
      profile?.setShowHeartRate(hrVisible);
    });
    // Debounced: every keystroke otherwise re-filters all ~420 tracks and
    // toggles style.display on every list item synchronously.
    let searchTO = null;
    els.searchInput.addEventListener('input', () => {
      clearTimeout(searchTO);
      searchTO = setTimeout(() => dash.setSearchQuery(els.searchInput.value), 120);
    });
    els.clearFiltersBtn.addEventListener('click', () => {
      dash.clearAllFilters();
      sportSelect?.refresh();
      yearSelect?.refresh();
      els.searchInput.value = '';
    });
    els.drawerToggle.addEventListener('click', () => {
      document.body.classList.toggle('drawer-collapsed');
      dash.refitToOcclusion();
    });

    // Phone-width only (see app.css) — the drawer covers the whole screen
    // there, so this is a binary switch rather than the partial collapse
    // above. Label/icon are CSS-driven off the same body class; only the
    // text needs updating in JS since the icons swap via display:none.
    const mivLabel = els.mobileViewToggle.querySelector('.miv-label');
    els.mobileViewToggle.addEventListener('click', () => {
      const showingMap = document.body.classList.toggle('mobile-view-map');
      mivLabel.textContent = showingMap ? 'List' : 'Map';
      els.mobileViewToggle.setAttribute('aria-pressed', String(showingMap));
      dash.refitToOcclusion();
    });

    await dash.init();
  }

  main();
}

// Node-only export for the test suite (tests/js/) — a no-op in the browser,
// where this file loads as a plain <script> and `module` is undefined.
// statBlock/secondaryStatBlock reference formatTime/formatPace/typeForCategory
// as free variables (config.js's own globals in the browser) — the test file
// injects them onto `global` before requiring this file.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { statBlock, secondaryStatBlock };
}
