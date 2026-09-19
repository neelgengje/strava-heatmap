const VISITED = new Set([
  'bryce-canyon',
  'channel-islands',
  'grand-canyon',
  'grand-teton',
  'great-sand-dunes',
  'great-smoky-mountains',
  'pinnacles',
  'rocky-mountain',
  'shenandoah',
  'yosemite',
  'zion'
]);
const posterSrc = (id) => `/img/parks/${id}.webp`;
const state = { status: 'all', places: new Set() };
let parks = [];
let lastFocus = null;

// Verified routes where the display name is shorter than AllTrails' route title.
const DIRECT_HIKE_MATCHES = {
  'yosemite|Half Dome': 'https://www.alltrails.com/trail/us/california/half-dome-via-the-john-muir-trail-jmt',
  'yosemite|Four Mile Trail': 'https://www.alltrails.com/trail/us/california/union-point-via-four-mile-trail',
  'grand-canyon|South Kaibab Trail': 'https://www.alltrails.com/trail/us/arizona/south-kaibab-trail-to-skeleton-point',
  'great-smoky-mountains|Alum Cave Trail': 'https://www.alltrails.com/trail/us/tennessee/alum-cave-trail-to-mount-leconte',
  'death-valley|Golden Canyon Trail': 'https://www.alltrails.com/trail/us/california/golden-canyon',
  'crater-lake|Cleetwood Cove Trail': 'https://www.alltrails.com/trail/us/oregon/cleetwood-cove-trail',
  'pinnacles|Bear Gulch Cave Trail': 'https://www.alltrails.com/trail/us/california/bear-gulch-reservoir-and-caves-via-moses-spring-trail'
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

function placesFor(park) {
  return park.state.split(',').map((place) => place.trim());
}

function filteredParks() {
  return parks.filter((park) => {
    const visited = VISITED.has(park.id);
    const statusMatch = state.status === 'all' || (state.status === 'visited' ? visited : !visited);
    const placeMatch = state.places.size === 0 || placesFor(park).some((place) => state.places.has(place));
    return statusMatch && placeMatch;
  });
}

function cardMarkup(park, index) {
  const visited = VISITED.has(park.id);
  const stamp = visited ? '<img class="pk-visited-stamp" src="/img/parks/visited-stamp.png" alt="Visited">' : '';
  return `<article class="pk-card" style="--pk-index:${Math.min(index, 16)}" data-id="${esc(park.id)}">
    <div class="pk-poster-wrap">
      <img src="${posterSrc(esc(park.id))}" width="720" height="1080" loading="${index < 4 ? 'eager' : 'lazy'}" decoding="async" alt="${esc(park.name)} National Park poster">
      ${stamp}
    </div>
    <div class="pk-card-info">
      <div class="pk-card-title-row">
        <h3>${esc(park.name)}</h3>
        <button class="pk-more" type="button" data-park-id="${esc(park.id)}" aria-label="View details for ${esc(park.name)}">+</button>
      </div>
    </div>
  </article>`;
}

function renderGrid() {
  const visible = filteredParks();
  $('#pkGrid').innerHTML = visible.map(cardMarkup).join('');
  $('#pkResultCount').textContent = `Showing ${visible.length} ${visible.length === 1 ? 'park' : 'parks'}`;
  $('#pkShowResults').textContent = `Show ${visible.length} ${visible.length === 1 ? 'park' : 'parks'}`;
  $('#pkEmpty').hidden = visible.length !== 0;
  $('#pkGrid').hidden = visible.length === 0;
  $$('.pk-more').forEach((button) => button.addEventListener('click', () => openModal(button.dataset.parkId, button)));
  updateFilterBadge();
}

function buildStateOptions() {
  const counts = new Map();
  parks.forEach((park) => placesFor(park).forEach((place) => counts.set(place, (counts.get(place) || 0) + 1)));
  const options = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  $('#pkStateFilter').innerHTML = `<button class="pk-state-all active" id="pkAllStates" type="button" aria-pressed="true">All states & territories <span>${parks.length}</span></button>` +
    options.map(([place, count]) => `<label class="pk-state-option"><input type="checkbox" value="${esc(place)}"><span class="pk-state-name">${esc(place)}</span><span class="pk-state-count">${count}</span></label>`).join('');
  $('#pkAllStates').addEventListener('click', () => {
    state.places.clear();
    $$('#pkStateFilter input').forEach((input) => { input.checked = false; });
    updateStateOptions();
    renderGrid();
  });
  $$('#pkStateFilter input').forEach((input) => input.addEventListener('change', () => {
    if (input.checked) state.places.add(input.value);
    else state.places.delete(input.value);
    updateStateOptions();
    renderGrid();
  }));
}

function updateStateOptions() {
  const all = state.places.size === 0;
  $('#pkAllStates').classList.toggle('active', all);
  $('#pkAllStates').setAttribute('aria-pressed', String(all));
}

function bindFilters() {
  $$('#pkStatusFilter button').forEach((button) => button.addEventListener('click', () => {
    state.status = button.dataset.status;
    $$('#pkStatusFilter button').forEach((item) => item.classList.toggle('active', item === button));
    renderGrid();
  }));
  $('#pkResetFilters').addEventListener('click', resetFilters);
  $('#pkEmptyReset').addEventListener('click', resetFilters);
  $('#pkShowResults').addEventListener('click', closeDrawer);
}

function resetFilters() {
  state.status = 'all'; state.places.clear();
  $$('#pkStateFilter input').forEach((input) => { input.checked = false; });
  updateStateOptions();
  $$('#pkStatusFilter button').forEach((button) => button.classList.toggle('active', button.dataset.status === 'all'));
  renderGrid();
}

function updateFilterBadge() {
  const count = Number(state.status !== 'all') + state.places.size;
  const badge = $('#pkFilterBadge');
  badge.hidden = count === 0;
  badge.textContent = String(count);
}

function openDrawer() {
  const drawer = $('#pkFilterDrawer');
  const scrim = $('#pkDrawerScrim');
  document.body.classList.add('pk-filter-open');
  drawer.inert = false; drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false');
  $('#pkFilterTrigger').setAttribute('aria-expanded', 'true');
  scrim.hidden = false; requestAnimationFrame(() => scrim.classList.add('open'));
  setTimeout(() => $('#pkDrawerClose').focus(), 180);
}

function closeDrawer() {
  const drawer = $('#pkFilterDrawer');
  const scrim = $('#pkDrawerScrim');
  document.body.classList.remove('pk-filter-open');
  drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); drawer.inert = true;
  $('#pkFilterTrigger').setAttribute('aria-expanded', 'false');
  scrim.classList.remove('open'); setTimeout(() => { scrim.hidden = true; }, 280);
}

function bindDrawer() {
  $('#pkFilterTrigger').addEventListener('click', openDrawer);
  $('#pkDrawerClose').addEventListener('click', closeDrawer);
  $('#pkDrawerScrim').addEventListener('click', closeDrawer);
}

function openModal(id, trigger) {
  const park = parks.find((item) => item.id === id);
  if (!park) return;
  lastFocus = trigger;
  $('#pkModalImage').src = posterSrc(park.id);
  $('#pkModalImage').alt = `${park.name} National Park poster`;
  $('#pkModalLocation').textContent = park.state;
  $('#pkModalTitle').textContent = park.name;
  $('#pkModalYear').textContent = park.established;
  $('#pkModalFacts').innerHTML = park.facts.slice(0, 3).map((fact) => `<li>${esc(fact)}</li>`).join('');
  $('#pkModalCenters').innerHTML = (park.visitorCenters || []).map((center) => {
    const query = encodeURIComponent(`${center}, ${park.name} National Park, ${park.state}`);
    return `<li><a href="https://www.google.com/maps/search/?api=1&query=${query}" target="_blank" rel="noopener noreferrer" aria-label="${esc(center)} on Google Maps (opens in a new tab)">${esc(center)}<span aria-hidden="true"> ↗</span></a></li>`;
  }).join('');
  $('#pkModalHikes').innerHTML = park.hikes.slice(0, 3).map((hike) => {
    const direct = park.hikeLinks?.[hike] || DIRECT_HIKE_MATCHES[`${park.id}|${hike}`];
    const query = encodeURIComponent(`site:alltrails.com/trail ${hike} ${park.name} ${park.state}`);
    const url = direct || `https://www.google.com/search?q=${query}`;
    const action = direct ? 'View on AllTrails' : 'Search AllTrails via Google';
    return `<li><a href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(hike)}: ${action} (opens in a new tab)" title="${action}"><span class="pk-trail-name">${esc(hike)}${direct ? '' : '<small>Search AllTrails</small>'}</span><span aria-hidden="true">↗</span></a></li>`;
  }).join('');
  const modal = $('#pkModal');
  modal.hidden = false;
  document.body.classList.add('pk-no-scroll');
  $('.top-nav').inert = true;
  $('.pk-main').inert = true;
  $('#pkFilterTrigger').inert = true;
  $('.pk-modal-content').scrollTop = 0;
  requestAnimationFrame(() => $('.pk-modal-close', modal).focus());
}

function closeModal() {
  const modal = $('#pkModal');
  if (modal.hidden) return;
  modal.hidden = true;
  document.body.classList.remove('pk-no-scroll');
  $('.top-nav').inert = false;
  $('.pk-main').inert = false;
  $('#pkFilterTrigger').inert = false;
  if (lastFocus) lastFocus.focus();
}

function bindModal() {
  $$('[data-modal-close]').forEach((item) => item.addEventListener('click', closeModal));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Tab' && !$('#pkModal').hidden) {
      const items = [...$('#pkModal').querySelectorAll('button, a[href]')];
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    if (event.key === 'Escape') {
      if (!$('#pkModal').hidden) closeModal();
      else if ($('#pkFilterDrawer').classList.contains('open')) closeDrawer();
    }
  });
}

async function init() {
  const response = await fetch('/data/parks.json');
  if (!response.ok) throw new Error(`Could not load parks data (${response.status})`);
  parks = (await response.json()).sort((a, b) => a.name.localeCompare(b.name));
  $('#pkVisitedTotal').textContent = VISITED.size;
  const allCount = parks.length, visitedCount = VISITED.size;
  $('[data-status="all"] span').textContent = allCount;
  $('[data-status="visited"] span').textContent = visitedCount;
  $('[data-status="unvisited"] span').textContent = allCount - visitedCount;
  buildStateOptions(); bindFilters(); bindDrawer(); bindModal(); renderGrid();
}

init().catch((error) => {
  console.error(error);
  $('#pkGrid').innerHTML = '<p class="pk-load-error">The park collection could not be loaded.</p>';
});
