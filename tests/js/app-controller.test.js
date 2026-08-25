// Pure-function tests for statBlock/secondaryStatBlock in
// site/js/dashboard/app-controller.js. Run with: node --test tests/js/
//
// Both functions reference formatTime/formatPace/typeForCategory as free
// variables (config.js's own globals in the browser) — inject config.js's
// real exports onto `global` before requiring app-controller.js, so the
// same real formatting logic runs here, not a duplicate/mocked copy.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const configExports = require(path.join('..', '..', 'site', 'js', 'config.js'));
Object.assign(global, configExports);

const { statBlock, secondaryStatBlock } =
  require(path.join('..', '..', 'site', 'js', 'dashboard', 'app-controller.js'));

function fakeTrack(overrides = {}) {
  return {
    distance_mi: 6.2,
    elev_gain_ft: 1850,
    moving_time: 8040, // 2h 14m
    speed_mph: 0,
    pace_min_mi: 0,
    avg_hr: null,
    max_hr: null,
    calories: null,
    ...overrides,
  };
}

test('statBlock: renders exactly the stats a sport config lists, in order', () => {
  const cfg = { stats: ['miles', 'elevation', 'time'] };
  const html = statBlock(cfg, fakeTrack());
  const labels = [...html.matchAll(/dstat-l">([^<]+)</g)].map(m => m[1]);
  assert.deepEqual(labels, ['Miles', 'Ft Gain', 'Time']);
  assert.match(html, /6\.2/);
  assert.match(html, /1,850/); // toLocaleString on elev_gain_ft
});

test('statBlock: speed shows a dash rather than 0.0 when there is no speed', () => {
  const cfg = { stats: ['speed'] };
  const html = statBlock(cfg, fakeTrack({ speed_mph: 0 }));
  assert.match(html, /dstat-v">--</);
});

test('statBlock: pace formats through the real formatPace()', () => {
  const cfg = { stats: ['pace'] };
  const html = statBlock(cfg, fakeTrack({ pace_min_mi: 9.5 }));
  assert.match(html, /9:30\/mi/);
});

test('secondaryStatBlock: empty when the activity has neither HR nor calories', () => {
  assert.equal(secondaryStatBlock(fakeTrack()), '');
});

test('secondaryStatBlock: omits HR tiles but keeps calories when only calories is known', () => {
  const html = secondaryStatBlock(fakeTrack({ calories: 142 }));
  assert.doesNotMatch(html, /Avg HR/);
  assert.doesNotMatch(html, /Max HR/);
  assert.match(html, /Calories/);
  assert.match(html, /142/);
});

test('secondaryStatBlock: all three tiles appear, in Avg/Max/Calories order, when fully known', () => {
  const html = secondaryStatBlock(fakeTrack({ avg_hr: 143, max_hr: 178, calories: 1369 }));
  const labels = [...html.matchAll(/dstat2nd-l">([^<]+)</g)].map(m => m[1]);
  assert.deepEqual(labels, ['Avg HR', 'Max HR', 'Calories']);
  assert.match(html, />143</);
  assert.match(html, />178</);
  assert.match(html, /1,369/); // toLocaleString on calories
});

test('secondaryStatBlock: a real zero calorie value still renders (not treated as missing)', () => {
  const html = secondaryStatBlock(fakeTrack({ calories: 0 }));
  assert.match(html, /Calories/);
});
