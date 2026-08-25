// ── Route sparkline ──────────────────────────────────────────
// Tiny route-shaped thumbnail from a track's own coords. Points are
// projected to the final pixel square first, then simplified with
// Ramer-Douglas-Peucker (keeps corners, drops points close enough to the
// straight line between their neighbors) rather than naive even-index
// sampling, which smoothed switchback-heavy trails into a vague squiggle
// regardless of how unevenly GPS points are spaced along the route.
// maxPoints is a safety cap for pathological tracks RDP can't shrink enough
// — the list renders ~390 of these at once, unsampled that's ~147k SVG
// points in the DOM.
function routeSparklineSvg(coords, size = 48, strokeWidth = 1.6, color = 'currentColor', maxPoints = 50) {
  if (!coords || coords.length < 2) return '';

  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  coords.forEach(([lat, lng]) => {
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
  });
  const latRange = (maxLat - minLat) || 1e-6;
  const lngRange = (maxLng - minLng) || 1e-6;
  const pad = size * 0.12;
  const inner = size - pad * 2;
  // A degree of longitude is narrower than a degree of latitude away from the
  // equator (same correction as cellSizeDeg() in engine.js). Fold that into
  // the true width/height so the route isn't stretched to fill the square.
  const lngScale = Math.max(0.15, Math.cos((minLat + maxLat) / 2 * Math.PI / 180));
  const widthMeters = lngRange * lngScale;
  const heightMeters = latRange;
  const shapeScale = inner / Math.max(widthMeters, heightMeters);
  let drawW = widthMeters * shapeScale;
  let drawH = heightMeters * shapeScale;
  // Strict aspect preservation squeezes a long, mostly-straight route (an
  // out-and-back road ride, a bridge run) into a sliver a couple of device
  // pixels tall once the 38px box and its own stroke width eat into that —
  // technically faithful, but unreadable as a route shape. About 1 in 10
  // tracks here exceed 2.4:1. Capping the anisotropy trades a bit of literal
  // aspect fidelity for a shape that still reads as a trail.
  const maxAnisotropy = 2.2;
  const minDim = inner / maxAnisotropy;
  if (drawW >= drawH) drawH = Math.max(drawH, minDim);
  else drawW = Math.max(drawW, minDim);
  const offX = pad + (inner - drawW) / 2;
  const offY = pad + (inner - drawH) / 2;

  let px = coords.map(([lat, lng]) => [
    offX + ((lng - minLng) / lngRange) * drawW,
    offY + (1 - (lat - minLat) / latRange) * drawH,
  ]);

  // 0.6px tolerance: corners smaller than that aren't visible at thumbnail
  // scale anyway, and simplifying in already-projected pixel space means the
  // tolerance is perceptually meaningful instead of an arbitrary degree value.
  px = simplifyRDP(px, 0.6);
  if (px.length > maxPoints) {
    const step = (px.length - 1) / (maxPoints - 1);
    const sampled = [];
    for (let i = 0; i < maxPoints; i++) sampled.push(px[Math.round(i * step)]);
    px = sampled;
  }

  const pts = px.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function simplifyRDP(points, epsilon) {
  if (points.length < 3) return points;
  const [x1, y1] = points[0], [x2, y2] = points[points.length - 1];
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1e-9;
  let maxDist = -1, index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const d = Math.abs((x - x1) * dy - (y - y1) * dx) / len;
    if (d > maxDist) { maxDist = d; index = i; }
  }
  if (maxDist > epsilon) {
    const left = simplifyRDP(points.slice(0, index + 1), epsilon);
    const right = simplifyRDP(points.slice(index), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[points.length - 1]];
}

// Node-only export for the test suite (tests/js/) — a no-op in the browser,
// where this file loads as a plain <script> and `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { routeSparklineSvg, simplifyRDP };
}
