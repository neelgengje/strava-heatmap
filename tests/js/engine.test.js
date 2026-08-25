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

const { distToSegment, hitTestTracks, cellSizeDeg, cellKey, maxOf, bucketForFreq, hexToRgb, rgbToHex, lerpColor } =
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

// points: array of [x, y] pairs in layer-local coordinates.
function fakeTrack(key, points) {
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  return {
    key,
    coords: points, // hitTestTracks only reads .length off this
    _px: points.flat(),
    _bbox: { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) },
  };
}

test('hitTestTracks: finds a track when the point is close to its path', () => {
  const tracks = [fakeTrack('a', [[0, 0], [100, 0]])];
  assert.equal(hitTestTracks({ x: 50, y: 2 }, tracks, () => true, 10), 'a');
});

test('hitTestTracks: returns null when nothing is within tolerance', () => {
  const tracks = [fakeTrack('a', [[0, 0], [100, 0]])];
  assert.equal(hitTestTracks({ x: 50, y: 50 }, tracks, () => true, 10), null);
});

test('hitTestTracks: bbox rejection does not accidentally reject a real nearby match', () => {
  const near = fakeTrack('near', [[0, 0], [10, 0]]);
  const far = fakeTrack('far', [[10000, 10000], [10010, 10000]]);
  assert.equal(hitTestTracks({ x: 5, y: 1 }, [far, near], () => true, 10), 'near');
});

test('hitTestTracks: invisible tracks are skipped even when closest', () => {
  const tracks = [fakeTrack('hidden', [[0, 0], [100, 0]])];
  assert.equal(hitTestTracks({ x: 50, y: 1 }, tracks, () => false, 10), null);
});

test('hitTestTracks: picks the nearer of two overlapping candidates', () => {
  const a = fakeTrack('a', [[0, 5], [100, 5]]); // 5px from the target
  const b = fakeTrack('b', [[0, 2], [100, 2]]); // 2px from the target — closer
  assert.equal(hitTestTracks({ x: 50, y: 0 }, [a, b], () => true, 10), 'b');
});

test('hitTestTracks: a track with no cached bbox is skipped, not thrown on', () => {
  const noBbox = { key: 'x', coords: [[0, 0], [1, 1]], _px: [0, 0, 1, 1], _bbox: null };
  assert.equal(hitTestTracks({ x: 0, y: 0 }, [noBbox], () => true, 10), null);
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
