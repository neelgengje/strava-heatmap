// Pure-function tests for site/js/dashboard/icons.js. Run with: node --test tests/js/
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { routeSparklineSvg, simplifyRDP } =
  require(path.join('..', '..', 'site', 'js', 'dashboard', 'icons.js'));

test('routeSparklineSvg: fewer than 2 coords produces nothing', () => {
  assert.equal(routeSparklineSvg([], 48), '');
  assert.equal(routeSparklineSvg([[37, -122]], 48), '');
});

test('routeSparklineSvg: produces a valid, sized SVG for a real route', () => {
  const coords = [[37.0, -122.0], [37.01, -122.0], [37.01, -122.01], [37.0, -122.01]];
  const svg = routeSparklineSvg(coords, 38, 1.4, '#ff3366');
  assert.match(svg, /^<svg width="38" height="38" viewBox="0 0 38 38">/);
  assert.match(svg, /<polyline points="[^"]+"/);
  assert.match(svg, /stroke="#ff3366"/);
  assert.match(svg, /stroke-width="1.4"/);
});

test('routeSparklineSvg: uses the default color when none is given', () => {
  const coords = [[37.0, -122.0], [37.01, -122.01]];
  assert.match(routeSparklineSvg(coords, 48), /stroke="currentColor"/);
});

test('routeSparklineSvg: caps point count at maxPoints for a dense track', () => {
  // A jagged zigzag so RDP can't collapse it away — every point carries real shape.
  const coords = [];
  for (let i = 0; i < 500; i++) {
    coords.push([37.0 + (i % 2) * 0.001 + i * 0.00001, -122.0 + i * 0.00001]);
  }
  const svg = routeSparklineSvg(coords, 48, 1.6, 'currentColor', 30);
  const points = svg.match(/points="([^"]+)"/)[1].trim().split(/\s+/);
  assert.ok(points.length <= 30, `expected <=30 points, got ${points.length}`);
});

test('routeSparklineSvg: a degenerate route (all identical coords) still renders without NaN', () => {
  const coords = [[37.0, -122.0], [37.0, -122.0], [37.0, -122.0]];
  const svg = routeSparklineSvg(coords, 48);
  assert.doesNotMatch(svg, /NaN/);
});

// ── simplifyRDP ──────────────────────────────────────────────────────────

test('simplifyRDP: fewer than 3 points passes through unchanged', () => {
  const pts = [[0, 0], [10, 10]];
  assert.deepEqual(simplifyRDP(pts, 1), pts);
});

test('simplifyRDP: collinear points reduce to just the endpoints', () => {
  const pts = [[0, 0], [2, 0], [4, 0], [6, 0], [8, 0], [10, 0]];
  const out = simplifyRDP(pts, 0.5);
  assert.deepEqual(out, [[0, 0], [10, 0]]);
});

test('simplifyRDP: a real corner beyond epsilon survives simplification', () => {
  const pts = [[0, 0], [5, 0], [10, 0], [10, 5], [10, 10]]; // right-angle bend at [10,0]
  const out = simplifyRDP(pts, 0.5);
  assert.ok(out.some(([x, y]) => x === 10 && y === 0));
});

test('simplifyRDP: a tighter epsilon keeps at least as many points as a looser one', () => {
  const pts = [[0, 0], [3, 1], [6, -1], [9, 2], [12, 0]];
  const loose = simplifyRDP(pts, 5);
  const tight = simplifyRDP(pts, 0.1);
  assert.ok(tight.length >= loose.length);
});
