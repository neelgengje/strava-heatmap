// ── Activity Type Configuration ───────────────────────────
// Colors use the neon palette from the Alpine Dusk design.
const ACTIVITY_TYPES = {
  Hike: {
    label: 'Hiking',
    icon: '⛰',
    pIcon: 'ph-mountains',
    color: '#C5FF3D',   // neon lime
    chartColor: 'rgba(197, 255, 61,',
    stats: ['miles', 'elevation', 'time'],
    drawerVerb: 'Hiked',
  },
  Ride: {
    label: 'Riding',
    icon: '🚴',
    pIcon: 'ph-bicycle',
    color: '#06D6F5',   // electric cyan
    chartColor: 'rgba(6, 214, 245,',
    stats: ['miles', 'elevation', 'time', 'speed'],
    drawerVerb: 'Ridden',
  },
  Run: {
    label: 'Running',
    icon: '🏃',
    pIcon: 'ph-person-simple-run',
    color: '#FF5E3A',   // neon orange
    chartColor: 'rgba(255, 94, 58,',
    stats: ['miles', 'pace', 'time'],
    drawerVerb: 'Run',
  },
  TrailRun: {
    label: 'Trail Running',
    icon: '🌲',
    pIcon: 'ph-tree-evergreen',
    color: '#FF3E8E',   // hot pink
    chartColor: 'rgba(255, 62, 142,',
    stats: ['miles', 'elevation', 'pace', 'time'],
    drawerVerb: 'Run',
  },
  Kayak: {
    label: 'Kayaking',
    icon: '🛶',
    pIcon: 'ph-boat',
    color: '#C44EFF',   // neon magenta
    chartColor: 'rgba(196, 78, 255,',
    stats: ['miles', 'time', 'speed'],
    drawerVerb: 'Paddled',
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
