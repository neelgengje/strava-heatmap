// ── Route sparkline ──────────────────────────────────────────
// Tiny route-shaped thumbnail from a track's own coords. `maxPoints`
// subsamples — the list renders ~390 of these at once, and unsampled
// that's ~147k SVG points in the DOM.
function routeSparklineSvg(coords, size = 48, strokeWidth = 1.6, color = 'currentColor', maxPoints = 40) {
  if (!coords || coords.length < 2) return '';
  if (coords.length > maxPoints) {
    const step = (coords.length - 1) / (maxPoints - 1);
    const sampled = [];
    for (let i = 0; i < maxPoints; i++) sampled.push(coords[Math.round(i * step)]);
    coords = sampled;
  }
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
  const drawW = widthMeters * shapeScale;
  const drawH = heightMeters * shapeScale;
  const offX = pad + (inner - drawW) / 2;
  const offY = pad + (inner - drawH) / 2;
  const pts = coords.map(([lat, lng]) => {
    const x = offX + ((lng - minLng) / lngRange) * drawW;
    const y = offY + (1 - (lat - minLat) / latRange) * drawH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}
