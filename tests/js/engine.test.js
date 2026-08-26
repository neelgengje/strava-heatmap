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

const {
  distToSegment, hitTestTracks, cellSizeDeg, cellKey, maxOf, bucketForFreq, hexToRgb, rgbToHex, lerpColor,
  buildHitGrid, hitTestGrid,
} = require(path.join('..', '..', 'site', 'js', 'dashboard', 'engine.js'));

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

// hitTestGrid is the accelerated path (see engine.js) that hitTest() now
// actually calls — same contract as hitTestTracks above, so most cases
// mirror it directly, built from a hit grid over the same fixtures.
test('hitTestGrid: finds a track when the point is close to its path', () => {
  const tracks = [fakeTrack('a', [[0, 0], [100, 0]])];
  const grid = buildHitGrid(tracks);
  assert.equal(hitTestGrid({ x: 50, y: 2 }, grid, tracks, () => true, 10), 'a');
});

test('hitTestGrid: returns null when nothing is within tolerance', () => {
  const tracks = [fakeTrack('a', [[0, 0], [100, 0]])];
  const grid = buildHitGrid(tracks);
  assert.equal(hitTestGrid({ x: 50, y: 50 }, grid, tracks, () => true, 10), null);
});

test('hitTestGrid: finds a match far from the origin cell, not just nearby ones', () => {
  const far = fakeTrack('far', [[10000, 10000], [10010, 10000]]);
  const grid = buildHitGrid([far]);
  assert.equal(hitTestGrid({ x: 10005, y: 10001 }, grid, [far], () => true, 10), 'far');
});

test('hitTestGrid: invisible tracks are skipped even when closest', () => {
  const tracks = [fakeTrack('hidden', [[0, 0], [100, 0]])];
  const grid = buildHitGrid(tracks);
  assert.equal(hitTestGrid({ x: 50, y: 1 }, grid, tracks, () => false, 10), null);
});

test('hitTestGrid: picks the nearer of two overlapping candidates', () => {
  const a = fakeTrack('a', [[0, 5], [100, 5]]); // 5px from the target
  const b = fakeTrack('b', [[0, 2], [100, 2]]); // 2px from the target — closer
  const tracks = [a, b];
  const grid = buildHitGrid(tracks);
  assert.equal(hitTestGrid({ x: 50, y: 0 }, grid, tracks, () => true, 10), 'b');
});

test('hitTestGrid: a segment spanning several grid cells is still found', () => {
  // Default cell size is 64px — this segment is ~300px long, so it must
  // have been registered into every cell along its length, not just the
  // one its first point falls in.
  const tracks = [fakeTrack('long', [[0, 0], [300, 0]])];
  const grid = buildHitGrid(tracks);
  assert.equal(hitTestGrid({ x: 250, y: 1 }, grid, tracks, () => true, 10), 'long');
});

test('hitTestGrid: agrees with hitTestTracks across a scattered set of tracks', () => {
  const tracks = [
    fakeTrack('a', [[0, 0], [50, 0], [100, 50]]),
    fakeTrack('b', [[20, 20], [20, 80]]),
    fakeTrack('c', [[500, 500], [520, 505], [540, 500]]),
  ];
  const grid = buildHitGrid(tracks);
  const points = [{ x: 25, y: 2 }, { x: 20, y: 50 }, { x: 60, y: 30 }, { x: 530, y: 502 }, { x: 300, y: 300 }];
  for (const p of points) {
    assert.equal(
      hitTestGrid(p, grid, tracks, () => true, 10),
      hitTestTracks(p, tracks, () => true, 10),
      `mismatch at (${p.x}, ${p.y})`
    );
  }
});

test('buildHitGrid: viewport culling excludes a track entirely outside it, matching hitTestTracks', () => {
  const near = fakeTrack('near', [[0, 0], [100, 0]]);
  const far = fakeTrack('far', [[10000, 10000], [10010, 10000]]);
  const tracks = [near, far];
  // A viewport that only covers the 'near' track's area.
  const culled = buildHitGrid(tracks, 64, -50, -50, 200, 50);
  // 'far' is nowhere near this point, so both should agree it's a miss —
  // but only the culled grid actually never indexed it in the first place.
  assert.equal(hitTestGrid({ x: 50, y: 1 }, culled, tracks, () => true, 10), 'near');
  let farEntries = 0;
  culled.grid.forEach(bucket => {
    for (let i = 0; i < bucket.length; i += 2) if (tracks[bucket[i]].key === 'far') farEntries++;
  });
  assert.equal(farEntries, 0, 'the far track should not appear in a culled grid at all');
});

test('buildHitGrid: culling omits the viewport args (backward compatible) builds the same as before', () => {
  const tracks = [fakeTrack('a', [[0, 0], [100, 0]])];
  const uncalled = buildHitGrid(tracks);
  assert.equal(hitTestGrid({ x: 50, y: 2 }, uncalled, tracks, () => true, 10), 'a');
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
