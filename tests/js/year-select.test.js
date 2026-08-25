// DOM tests for site/js/dashboard/year-select.js, using jsdom since this
// class builds and manipulates real DOM (innerHTML, event listeners).
// Run with: node --test tests/js/
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><body></body>');
global.document = dom.window.document;
global.window = dom.window;

const { YearMultiSelect } =
  require(path.join('..', '..', 'site', 'js', 'dashboard', 'year-select.js'));

function fakeDash(activeYears = new Set()) {
  return {
    activeYears,
    toggleYear(y) { activeYears.has(y) ? activeYears.delete(y) : activeYears.add(y); },
    clearYearFilter() { activeYears.clear(); },
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

test('renders one option per year, newest first', () => {
  const container = freshContainer();
  new YearMultiSelect(container, {
    years: ['2024', '2025', '2026'],
    yearTotals: new Map([['2024', 5], ['2025', 10], ['2026', 3]]),
    dash: fakeDash(),
  });
  const years = [...container.querySelectorAll('[data-year]')].map(o => o.dataset.year);
  assert.deepEqual(years, ['2026', '2025', '2024']);
});

test('option shows its count from yearTotals', () => {
  const container = freshContainer();
  new YearMultiSelect(container, { years: ['2026'], yearTotals: new Map([['2026', 42]]), dash: fakeDash() });
  assert.equal(container.querySelector('.year-option-count').textContent, '42');
});

test('label starts as "All years" with no active filter', () => {
  const container = freshContainer();
  const ys = new YearMultiSelect(container, { years: ['2026'], yearTotals: new Map(), dash: fakeDash() });
  assert.equal(ys.label.textContent, 'All years');
});

test('clicking a year option calls dash.toggleYear and checks it', () => {
  const container = freshContainer();
  const dash = fakeDash();
  const ys = new YearMultiSelect(container, { years: ['2026'], yearTotals: new Map(), dash });
  const opt = container.querySelector('[data-year="2026"]');
  click(opt);
  assert.ok(dash.activeYears.has('2026'));
  assert.ok(opt.classList.contains('checked'));
  assert.equal(ys.label.textContent, '2026');
});

test('clicking a checked option again unchecks it (toggle, not just add)', () => {
  const container = freshContainer();
  const dash = fakeDash();
  const opt = () => container.querySelector('[data-year="2026"]');
  new YearMultiSelect(container, { years: ['2026'], yearTotals: new Map(), dash });
  click(opt());
  click(opt());
  assert.equal(dash.activeYears.size, 0);
  assert.ok(!opt().classList.contains('checked'));
});

test('selecting two years updates the label to "N years"', () => {
  const container = freshContainer();
  const dash = fakeDash();
  const ys = new YearMultiSelect(container, { years: ['2025', '2026'], yearTotals: new Map(), dash });
  click(container.querySelector('[data-year="2025"]'));
  click(container.querySelector('[data-year="2026"]'));
  assert.equal(ys.label.textContent, '2 years');
});

test('Clear selection button empties the filter and resets the label', () => {
  const container = freshContainer();
  const dash = fakeDash();
  const ys = new YearMultiSelect(container, { years: ['2026'], yearTotals: new Map(), dash });
  click(container.querySelector('[data-year="2026"]'));
  click(container.querySelector('.year-select-clear'));
  assert.equal(dash.activeYears.size, 0);
  assert.equal(ys.label.textContent, 'All years');
});

test('toggleOpen adds/removes the "open" class on the container', () => {
  const container = freshContainer();
  const ys = new YearMultiSelect(container, { years: ['2026'], yearTotals: new Map(), dash: fakeDash() });
  ys.toggleOpen();
  assert.ok(container.classList.contains('open'));
  ys.toggleOpen();
  assert.ok(!container.classList.contains('open'));
});

test('clicking the trigger button toggles open state', () => {
  const container = freshContainer();
  const ys = new YearMultiSelect(container, { years: ['2026'], yearTotals: new Map(), dash: fakeDash() });
  click(ys.trigger);
  assert.equal(ys.open, true);
  click(ys.trigger);
  assert.equal(ys.open, false);
});

test('refresh() re-syncs checkmarks when the filter changed from outside the component', () => {
  const container = freshContainer();
  const dash = fakeDash();
  const ys = new YearMultiSelect(container, { years: ['2026'], yearTotals: new Map(), dash });
  dash.activeYears.add('2026'); // e.g. the page-level "Clear filters" / external state change
  ys.refresh();
  assert.ok(container.querySelector('[data-year="2026"]').classList.contains('checked'));
});
