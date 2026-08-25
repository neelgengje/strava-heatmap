// Pure-function tests for site/js/dashboard/data.js. Run with: node --test tests/js/
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { normalizeTrack, buildHistogram, statsFor } =
  require(path.join('..', '..', 'site', 'js', 'dashboard', 'data.js'));

function fakeActivity(overrides = {}) {
  return {
    id: 42,
    name: 'Test Hike',
    category: 'Hike',
    date: '2026-03-15',
    distance_mi: 5.2,
    elev_gain_ft: 1200,
    moving_time: 3600,
    speed_mph: 1.4,
    pace_min_mi: 11.5,
    coords: [[37, -122], [37.01, -122.01]],
    ...overrides,
  };
}

test('normalizeTrack: builds key from category + id', () => {
  const t = normalizeTrack(fakeActivity({ category: 'Ride', id: 99 }));
  assert.equal(t.key, 'Ride:99');
});

test('normalizeTrack: missing category defaults to Hike, both in category and key', () => {
  const t = normalizeTrack(fakeActivity({ category: undefined, id: 7 }));
  assert.equal(t.category, 'Hike');
  assert.equal(t.key, 'Hike:7');
});

test('normalizeTrack: derives year and month from date', () => {
  const t = normalizeTrack(fakeActivity({ date: '2026-03-15' }));
  assert.equal(t.year, '2026');
  assert.equal(t.month, '2026-03');
});

test('normalizeTrack: moving_time/speed/pace default missing values to 0, not null', () => {
  const t = normalizeTrack(fakeActivity({ moving_time: undefined, speed_mph: undefined, pace_min_mi: undefined }));
  assert.equal(t.moving_time, 0);
  assert.equal(t.speed_mph, 0);
  assert.equal(t.pace_min_mi, 0);
});

test('normalizeTrack: avg_hr/max_hr/calories default missing values to null, not 0', () => {
  // These are legitimately-absent fields (predate any HR strap, or
  // calories hasn't been backfilled) — 0 would be a false reading.
  const t = normalizeTrack(fakeActivity({ avg_hr: undefined, max_hr: undefined, calories: undefined }));
  assert.equal(t.avg_hr, null);
  assert.equal(t.max_hr, null);
  assert.equal(t.calories, null);
});

test('normalizeTrack: real avg_hr/max_hr/calories values pass through untouched', () => {
  const t = normalizeTrack(fakeActivity({ avg_hr: 143, max_hr: 178, calories: 1369 }));
  assert.equal(t.avg_hr, 143);
  assert.equal(t.max_hr, 178);
  assert.equal(t.calories, 1369);
});

test('normalizeTrack: a real zero calorie value (not just missing) is preserved, not nulled', () => {
  // ?? only falls back on null/undefined, not on 0 — this pins that down.
  const t = normalizeTrack(fakeActivity({ calories: 0 }));
  assert.equal(t.calories, 0);
});

test('statsFor: sums distance, elevation, and time across tracks', () => {
  const tracks = [
    normalizeTrack(fakeActivity({ distance_mi: 5, elev_gain_ft: 1000, moving_time: 3600 })),
    normalizeTrack(fakeActivity({ distance_mi: 3, elev_gain_ft: 500, moving_time: 1800 })),
  ];
  const stats = statsFor(tracks);
  assert.equal(stats.count, 2);
  assert.equal(stats.miles, 8);
  assert.equal(stats.elev, 1500);
  assert.equal(stats.time, 5400);
});

test('statsFor: empty list', () => {
  const stats = statsFor([]);
  assert.deepEqual(stats, { count: 0, miles: 0, elev: 0, time: 0 });
});

test('buildHistogram: counts activities per month and per category', () => {
  const tracks = [
    normalizeTrack(fakeActivity({ date: '2026-01-05', category: 'Hike' })),
    normalizeTrack(fakeActivity({ date: '2026-01-20', category: 'Run' })),
    normalizeTrack(fakeActivity({ date: '2026-02-01', category: 'Hike' })),
  ];
  const { months, years, yearTotals } = buildHistogram(tracks);
  const jan = months.find(m => m.key === '2026-01');
  assert.equal(jan.total, 2);
  assert.equal(jan.byCategory.Hike, 1);
  assert.equal(jan.byCategory.Run, 1);
  assert.deepEqual(years, ['2026']);
  assert.equal(yearTotals.get('2026'), 3);
});

test('buildHistogram: fills gap months with zero counts so the timeline axis is continuous', () => {
  const tracks = [
    normalizeTrack(fakeActivity({ date: '2026-01-05' })),
    normalizeTrack(fakeActivity({ date: '2026-04-01' })), // skips Feb, Mar
  ];
  const { months } = buildHistogram(tracks);
  const keys = months.map(m => m.key);
  assert.deepEqual(keys, ['2026-01', '2026-02', '2026-03', '2026-04']);
  assert.equal(months.find(m => m.key === '2026-02').total, 0);
});

test('buildHistogram: empty track list produces no months', () => {
  const { months, years } = buildHistogram([]);
  assert.deepEqual(months, []);
  assert.deepEqual(years, []);
});
