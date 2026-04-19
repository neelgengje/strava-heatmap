// ── Activity Type Configuration ───────────────────────────
const ACTIVITY_TYPES = {
  Hike: {
    label: 'Hikes',
    icon: '\u26F0',
    pIcon: 'ph-mountains',
    color: '#ff3366',
    freqColors: ['#ff6688','#ff3366','#e6204e','#cc1040','#991033'],
    stats: ['miles', 'elevation', 'time'],
    drawerVerb: 'Hiked',
    chartColor: 'rgba(255, 51, 102,',
  },
  Ride: {
    label: 'Rides',
    icon: '\uD83D\uDEB4',
    pIcon: 'ph-bicycle',
    color: '#6366f1',
    freqColors: ['#8b8ef5','#6366f1','#5254d8','#4244be','#3234a0'],
    stats: ['miles', 'elevation', 'time', 'speed'],
    drawerVerb: 'Ridden',
    chartColor: 'rgba(99, 102, 241,',
  },
  Run: {
    label: 'Runs',
    icon: '\uD83C\uDFC3',
    pIcon: 'ph-person-simple-run',
    color: '#ff9500',
    freqColors: ['#ffb344','#ff9500','#e68400','#cc7200','#995500'],
    stats: ['miles', 'pace', 'time'],
    drawerVerb: 'Run',
    chartColor: 'rgba(255, 149, 0,',
  },
  TrailRun: {
    label: 'Trail Runs',
    icon: '\uD83C\uDF32',
    pIcon: 'ph-tree-evergreen',
    color: '#bf5af2',
    freqColors: ['#d088f5','#bf5af2','#a840d8','#9030be','#7020a0'],
    stats: ['miles', 'elevation', 'pace', 'time'],
    drawerVerb: 'Run',
    chartColor: 'rgba(191, 90, 242,',
  },
};

// ── Shared Helpers ────────────────────────────────────────
function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatPace(paceMinMi) {
  if (!paceMinMi || paceMinMi <= 0) return '--';
  const mins = Math.floor(paceMinMi);
  const secs = Math.round((paceMinMi - mins) * 60);
  return `${mins}:${secs.toString().padStart(2, '0')}/mi`;
}

function typeForCategory(category) {
  return ACTIVITY_TYPES[category] || ACTIVITY_TYPES.Hike;
}

function freqColorForType(category, freq) {
  const colors = typeForCategory(category).freqColors;
  if (freq >= 6) return colors[4];
  if (freq >= 4) return colors[3];
  if (freq >= 3) return colors[2];
  if (freq >= 2) return colors[1];
  return colors[0];
}
