// Pure-function tests for site/js/dashboard/engine.js. Run with: node --test tests/js/
//
// engine.js defines TrackLayer as `L.Layer.extend({...})` at module load
// time, so simply require()-ing the file needs a minimal Leaflet stub —
// none of the tests below touch TrackLayer itself (that needs a real
// Leaflet map + DOM), only the plain geometry/color helpers alongside it.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

global.L = { Layer: { extend: obj => obj } };

const { distToSegment, cellSizeDeg, cellKey, maxOf, bucketForFreq, hexToRgb, rgbToHex, lerpColor } =
  require(path.join('..', '..', 'site', 'js', 'dashboard', 'engine.js'));

test('distToSegment: point exactly on the segment is distance 0', () => {
  assert.equal(distToSegment(5, 0, 0, 0, 10, 0), 0);
});

test('distToSegment: perpendicular distance from a horizontal segment', () => {
  assert.equal(distToSegment(5, 3, 0, 0, 10, 0), 3);
});

test('distToSegment: clamps to the nearest endpoint beyond the segment\'s ends', () => {
  // Point is off to the left of the segment's start, not above its middle.
  assert.equal(distToSegment(-4, 0, 0, 0, 10, 0), 4);
});

test('distToSegment: degenerate zero-length segment treats it as a point', () => {
  assert.equal(distToSegment(3, 4, 0, 0, 0, 0), 5); // 3-4-5 triangle
});

test('cellSizeDeg: needs more degrees of longitude at higher latitude for the same meter size', () => {
  // Longitude degrees shrink toward the poles — same cellMeters should
  // need MORE degrees of longitude at high latitude than at the equator,
  // while the latitude span stays constant regardless of latitude.
  const equator = cellSizeDeg(0, 100);
  const highLat = cellSizeDeg(60, 100);
  assert.equal(equator.latSize, highLat.latSize);
  assert.ok(highLat.lngSize > equator.lngSize);
});

test('cellKey: same cell coordinates produce the same key', () => {
  const size = cellSizeDeg(37, 20);
  const a = cellKey(37.001, -122.001, size.latSize, size.lngSize);
  const b = cellKey(37.001, -122.001, size.latSize, size.lngSize);
  assert.equal(a, b);
});

test('cellKey: points far enough apart land in different cells', () => {
  const size = cellSizeDeg(37, 20); // ~20m cells
  const a = cellKey(37.0, -122.0, size.latSize, size.lngSize);
  const b = cellKey(37.01, -122.0, size.latSize, size.lngSize); // ~1.1km away
  assert.notEqual(a, b);
});

test('maxOf: returns the maximum of a numeric array', () => {
  assert.equal(maxOf([3, 7, 1, 9, 4]), 9);
});

test('maxOf: single-element and empty arrays', () => {
  assert.equal(maxOf([5]), 5);
  assert.equal(maxOf([]), -Infinity);
});

test('bucketForFreq: frequency 1 is always the first bucket', () => {
  assert.equal(bucketForFreq(1, 10, 5), 0);
});

test('bucketForFreq: frequency at the observed max lands in the last bucket', () => {
  assert.equal(bucketForFreq(10, 10, 5), 4);
});

test('bucketForFreq: buckets increase monotonically with frequency', () => {
  const buckets = 5, maxF = 20;
  let prev = -1;
  for (let f = 1; f <= maxF; f++) {
    const b = bucketForFreq(f, maxF, buckets);
    assert.ok(b >= prev, `bucket regressed at freq=${f}: ${b} < ${prev}`);
    prev = b;
  }
});

test('hexToRgb / rgbToHex round-trip', () => {
  assert.deepEqual(hexToRgb('#ff3366'), [255, 51, 102]);
  assert.equal(rgbToHex([255, 51, 102]), '#ff3366');
});

test('lerpColor: t=0 returns the first color, t=1 returns the second', () => {
  assert.equal(lerpColor('#000000', '#ffffff', 0), '#000000');
  assert.equal(lerpColor('#000000', '#ffffff', 1), '#ffffff');
});

test('lerpColor: t=0.5 is the midpoint', () => {
  assert.equal(lerpColor('#000000', '#ffffff', 0.5), '#808080');
});
