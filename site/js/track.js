/* Cursor track
   The pointer draws a recorded GPS track. Points are joined with
   Catmull-Rom cubics rather than straight segments, so consecutive
   pieces meet C1-continuous and the whole thing reads as one curve.
   A segment is emitted one point behind the cursor (it needs its
   forward neighbour to know which way to bend), so the ink trails
   the pointer by about one MIN_DIST.

   Over the pinned print the track both stops emitting and is masked
   out, so segments already in flight cannot sit on top of the paper. */
(() => {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const NS        = "http://www.w3.org/2000/svg";
  const MIN_DIST  = 20;   // px between track points
  const MAX_SEG   = 230;  // longer jump means a new track, no join
  const MAX_NODES = 260;  // leak guard

  const layer = document.createElementNS(NS, "svg");
  layer.id = "track-layer";
  layer.setAttribute("aria-hidden", "true");
  layer.innerHTML =
    '<defs><mask id="tk-mask" maskUnits="userSpaceOnUse">' +
    '<rect id="tk-all" x="-9999" y="-9999" width="29999" height="29999" fill="#fff"/>' +
    '<rect id="tk-hole" x="0" y="0" width="0" height="0" fill="#000"/>' +
    '</mask></defs><g id="tk-ink" mask="url(#tk-mask)"></g>';
  document.body.appendChild(layer);

  const ink  = layer.querySelector("#tk-ink");
  const hole = layer.querySelector("#tk-hole");
  const print = document.querySelector(".print");

  // ── print box, cached ──────────────────────────────────────
  // Read from an axis-aligned bounding box, so the hole is a couple of
  // px larger than the tilted paper. The track vanishes just before the
  // edge rather than just after it, which is the right side to err on.
  let box = { l: 0, t: 0, r: -1, b: -1 };
  const measure = () => {
    if (!print || getComputedStyle(print).display === "none") {
      box = { l: 0, t: 0, r: -1, b: -1 };
      hole.setAttribute("width", 0); hole.setAttribute("height", 0);
      return;
    }
    const r = print.getBoundingClientRect();
    box = { l: r.left, t: r.top, r: r.right, b: r.bottom };
    hole.setAttribute("x", r.left);   hole.setAttribute("y", r.top);
    hole.setAttribute("width", r.width); hole.setAttribute("height", r.height);
  };
  const overPrint = (x, y) => x >= box.l && x <= box.r && y >= box.t && y <= box.b;

  addEventListener("resize", measure, { passive: true });
  addEventListener("load", measure);
  measure();

  // The print takes half a second to pop out and settle back. A single
  // re-measure at either end would leave the mask hole the wrong size
  // for that whole time, so the ink would clip against a stale box on
  // the way out. Follow the box every frame while it is in motion.
  if (print) {
    let popRaf = 0, until = 0;
    const follow = () => {
      measure();
      popRaf = performance.now() < until ? requestAnimationFrame(follow) : 0;
    };
    const chase = () => {
      until = performance.now() + 620;
      if (!popRaf) popRaf = requestAnimationFrame(follow);
    };
    print.addEventListener("pointerenter", chase);
    print.addEventListener("pointerleave", chase);
    print.addEventListener("transitionend", measure);
  }

  // ── track state ────────────────────────────────────────────
  const buf = [];               // last four points, for the spline
  let pending = null, frame = 0;

  const brk = () => { buf.length = 0; };

  const seg = (p0, p1, p2, p3) => {
    // Catmull-Rom through p0..p3, expressed as the cubic from p1 to p2
    const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
    return "M" + p1.x + " " + p1.y + "C" + c1x + " " + c1y + " " +
           c2x + " " + c2y + " " + p2.x + " " + p2.y;
  };

  const emit = (d, cls) => {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("class", cls);
    p.setAttribute("d", d);
    ink.appendChild(p);
    const L = p.getTotalLength();
    p.setAttribute("stroke-dasharray", L);
    p.style.setProperty("--len", L + "px");
    return p;
  };

  const push = (x, y) => {
    buf.push({ x, y });
    if (buf.length > 4) buf.shift();
    if (buf.length < 3) return;
    const n = buf.length;
    const p1 = buf[n - 3], p2 = buf[n - 2], p3 = buf[n - 1];
    const p0 = buf[n - 4] || p1;
    if (Math.hypot(p2.x - p1.x, p2.y - p1.y) > MAX_SEG) return;
    const d = seg(p0, p1, p2, p3);
    emit(d, "seg");
    // a survey pip every third point, not on every one
    if ((buf.pipN = (buf.pipN || 0) + 1) % 3 === 0) {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("class", "pip");
      c.setAttribute("cx", p2.x); c.setAttribute("cy", p2.y);
      c.setAttribute("r", 2.6);
      ink.appendChild(c);
    }
    while (ink.childElementCount > MAX_NODES) ink.firstElementChild.remove();
  };

  // every node removes itself once its animation finishes
  ink.addEventListener("animationend", e => { e.target.remove(); });

  addEventListener("pointermove", e => {
    if (e.pointerType === "touch") return;
    pending = e;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const ev = pending; pending = null;
      if (!ev) return;
      const x = ev.clientX, y = ev.clientY;

      if (overPrint(x, y)) { brk(); return; }
      const last = buf[buf.length - 1];
      if (last && Math.hypot(x - last.x, y - last.y) < MIN_DIST) return;
      push(x, y);
    });
  }, { passive: true });

  // break the track when the pointer leaves the window or the tab is
  // backgrounded, so it never slashes a line across the page on return
  addEventListener("blur", brk);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { cancelAnimationFrame(frame); frame = 0; }
    brk();
  });
  document.addEventListener("pointerout", e => { if (!e.relatedTarget) brk(); });
})();
