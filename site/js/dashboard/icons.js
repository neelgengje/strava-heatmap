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
// The list renders ~390 of these on every load, so this whole function is
// indexed for-loops over typed arrays rather than `.forEach(([lat,lng]) =>
// ...)`/`.map()` (an array-destructure or a fresh array per point, ~390x
// over) and simplifyRDPCore below is iterative over index ranges into those
// same arrays instead of recursively slicing/concatenating new point arrays
// at every level — together ~150ms -> ~30ms across a full activity list.
function routeSparklineSvg(coords, size = 48, strokeWidth = 1.6, color = 'currentColor', maxPoints = 50) {
  if (!coords || coords.length < 2) return '';
  const n = coords.length;

  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (let i = 0; i < n; i++) {
    const c = coords[i];
    const lat = c[0], lng = c[1];
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
  }
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

  const xs = new Float64Array(n), ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = coords[i];
    xs[i] = offX + ((c[1] - minLng) / lngRange) * drawW;
    ys[i] = offY + (1 - (c[0] - minLat) / latRange) * drawH;
  }

  // 0.6px tolerance: corners smaller than that aren't visible at thumbnail
  // scale anyway, and simplifying in already-projected pixel space means the
  // tolerance is perceptually meaningful instead of an arbitrary degree value.
  let px;
  if (n < 3) {
    px = [[xs[0], ys[0]], [xs[n - 1], ys[n - 1]]];
  } else {
    const keep = new Uint8Array(n);
    simplifyRDPCore(xs, ys, 0, n - 1, 0.6, keep);
    px = [];
    for (let i = 0; i < n; i++) if (keep[i]) px.push([xs[i], ys[i]]);
  }
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

// Iterative core: an explicit stack of [lo,hi] index ranges into shared xs/ys
// typed arrays, marking survivors into `keep`, instead of recursively
// slicing out and concatenating new point arrays at every level. Same
// left-to-right, strict-`>` tie-break as the recursive version it replaced,
// so it marks exactly the same points.
function simplifyRDPCore(xs, ys, lo, hi, epsilon, keep) {
  keep[lo] = 1; keep[hi] = 1;
  const stack = [[lo, hi]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const x1 = xs[a], y1 = ys[a], x2 = xs[b], y2 = ys[b];
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1e-9;
    let maxDist = -1, index = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((xs[i] - x1) * dy - (ys[i] - y1) * dx) / len;
      if (d > maxDist) { maxDist = d; index = i; }
    }
    if (maxDist > epsilon) {
      keep[index] = 1;
      stack.push([a, index], [index, b]);
    }
  }
}

// Public wrapper kept for the test suite and any other array-of-pairs
// caller — routeSparklineSvg above calls simplifyRDPCore directly on its
// own typed arrays to skip this conversion.
function simplifyRDP(points, epsilon) {
  const n = points.length;
  if (n < 3) return points;
  const xs = new Float64Array(n), ys = new Float64Array(n);
  for (let i = 0; i < n; i++) { xs[i] = points[i][0]; ys[i] = points[i][1]; }
  const keep = new Uint8Array(n);
  simplifyRDPCore(xs, ys, 0, n - 1, epsilon, keep);
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

// Node-only export for the test suite (tests/js/) — a no-op in the browser,
// where this file loads as a plain <script> and `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { routeSparklineSvg, simplifyRDP };
}
