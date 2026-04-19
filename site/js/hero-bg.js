(() => {
  const canvas = document.querySelector('.hero-canvas');
  if (!canvas) return;
  const hero = canvas.parentElement;
  const ctx = canvas.getContext('2d', { alpha: true });
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const SPACING = 34;
  const BASE_R  = 1.1;
  const COLOR   = '45, 90, 61';        // forest-1 in rgb
  const ACCENT  = '94, 168, 120';      // forest-4 in rgb

  let w = 0, h = 0, dpr = 1;
  let mx = -9999, my = -9999;
  let tStart = performance.now();
  let paused = false;
  // Pulse rings emanate from random grid points every few seconds.
  const pulses = [];
  let nextPulseAt = 0;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = hero.getBoundingClientRect();
    w = rect.width;
    h = rect.height;
    canvas.width  = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width  = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function onMove(e) {
    const r = canvas.getBoundingClientRect();
    mx = e.clientX - r.left;
    my = e.clientY - r.top;
  }
  function onLeave() { mx = -9999; my = -9999; }

  function spawnPulse(now) {
    pulses.push({
      x: Math.random() * w,
      y: Math.random() * h,
      born: now,
      life: 2800 + Math.random() * 1200,   // ms
    });
    nextPulseAt = now + 1400 + Math.random() * 1600;
  }

  function frame(now) {
    const t = (now - tStart) / 1000;
    ctx.clearRect(0, 0, w, h);

    if (now > nextPulseAt) spawnPulse(now);
    // Drop expired pulses.
    for (let i = pulses.length - 1; i >= 0; i--) {
      if (now - pulses[i].born > pulses[i].life) pulses.splice(i, 1);
    }

    // Offset the grid so it loops seamlessly while drifting.
    const drift = (t * 6) % SPACING;

    for (let y = -SPACING; y < h + SPACING; y += SPACING) {
      for (let x = -SPACING; x < w + SPACING; x += SPACING) {
        const px0 = x + drift;
        const py0 = y + drift * 0.6;

        // Two crossing sine waves give a soft rippling field.
        const wx = Math.sin(px0 * 0.014 + py0 * 0.009 + t * 1.4) * 5;
        const wy = Math.cos(px0 * 0.011 - py0 * 0.013 + t * 1.1) * 4;
        const px = px0 + wx;
        const py = py0 + wy;

        // Traveling brightness wave from left to right.
        const wavePhase = (Math.sin(px0 * 0.012 - t * 1.8) + 1) * 0.5; // 0..1

        // Mouse proximity boost.
        const dx = px - mx, dy = py - my;
        const dist2 = dx * dx + dy * dy;
        const mouseBoost = dist2 < 200 * 200 ? 1 - Math.sqrt(dist2) / 200 : 0;

        // Pulse ring contribution: dots near the expanding wavefront brighten.
        let pulseBoost = 0;
        for (let i = 0; i < pulses.length; i++) {
          const p = pulses[i];
          const age = (now - p.born) / p.life;            // 0..1
          const radius = age * Math.max(w, h) * 0.7;
          const pdx = px - p.x, pdy = py - p.y;
          const pd  = Math.sqrt(pdx * pdx + pdy * pdy);
          const band = Math.abs(pd - radius);
          if (band < 60) {
            const ringStrength = (1 - band / 60) * (1 - age);
            if (ringStrength > pulseBoost) pulseBoost = ringStrength;
          }
        }

        const alpha  = 0.18 + wavePhase * 0.32 + mouseBoost * 0.55 + pulseBoost * 0.55;
        const radius = BASE_R + wavePhase * 0.6 + mouseBoost * 2.4 + pulseBoost * 1.6;

        // Mouse / pulse-lit dots use the brighter accent color.
        const useAccent = mouseBoost > 0.15 || pulseBoost > 0.25;
        const rgb = useAccent ? ACCENT : COLOR;

        ctx.beginPath();
        ctx.arc(px, py, radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${rgb}, ${Math.min(0.85, alpha)})`;
        ctx.fill();
      }
    }

    if (!paused) rafId = requestAnimationFrame(frame);
  }

  let rafId = 0;
  function start() {
    cancelAnimationFrame(rafId);
    paused = false;
    tStart = performance.now();
    nextPulseAt = tStart + 600;
    rafId = requestAnimationFrame(frame);
  }
  function stop() { paused = true; cancelAnimationFrame(rafId); }

  resize();
  window.addEventListener('resize', () => { resize(); });
  hero.addEventListener('mousemove', onMove);
  hero.addEventListener('mouseleave', onLeave);

  // Pause when the tab isn't visible — saves battery.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop(); else start();
  });

  if (reduced) {
    paused = true;
    requestAnimationFrame(frame);   // single static frame, won't re-schedule
  } else {
    start();
  }
})();
