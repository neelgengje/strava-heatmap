// DOM tests for site/js/dashboard/sport-select.js, using jsdom since this
// class builds and manipulates real DOM (innerHTML, event listeners).
// Run with: node --test tests/js/
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><body></body>');
global.document = dom.window.document;
global.window = dom.window;
// sport-select.js reads ACTIVITY_TYPES as a free variable (config.js's own
// global in the browser).
global.ACTIVITY_TYPES = require(path.join('..', '..', 'site', 'js', 'config.js')).ACTIVITY_TYPES;

const { SportMultiSelect } =
  require(path.join('..', '..', 'site', 'js', 'dashboard', 'sport-select.js'));

function fakeDash(activeSports = new Set(), sportTotals = new Map()) {
  return {
    activeSports,
    sportTotals,
    toggleSport(s) { activeSports.has(s) ? activeSports.delete(s) : activeSports.add(s); },
    clearSportFilter() { activeSports.clear(); },
  };
}

function freshContainer() {
  const el = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(el);
  return el;
}

function click(el) {
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

test('renders one option per activity type in ACTIVITY_TYPES', () => {
  const container = freshContainer();
  new SportMultiSelect(container, { dash: fakeDash() });
  const sports = [...container.querySelectorAll('[data-sport]')].map(o => o.dataset.sport);
  assert.deepEqual(sports, Object.keys(global.ACTIVITY_TYPES));
});

test('option label includes the sport\'s emoji icon and display label', () => {
  const container = freshContainer();
  new SportMultiSelect(container, { dash: fakeDash() });
  const hikeLabel = container.querySelector('[data-sport="Hike"] .year-option-label').textContent;
  assert.ok(hikeLabel.includes(global.ACTIVITY_TYPES.Hike.label));
  assert.ok(hikeLabel.includes(global.ACTIVITY_TYPES.Hike.icon));
});

test('label starts as "All activities" with no active filter', () => {
  const container = freshContainer();
  const ss = new SportMultiSelect(container, { dash: fakeDash() });
  assert.equal(ss.label.textContent, 'All activities');
});

test('clicking a sport option calls dash.toggleSport and shows its label', () => {
  const container = freshContainer();
  const dash = fakeDash();
  const ss = new SportMultiSelect(container, { dash });
  click(container.querySelector('[data-sport="Ride"]'));
  assert.ok(dash.activeSports.has('Ride'));
  assert.ok(container.querySelector('[data-sport="Ride"]').classList.contains('checked'));
  assert.equal(ss.label.textContent, global.ACTIVITY_TYPES.Ride.label);
});

test('selecting two sports updates the label to "N types"', () => {
  const container = freshContainer();
  const dash = fakeDash();
  const ss = new SportMultiSelect(container, { dash });
  click(container.querySelector('[data-sport="Ride"]'));
  click(container.querySelector('[data-sport="Run"]'));
  assert.equal(ss.label.textContent, '2 types');
});

test('Clear selection button empties the filter and resets the label', () => {
  const container = freshContainer();
  const dash = fakeDash();
  const ss = new SportMultiSelect(container, { dash });
  click(container.querySelector('[data-sport="Hike"]'));
  click(container.querySelector('.year-select-clear'));
  assert.equal(dash.activeSports.size, 0);
  assert.equal(ss.label.textContent, 'All activities');
});

test('refresh() re-syncs checkmarks when the filter changed from outside the component', () => {
  const container = freshContainer();
  const dash = fakeDash();
  const ss = new SportMultiSelect(container, { dash });
  dash.activeSports.add('TrailRun');
  ss.refresh();
  assert.ok(container.querySelector('[data-sport="TrailRun"]').classList.contains('checked'));
});
