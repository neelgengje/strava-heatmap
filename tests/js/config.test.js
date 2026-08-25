// Pure-function tests for site/js/config.js. Run with: node --test tests/js/
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { formatTime, formatPace, typeForCategory, freqColorForType, ACTIVITY_TYPES } =
  require(path.join('..', '..', 'site', 'js', 'config.js'));

test('formatTime: under an hour shows minutes only', () => {
  assert.equal(formatTime(125), '2m'); // 125s -> 2m (floored, not rounded)
});

test('formatTime: an hour or more shows hours and minutes', () => {
  assert.equal(formatTime(3661), '1h 1m');
});

test('formatTime: zero seconds', () => {
  assert.equal(formatTime(0), '0m');
});

test('formatPace: formats minutes:seconds per mile', () => {
  assert.equal(formatPace(9.5), '9:30/mi');
});

test('formatPace: pads single-digit seconds', () => {
  assert.equal(formatPace(9.0833), '9:05/mi'); // 0.0833 min = ~5s
});

test('formatPace: zero or missing pace is a dash, not 0:00', () => {
  assert.equal(formatPace(0), '--');
  assert.equal(formatPace(null), '--');
  assert.equal(formatPace(undefined), '--');
});

test('typeForCategory: known category returns its config', () => {
  assert.equal(typeForCategory('Ride').label, 'Rides');
});

test('typeForCategory: unknown category falls back to Hike', () => {
  assert.equal(typeForCategory('Surfing'), ACTIVITY_TYPES.Hike);
  assert.equal(typeForCategory(undefined), ACTIVITY_TYPES.Hike);
});

test('freqColorForType: frequency buckets are inclusive at each threshold', () => {
  const colors = ACTIVITY_TYPES.Hike.freqColors;
  assert.equal(freqColorForType('Hike', 1), colors[0]);
  assert.equal(freqColorForType('Hike', 2), colors[1]);
  assert.equal(freqColorForType('Hike', 3), colors[2]);
  assert.equal(freqColorForType('Hike', 4), colors[3]);
  assert.equal(freqColorForType('Hike', 6), colors[4]);
  assert.equal(freqColorForType('Hike', 99), colors[4]); // caps at the top bucket
});
