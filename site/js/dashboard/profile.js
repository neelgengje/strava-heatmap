// ── Elevation profile ─────────────────────────────────────────
// Canvas-drawn elevation-over-distance chart with cursor scrub and a
// replay mode (ghost marker walks the route on its own). No duration/pace
// curve — streams only carry distance/altitude/latlng, no timestamps.

class ElevationProfile {
  constructor(canvas, { color = '#c44535', onMove, onLeave } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.color = color;
    this.onMove = onMove || (() => {});
    this.onLeave = onLeave || (() => {});
    this.data = null;
    this._replayRun = 0; // must start numeric — ++undefined is NaN, and NaN !== NaN would abort every replay on frame 1
    this.showHr = false;
    this._bindInteraction();

    let resizeTO;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTO);
      resizeTO = setTimeout(() => this.relayout(), 150);
    });
  }

  setColor(color) { this.color = color; }

  setShowHeartRate(on) {
    this.showHr = !!on;
    this.draw();
  }

  async load(activityId) {
    this.data = null;
    const res = await fetch(`/data/streams/${activityId}.json`);
    if (!res.ok) throw new Error('no stream');
    const { distance, altitude, latlng, heartrate } = await res.json();
    if (!distance?.length) throw new Error('empty');

    const distMi = distance.map(d => d / 1609.34);
    const elevFt = altitude.map(a => a * 3.28084);
    const maxDist = distMi[distMi.length - 1];
    const minElev = Math.min(...elevFt);
    const maxElev = Math.max(...elevFt);

    // heartrate is absent for older/non-HR activities, and Strava streams
    // carry `null` gaps even within an HR-having activity — filter those
    // out before taking min/max, or a single null (coerced to 0 by
    // Math.min) would crush the whole scale into the top sliver of the band.
    const hrValid = (heartrate || []).filter(v => Number.isFinite(v) && v > 0);
    const minHr = hrValid.length ? Math.min(...hrValid) : 0;
    const maxHr = hrValid.length ? Math.max(...hrValid) : 0;

    this.data = {
      distMi, elevFt, latlng: latlng || [], maxDist, minElev, elevRange: (maxElev - minElev) || 1,
      hrBpm: heartrate || [], minHr, hrRange: (maxHr - minHr) || 1,
    };
    this._layout();
    this.draw();
    return this.data;
  }

  _layout() {
    const dpr = window.devicePixelRatio || 1;
    const wrap = this.canvas.parentElement;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    this.canvas.width = W * dpr;
    this.canvas.height = H * dpr;
    this.canvas.style.width = W + 'px';
    this.canvas.style.height = H + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.padL = 40; this.padR = 8; this.padT = 6; this.padB = 18;
    this.W = W; this.H = H;
    this.cW = W - this.padL - this.padR;
    this.cH = H - this.padT - this.padB;

    // Reads the theme's own ink-3/line tokens for axis label/grid colour
    // rather than a hardcoded value, so the chart always matches its panel.
    const themeCs = getComputedStyle(this.canvas.parentElement);
    this._labelColor = (themeCs.getPropertyValue('--ink-3') || '#7d766c').trim();
    this._gridColor = (themeCs.getPropertyValue('--line') || '#d5d0c8').trim();
    // The scrub/replay dot uses the theme's accent rather than
    // this.color (the line's own sport colour) — same colour on top of
    // itself made the moving dot hard to track against the line,
    // especially during replay.
    this._cursorColor = (themeCs.getPropertyValue('--accent') || '#c44535').trim();
    // Fixed regardless of this.color (the line's own sport colour) — HR
    // needs to read the same way on every activity, not blend into
    // whichever sport happens to be selected.
    this._hrColor = (themeCs.getPropertyValue('--hr') || '#7fb0d9').trim();
  }

  // Re-measures the canvas's parent and redraws — call again once a
  // mid-transition container (e.g. a panel animating open) settles.
  relayout() {
    if (!this.canvas.isConnected) return;
    this._layout();
    this.draw();
  }

  draw(cursorIdx = null) {
    if (!this.data) return;
    const { distMi, elevFt, maxDist, minElev, elevRange } = this.data;
    const { ctx, padL, padT, cW, cH, W, H } = this;

    ctx.clearRect(0, 0, W, H);

    // grid
    ctx.strokeStyle = this._gridColor;
    ctx.fillStyle = this._labelColor;
    ctx.font = '600 10px Inter, sans-serif';
    ctx.textAlign = 'right';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 3; i++) {
      const y = padT + cH - (i / 3) * cH;
      const val = Math.round(minElev + (i / 3) * elevRange);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + cW, y); ctx.stroke();
      ctx.fillText(`${val.toLocaleString()}`, padL - 6, y + 3);
    }

    // fill + line
    const xAt = i => padL + (distMi[i] / maxDist) * cW;
    const yAt = i => padT + cH - ((elevFt[i] - minElev) / elevRange) * cH;

    // Heart rate drawn first, so the elevation gradient below washes over
    // its lower half — reads as ambient depth behind the terrain, not a
    // second chart competing with it.
    if (this.showHr) this._drawHeartRate(xAt);

    ctx.beginPath();
    ctx.moveTo(xAt(0), padT + cH);
    for (let i = 0; i < distMi.length; i++) ctx.lineTo(xAt(i), yAt(i));
    ctx.lineTo(xAt(distMi.length - 1), padT + cH);
    ctx.closePath();
    // Three-stop rather than two: a brighter cap right under the line
    // that falls off fast, then a long, faint tail down to the axis —
    // reads as a glow sitting on the line instead of a flat wash.
    const grad = ctx.createLinearGradient(0, padT, 0, padT + cH);
    grad.addColorStop(0, this.color + '4d');
    grad.addColorStop(0.35, this.color + '1a');
    grad.addColorStop(1, this.color + '03');
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < distMi.length; i++) i === 0 ? ctx.moveTo(xAt(i), yAt(i)) : ctx.lineTo(xAt(i), yAt(i));
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = this.color + '80';
    ctx.shadowBlur = 6;
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.shadowBlur = 0;

    if (cursorIdx != null) this._drawCursor(cursorIdx, xAt, yAt);
  }

  // Its own vertical band within the chart (not the full height) so the
  // trace never touches the axis labels or box edges, and never reads as a
  // second full-scale series competing with elevation. Flat stroke, no
  // fill, no glow, no axis of its own — it's ambient context, not a metric
  // meant to be read directly off the chart (avg/max HR live in the stat
  // row instead).
  // Shared with _drawCursor so the line and its scrub marker always agree
  // on where a given bpm value sits vertically.
  _hrYAt(i) {
    const { hrBpm, minHr, hrRange } = this.data;
    const { padT, cH } = this;
    const bandBottom = padT + cH * 0.92;
    const bandH = cH * 0.84; // 0.92 - 0.08, the band's top/bottom inset
    return bandBottom - ((hrBpm[i] - minHr) / hrRange) * bandH;
  }

  _drawHeartRate(xAt) {
    const { hrBpm, hrRange } = this.data;
    if (!hrBpm.length || !hrRange) return;
    const { ctx } = this;

    ctx.save();
    ctx.strokeStyle = this._hrColor;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.42; // matches the validated mockup — muted, not a competing series
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < hrBpm.length; i++) {
      const v = hrBpm[i];
      // Strava streams carry `null` gaps — start a fresh subpath after one
      // instead of drawing a straight line through the dropout.
      if (!Number.isFinite(v) || v <= 0) { started = false; continue; }
      const x = xAt(i), y = this._hrYAt(i);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  _drawCursor(idx, xAt, yAt) {
    const { ctx, padT, cH } = this;
    const { elevFt, distMi, hrBpm } = this.data;
    const x = xAt(idx), y = yAt(idx);

    ctx.save();
    ctx.strokeStyle = this.color;
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + cH); ctx.stroke();
    ctx.setLineDash([]);

    // HR marker rides its own curve in step with the elevation marker, so
    // scrubbing reads as "heart rate climbed here, dropped there" instead
    // of only a bpm number in the tooltip. Drawn before the elevation dot
    // so that one stays visually primary on the frames where they nearly
    // coincide. Skipped at a null-gap sample even while HR is toggled on.
    const hrValue = hrBpm?.[idx];
    const showHrDot = this.showHr && Number.isFinite(hrValue) && hrValue > 0;
    if (showHrDot) {
      const hy = this._hrYAt(idx);
      ctx.beginPath();
      ctx.arc(x, hy, 4, 0, Math.PI * 2);
      ctx.fillStyle = this._hrColor;
      ctx.fill();
      ctx.strokeStyle = 'rgba(15,18,28,0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(x, y, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = this._cursorColor;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const baseText = `${Math.round(elevFt[idx]).toLocaleString()} ft · ${distMi[idx].toFixed(1)} mi`;
    // The bpm segment is colored to match the HR dot above — the same
    // implicit pairing the elevation number already has with its own
    // (accent-colored) dot.
    const hrText = showHrDot ? ` · ${Math.round(hrValue)} bpm` : '';
    ctx.font = '10px Inter, sans-serif';
    const tw = ctx.measureText(baseText + hrText).width + 12;
    const tx = Math.min(Math.max(x - tw / 2, this.padL), this.padL + this.cW - tw);

    // Default: label sits above the point. Near the profile's peak
    // there isn't room above the point for the box, so flip it below
    // instead — otherwise it clips against the canvas top edge.
    const boxH = 18;
    let ty = y - boxH - 8;
    if (ty < padT) ty = y + 10;
    ty = Math.min(ty, padT + cH - boxH);

    ctx.fillStyle = 'rgba(30,26,22,0.88)';
    ctx.beginPath();
    ctx.roundRect(tx, ty, tw, boxH, 4);
    ctx.fill();
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.fillText(baseText, tx + 6, ty + 13);
    if (hrText) {
      ctx.fillStyle = this._hrColor;
      ctx.fillText(hrText, tx + 6 + ctx.measureText(baseText).width, ty + 13);
    }
    ctx.restore();
  }

  _idxForDist(d) {
    const { distMi } = this.data;
    let idx = 0, best = Infinity;
    for (let i = 0; i < distMi.length; i++) {
      const diff = Math.abs(distMi[i] - d);
      if (diff < best) { best = diff; idx = i; }
    }
    return idx;
  }

  _bindInteraction() {
    const scrubTo = clientX => {
      if (!this.data) return;
      const rect = this.canvas.getBoundingClientRect();
      const mx = clientX - rect.left;
      const dist = ((mx - this.padL) / this.cW) * this.data.maxDist;
      if (dist < 0 || dist > this.data.maxDist) return this._leave();
      const idx = this._idxForDist(dist);
      this.draw(idx);
      this.onMove(this.data.latlng[idx], idx);
    };

    this.canvas.addEventListener('mousemove', e => scrubTo(e.clientX));
    this.canvas.addEventListener('mouseleave', () => this._leave());

    // Touch: drag a finger across the chart to scrub, same as mousemove.
    // touchmove is preventDefault'd so the page doesn't scroll out from
    // under an active scrub — the chart is small and fixed, not something
    // anyone's trying to scroll past mid-gesture.
    this.canvas.addEventListener('touchstart', e => {
      if (e.touches.length !== 1) return;
      scrubTo(e.touches[0].clientX);
    }, { passive: true });
    this.canvas.addEventListener('touchmove', e => {
      if (e.touches.length !== 1) return;
      e.preventDefault();
      scrubTo(e.touches[0].clientX);
    }, { passive: false });
    this.canvas.addEventListener('touchend', () => this._leave());
  }

  _leave() {
    this.draw(null);
    this.onLeave();
  }

  // Ghost replay: marker walks the route on its own. A generation id (not
  // a plain boolean) lets re-triggering cancel the in-flight run instead
  // of racing two loops over the same marker.
  replay(durationMs = 6000) {
    if (!this.data) return;
    const myRun = ++this._replayRun;
    const n = this.data.distMi.length;
    const start = performance.now();
    const step = (now) => {
      if (myRun !== this._replayRun) return; // superseded by a newer replay() or stopReplay()
      const t = Math.min(1, (now - start) / durationMs);
      const idx = Math.min(n - 1, Math.floor(t * (n - 1)));
      this.draw(idx);
      this.onMove(this.data.latlng[idx], idx);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  stopReplay() { this._replayRun = (this._replayRun || 0) + 1; }
}
