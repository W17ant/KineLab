/** adv/measure.js - Segment inclination, two-line angle and floor-plane (perspective) length correction */
(() => {
  const MOD = 'measure';
  const ID_RE = /^[\w-]{1,64}$/;
  const RAD = 180 / Math.PI;
  const TAP_PX = 3;          // Why 3 px: same tap-vs-drag threshold the core uses for Line creation
  const ARC_R = 28;          // Arc radius in px, matching the core Angle tool's arc
  const PILL_DX = 16;        // Pill offset from the arc centre, as the core Angle pill
  const PILL_DY = -28;
  const ZERO_DEG = 0.05;     // Below this a readout is shown as exactly 0 (avoids "-0.0°"), as computeLineDegrees
  const CORNER_HIT_PX = 16;  // Grab radius for dragging an existing plane corner
  const MAX_DIM = 1e5;       // Sanity cap for typed/loaded plane dimensions (100 km in m)

  // ============================================================================================
  // Geometry helpers (pixel space). Why pixel space: the video box scales x and y by the same
  // factor, so angles measured on screen pixels equal angles in the video's native pixels,
  // while normalized coords are anisotropic (0..1 on both axes of a non-square frame).
  // ============================================================================================

  const px = (pt, box) => KL.fns.normToPixel(pt, box);

  /**
   * Inclination of a segment relative to the vertical and horizontal, independent of endpoint order.
   * @param {{x,y}} a @param {{x,y}} b  pixel points (canvas y grows downward)
   * @returns {{fromVertical:number, fromHorizontal:number, lean:string, lower:{x,y}, upper:{x,y}}}
   *   fromVertical 0..90 deg = atan2(|dx|, dyUp) where dx/dyUp run from the lower end to the upper
   *   end; fromHorizontal = 90 - fromVertical. lean is 'right'/'left' as seen on screen.
   */
  function segmentInclination(a, b) {
    // Why pick the lower end: the segment has no direction, so always measuring from its lower
    // end upward makes the value identical whichever end was drawn first.
    const lower = a.y > b.y || (a.y === b.y && a.x <= b.x) ? a : b;
    const upper = lower === a ? b : a;
    const dx = upper.x - lower.x;
    const dyUp = lower.y - upper.y; // >= 0
    let fromVertical = (dx === 0 && dyUp === 0) ? 0 : Math.atan2(Math.abs(dx), dyUp) * RAD;
    if (fromVertical < ZERO_DEG) fromVertical = 0;
    let fromHorizontal = 90 - fromVertical;
    if (fromHorizontal < ZERO_DEG) { fromHorizontal = 0; fromVertical = 90; }
    let lean = dx > 0 ? 'right' : 'left';
    if (fromVertical === 0) lean = 'vertical';
    else if (fromHorizontal === 0) lean = 'horizontal';
    return { fromVertical, fromHorizontal, lean, lower, upper };
  }

  /**
   * Angle between two drawn line directions u = p2 - p1 and v = p4 - p3.
   * @returns {{angle:number, acute:number}} angle = acos(u·v / |u||v|) in 0..180 deg,
   *   acute = min(angle, 180 - angle) in 0..90 deg. Zero-length lines give 0.
   */
  function lineAngle(p1, p2, p3, p4) {
    const ux = p2.x - p1.x, uy = p2.y - p1.y, vx = p4.x - p3.x, vy = p4.y - p3.y;
    const nu = Math.hypot(ux, uy), nv = Math.hypot(vx, vy);
    if (nu === 0 || nv === 0) return { angle: 0, acute: 0 };
    const cos = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (nu * nv)));
    const angle = Math.acos(cos) * RAD;
    return { angle, acute: Math.min(angle, 180 - angle) };
  }

  /** Intersection of segments ab and cd as a pixel point, or null when they do not cross. */
  function segmentIntersection(a, b, c, d) {
    const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-9) return null; // parallel
    const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
    const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return { x: a.x + t * rx, y: a.y + t * ry };
  }

  /** Where the two-line arc is drawn: the crossing point, else midway between the nearest ends. */
  function twoLineVertex(p1, p2, p3, p4) {
    const hit = segmentIntersection(p1, p2, p3, p4);
    if (hit) return hit;
    let best = null;
    for (const a of [p1, p2]) for (const b of [p3, p4]) {
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (!best || d < best.d) best = { d, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
    return { x: best.x, y: best.y };
  }

  /** Shortest-way arc of radius r at c from direction angle a1 to a2 (radians); returns ccw flag. */
  function shortArc(ctx, c, r, a1, a2) {
    let diff = a2 - a1;
    while (diff <= -Math.PI) diff += Math.PI * 2;
    while (diff > Math.PI) diff -= Math.PI * 2;
    ctx.arc(c.x, c.y, r, a1, a2, diff < 0);
  }

  function strokeLine(ctx, a, b) {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  function baseStyle(ctx, item, isSel) {
    ctx.strokeStyle = item.color;
    ctx.fillStyle = item.color;
    ctx.lineWidth = isSel ? 3.2 : 2.5; // same widths as core markups
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (item.dashed) ctx.setLineDash([8, 6]);
  }

  /** Push a new two-point-family item, select it and start the creation drag. */
  function addItem(item) {
    KL.annotations.push(item);
    KL.selectedId = item.id;
    KL.fns.syncInspectorUI();
  }

  function removeItem(id) {
    KL.annotations = KL.annotations.filter(a => a.id !== id);
    if (KL.selectedId === id) {
      const shown = KL.fns.visibleAnnotations();
      KL.selectedId = shown.length ? shown[shown.length - 1].id : null;
    }
    KL.fns.syncInspectorUI();
    KL.fns.renderFrame();
  }

  const newId = prefix => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
  const countOf = type => KL.annotations.filter(a => a.type === type).length;
  const fmt = v => v.toFixed(1);

  // ============================================================================================
  // (1) Segment: inclination of one body segment (e.g. trunk, shank) from the vertical
  // ============================================================================================

  const leanText = inc => inc.lean === 'vertical' || inc.lean === 'horizontal'
    ? inc.lean[0].toUpperCase() + inc.lean.slice(1)
    : `Leaning ${inc.lean}`;

  function segmentInc(item, box) { return segmentInclination(px(item.p1, box), px(item.p2, box)); }

  KL.types.segment = {
    handleKeys: () => ['p1', 'p2'],
    render(item, ctx, box, isSel) {
      const p1 = px(item.p1, box), p2 = px(item.p2, box);
      const inc = segmentInclination(p1, p2);
      const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      baseStyle(ctx, item, isSel);
      strokeLine(ctx, p1, p2);

      // Dashed vertical reference rising from the lower end. Why 40..90 px: long enough to read
      // as a plumb, short enough not to cross the rest of the body.
      const refLen = Math.max(40, Math.min(90, len));
      const lo = inc.lower;
      ctx.save();
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 1.6;
      ctx.globalAlpha = 0.85;
      strokeLine(ctx, lo, { x: lo.x, y: lo.y - refLen });
      ctx.restore();

      // Arc between straight-up (-90° on canvas) and the segment direction from the lower end.
      if (len > 1 && inc.fromVertical > 0) {
        const r = Math.min(ARC_R, Math.max(12, len * 0.5));
        const aUp = -Math.PI / 2;
        const aSeg = Math.atan2(inc.upper.y - lo.y, inc.upper.x - lo.x);
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(lo.x, lo.y);
        shortArc(ctx, lo, r, aUp, aSeg);
        ctx.closePath();
        ctx.fillStyle = item.color + '33';
        ctx.fill();
        ctx.beginPath();
        shortArc(ctx, lo, r, aUp, aSeg);
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.setLineDash([]);
      KL.fns.drawHandle(p1.x, p1.y, item.color, false, isSel);
      KL.fns.drawHandle(p2.x, p2.y, item.color, false, isSel);
      const mid = { x: (p1.x + p2.x) / 2 + 10, y: (p1.y + p2.y) / 2 - 14 };
      KL.fns.drawCanvasPill(mid.x, mid.y, `${item.label || 'Segment'} · ${fmt(inc.fromVertical)}° from vertical`, item.color, isSel);
    },
    hitBody: (item, pt, box, dist) => KL.fns.distToSegment(pt, px(item.p1, box), px(item.p2, box)) <= dist,
    readout(item, box) {
      const inc = segmentInc(item, box);
      return {
        value: `${fmt(inc.fromVertical)}°`,
        badge: `${leanText(inc)} · ${fmt(inc.fromHorizontal)}° from horiz.`,
        list: `${fmt(inc.fromVertical)}° vert${inc.lean === 'left' ? ' L' : inc.lean === 'right' ? ' R' : ''}`
      };
    },
    csv(item, box) {
      const inc = segmentInc(item, box);
      return { value: fmt(inc.fromVertical), unit: 'deg', tilt: fmt(inc.fromHorizontal), notes: `from vertical; ${leanText(inc).toLowerCase()} (on screen)` };
    },
    clean: () => true // p1/p2 are validated by the core via handleKeys; no other fields
  };

  /**
   * Shared drag-to-create for the segment tool and each line of the two-line tool.
   * @param {object} item  the new item (already pushed); `moveKey` is the point that follows the pointer
   */
  function startCreateDrag(tool, item, moveKey, pt) {
    KL.startDrag({ tool, item, moveKey, startPx: { x: pt.x, y: pt.y }, moved: false });
  }

  function trackCreateDrag({ pt, normPt, drag }) {
    if (!drag.moved && Math.hypot(pt.x - drag.startPx.x, pt.y - drag.startPx.y) > TAP_PX) drag.moved = true;
    // Why no 5° axis snapping (unlike the core Line): these tools exist to read small leans
    // from vertical, and snapping would turn a real 4° trunk lean into 0°.
    drag.item[drag.moveKey] = { ...normPt };
  }

  KL.tools.segment = {
    prompt: 'Segment: drag along a body segment (e.g. trunk) to read its lean from vertical',
    onDown({ pt, normPt }) {
      const item = {
        id: newId('seg'), type: 'segment', label: `Segment ${countOf('segment') + 1}`,
        color: KL.activeColor, dashed: KL.isDashed, bookmarkId: KL.fns.bookmarkIdForNewItem('segment'),
        p1: { ...normPt }, p2: { ...normPt }
      };
      addItem(item);
      startCreateDrag('segment', item, 'p2', pt);
    },
    onMove: trackCreateDrag,
    onUp({ drag }) {
      // Why: a tap leaves a zero-length segment whose "0° from vertical" would look real.
      if (!drag.moved) removeItem(drag.item.id);
    }
  };

  // ============================================================================================
  // (2) Two-line angle: angle between two independently drawn lines (e.g. shank vs trunk)
  // ============================================================================================

  let pendingLine = null; // { p1, p2, frame } first line of a two-line angle awaiting its second line

  function twoLineGeom(item, box) {
    const p = ['p1', 'p2', 'p3', 'p4'].map(k => px(item[k], box));
    return { p, ...lineAngle(p[0], p[1], p[2], p[3]), vertex: twoLineVertex(p[0], p[1], p[2], p[3]) };
  }

  KL.types.twoline = {
    handleKeys: () => ['p1', 'p2', 'p3', 'p4'],
    render(item, ctx, box, isSel) {
      const g = twoLineGeom(item, box);
      const [p1, p2, p3, p4] = g.p;
      baseStyle(ctx, item, isSel);
      strokeLine(ctx, p1, p2);
      strokeLine(ctx, p3, p4);
      ctx.setLineDash([]);
      // Arc spans the angle between the drawn directions u (p1->p2) and v (p3->p4), so its sweep
      // equals the readout (0..180).
      if (g.angle > ZERO_DEG) {
        const a1 = Math.atan2(p2.y - p1.y, p2.x - p1.x);
        const a2 = Math.atan2(p4.y - p3.y, p4.x - p3.x);
        ctx.beginPath();
        ctx.moveTo(g.vertex.x, g.vertex.y);
        shortArc(ctx, g.vertex, ARC_R, a1, a2);
        ctx.closePath();
        ctx.fillStyle = item.color + '33';
        ctx.fill();
        ctx.beginPath();
        shortArc(ctx, g.vertex, ARC_R, a1, a2);
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      for (const q of g.p) KL.fns.drawHandle(q.x, q.y, item.color, false, isSel);
      KL.fns.drawCanvasPill(g.vertex.x + PILL_DX, g.vertex.y + PILL_DY, `${item.label || 'Lines'} · ${fmt(g.angle)}°`, item.color, isSel);
    },
    hitBody(item, pt, box, dist) {
      const [p1, p2, p3, p4] = ['p1', 'p2', 'p3', 'p4'].map(k => px(item[k], box));
      return KL.fns.distToSegment(pt, p1, p2) <= dist || KL.fns.distToSegment(pt, p3, p4) <= dist;
    },
    readout(item, box) {
      const g = twoLineGeom(item, box);
      return { value: `${fmt(g.angle)}°`, badge: `Acute ${fmt(g.acute)}°`, list: `${fmt(g.angle)}° (${fmt(g.acute)}°)` };
    },
    csv(item, box) {
      const g = twoLineGeom(item, box);
      return { value: fmt(g.angle), unit: 'deg', tilt: '', notes: `between drawn directions; acute ${fmt(g.acute)}` };
    },
    clean: () => true
  };

  KL.tools.twoline = {
    prompt: () => pendingLine
      ? 'Lines∠: now drag the second line (draw both in the same direction, e.g. distal to proximal)'
      : 'Lines∠: drag the first line',
    // Why capture every press once the first line exists: the second line usually starts on or
    // near an existing markup (a joint), and a press there must draw the line, not move the markup.
    get capturesAll() { return !!pendingLine; },
    onDown({ pt, normPt }) {
      if (!pendingLine) {
        const draft = { p1: { ...normPt }, p2: { ...normPt } };
        KL.startDrag({ tool: 'twoline', item: draft, moveKey: 'p2', startPx: { x: pt.x, y: pt.y }, moved: false, first: true });
        pendingLine = { ...draft, draft, frame: KL.fns.currentFrameIndex() };
        return;
      }
      const item = {
        id: newId('tl'), type: 'twoline', label: `Lines ${countOf('twoline') + 1}`,
        color: KL.activeColor, dashed: KL.isDashed, bookmarkId: KL.fns.bookmarkIdForNewItem('twoline'),
        p1: { ...pendingLine.p1 }, p2: { ...pendingLine.p2 }, p3: { ...normPt }, p4: { ...normPt }
      };
      addItem(item);
      startCreateDrag('twoline', item, 'p4', pt);
    },
    onMove(args) {
      trackCreateDrag(args);
      if (args.drag.first) { pendingLine.p2 = { ...args.drag.item.p2 }; }
    },
    onUp({ drag }) {
      if (drag.first) {
        if (!drag.moved) pendingLine = null; // a tap is not a line
      } else if (!drag.moved) {
        removeItem(drag.item.id); // keep the first line so the user can retry the second
      } else {
        pendingLine = null;
      }
      KL.fns.updatePromptBanner();
    }
  };

  function renderPendingLine(ctx, box) {
    if (!pendingLine) return;
    // Why drop it on tool or frame change: a half-built angle must not attach to another frame.
    if (KL.activeTool !== 'twoline' || (KL.hasVideo && KL.fns.currentFrameIndex() !== pendingLine.frame)) {
      pendingLine = null;
      KL.fns.updatePromptBanner();
      return;
    }
    const a = px(pendingLine.p1, box), b = px(pendingLine.p2, box);
    ctx.save();
    ctx.strokeStyle = KL.activeColor;
    ctx.lineWidth = 2.2;
    ctx.setLineDash([5, 5]);
    strokeLine(ctx, a, b);
    ctx.setLineDash([]);
    KL.fns.drawHandle(a.x, a.y, KL.activeColor, false, true);
    KL.fns.drawHandle(b.x, b.y, KL.activeColor, false, true);
    ctx.restore();
  }

  // ============================================================================================
  // (3) Floor-plane perspective correction
  //
  // The user taps the 4 corners of a known rectangle lying on the plane of motion, in order
  // round it: corner 1 -> 2 is the WIDTH edge, 2 -> 3 the DEPTH edge. These map to plane
  // coordinates (0,0), (W,0), (W,D), (0,D). A plane homography H (3x3, h33 = 1) maps image point
  // (x, y) to plane point (X, Y):
  //     X = (h1 x + h2 y + h3) / (h7 x + h8 y + 1)
  //     Y = (h4 x + h5 y + h6) / (h7 x + h8 y + 1)
  // Multiplying out gives two linear equations per correspondence (Direct Linear Transform):
  //     h1 x + h2 y + h3 - h7 x X - h8 y X = X
  //     h4 x + h5 y + h6 - h7 x Y - h8 y Y = Y
  // so 4 corners give an 8x8 system, solved by Gaussian elimination with partial pivoting.
  // Image coords are the stored normalized coords scaled to the video's native pixels
  // (x = nx * videoWidth, y = ny * videoHeight), so the frame's aspect ratio is respected.
  // A distance is then |H(p2) - H(p1)| in the units of W and D. Valid only for points that
  // really lie on that plane: anything above it (a hip, a head) is projected wrongly.
  // ============================================================================================

  const plane = { corners: null, width: null, depth: null, unit: 'm', enabled: false };
  let pendingCorners = [];   // taps so far while placing a new quad
  let H = null;              // current homography, or null when the plane is not usable

  function nativeSize() {
    const v = KL.video;
    // Why the same fallback as getVideoBox: before a video loads the stage is 1280x720.
    return KL.hasVideo && v.videoWidth ? { w: v.videoWidth, h: v.videoHeight } : { w: 1280, h: 720 };
  }

  /** Solve A x = b (n x n) by Gaussian elimination with partial pivoting; null if singular. */
  function solveLinear(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      if (Math.abs(M[piv][c]) < 1e-12) return null;
      [M[c], M[piv]] = [M[piv], M[c]];
      for (let r = c + 1; r < n; r++) {
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = M[r][n];
      for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
      x[r] = s / M[r][r];
    }
    return x;
  }

  /**
   * Homography from 4 image points to 4 plane points (DLT, h33 = 1).
   * @param {{x,y}[]} src image points  @param {{x,y}[]} dst plane points
   * @returns {number[]|null} [h1..h8, 1] row-major, or null for a degenerate set
   */
  function computeHomography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = src[i], X = dst[i].x, Y = dst[i].y;
      A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
      A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
    }
    const h = solveLinear(A, b);
    return h && h.every(Number.isFinite) ? [...h, 1] : null;
  }

  /** Apply homography h to (x, y); null when the point is on or beyond the plane's horizon. */
  function applyHomography(h, x, y) {
    const w = h[6] * x + h[7] * y + h[8];
    if (!(w > 1e-12)) return null; // Why w > 0: rebuildPlane scales H so every corner maps with w > 0
    return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
  }

  /** True when the 4 points form a convex quad, i.e. they were tapped in order round a rectangle. */
  function isConvexQuad(q) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cross) < 1e-9) return false;
      if (sign === 0) sign = Math.sign(cross);
      else if (Math.sign(cross) !== sign) return false;
    }
    return true;
  }

  const toImage = (p, s) => ({ x: p.nx * s.w, y: p.ny * s.h });

  /** Recompute H from the stored corners and dimensions and (un)install the length override. */
  function rebuildPlane() {
    H = null;
    if (plane.corners && plane.width && plane.depth) {
      const s = nativeSize();
      const src = plane.corners.map(p => toImage(p, s));
      if (isConvexQuad(src)) {
        const W = plane.width, D = plane.depth;
        const h = computeHomography(src, [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: D }, { x: 0, y: D }]);
        // Why the sign checks: H is only defined up to scale, and fixing h33 = 1 makes the
        // denominator w positive at the image origin, which may lie beyond the floor's horizon,
        // so the corners can all have w < 0. Flip the sign so the quad has w > 0 (same mapping),
        // and refuse a fit whose w changes sign between corners (part of the floor "behind the camera").
        if (h) {
          const ws = src.map(p => h[6] * p.x + h[7] * p.y + h[8]);
          const sgn = Math.sign(ws[0]);
          if (sgn !== 0 && ws.every(w => Math.sign(w) === sgn)) H = h.map(v => v * sgn);
        }
      }
    }
    const usable = plane.enabled && !!H;
    if (usable) KL.lengthOverride = planeLength;
    else if (KL.lengthOverride === planeLength) KL.lengthOverride = null;
  }

  /**
   * KL.lengthOverride: real distance between two normalized points mapped onto the plane.
   * @returns {{value:number, unit:string}|null} in the unit of the entered width/depth
   */
  function planeLength(p1, p2) {
    if (!KL.advanced || !plane.enabled || !H) return null; // Why: Advanced off = core behaviour
    const s = nativeSize();
    const a = toImage(p1, s), b = toImage(p2, s);
    const A = applyHomography(H, a.x, a.y), B = applyHomography(H, b.x, b.y);
    if (!A || !B) return null;
    return { value: Math.hypot(B.x - A.x, B.y - A.y), unit: plane.unit };
  }

  /** Parse a typed positive length (comma decimal allowed, as the core scale field); null if invalid. */
  function parseDim(raw) {
    const s = String(raw).trim().replace(',', '.');
    if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) && n > 0 && n <= MAX_DIM ? n : null;
  }

  const PLANE_COLOR = '#64D2FF';

  function planeChanged() {
    rebuildPlane();
    syncPlaneUI();
    KL.fns.syncInspectorUI(); // every calibrated Line/Marker readout depends on the plane
    KL.fns.renderFrame();
  }

  KL.tools.plane = {
    prompt: () => {
      const n = pendingCorners.length;
      if (n === 0 && plane.corners) return 'Plane: drag a corner to adjust, or tap 4 new corners to replace it';
      if (n === 0) return 'Plane: tap corner 1 of a known rectangle on the floor (1→2 is its width, 2→3 its depth)';
      return `Plane: tap corner ${n + 1} of 4, going round the rectangle`;
    },
    // Why capture every press: floor corners often sit under an existing markup (a foot marker).
    capturesAll: true,
    onDown({ pt, normPt, box }) {
      if (!pendingCorners.length && plane.corners) {
        const i = plane.corners.findIndex(c => { const q = px(c, box); return Math.hypot(q.x - pt.x, q.y - pt.y) <= CORNER_HIT_PX; });
        if (i >= 0) {
          // Why a grab offset (as the core handle drag): without it the corner jumps onto the
          // pointer (up to CORNER_HIT_PX, plus the 24 px touch lift) before the user has moved.
          const q = px(plane.corners[i], box);
          KL.startDrag({ tool: 'plane', corner: i, grabOffset: { x: q.x - pt.x, y: q.y - pt.y } });
          return;
        }
      }
      pendingCorners.push({ ...normPt });
      if (pendingCorners.length === 4) {
        const s = nativeSize();
        if (!isConvexQuad(pendingCorners.map(p => toImage(p, s)))) {
          KL.fns.showBanner('Those 4 corners do not form a rectangle outline - tap them in order round it.', true);
        } else {
          plane.corners = pendingCorners;
          planeChanged();
          KL.fns.showBanner(plane.width && plane.depth
            ? 'Plane set. Turn on "Use plane" to measure Lines on it.'
            : 'Corners set. Enter the rectangle\'s real width and depth.', false);
        }
        pendingCorners = [];
      }
      KL.fns.updatePromptBanner(); // Why also after the 4th tap: the prompt must leave "corner 4 of 4"
    },
    onMove({ pt, box, drag }) {
      if (!plane.corners) return; // cleared (undo/reset) mid-drag
      const o = drag.grabOffset;
      const n = KL.fns.pixelToNorm(pt.x + o.x, pt.y + o.y, box);
      plane.corners[drag.corner] = { nx: Math.max(0, Math.min(1, n.nx)), ny: Math.max(0, Math.min(1, n.ny)) };
      rebuildPlane();
    },
    onUp() { planeChanged(); KL.fns.updatePromptBanner(); }
  };

  /** Dashed quad with numbered corners and W/D edge labels; Advanced mode only. */
  function renderPlane(ctx, box) {
    if (!KL.advanced) return;
    // Why drop half-placed taps on tool change: picking Plane again later would otherwise carry
    // on from stale corners (only the "Tap 4 corners" button restarted the count).
    if (pendingCorners.length && KL.activeTool !== 'plane') pendingCorners = [];
    const pts = (plane.corners || []).map(c => px(c, box));
    const pend = pendingCorners.map(c => px(c, box));
    if (!pts.length && !pend.length) return;
    ctx.save();
    ctx.strokeStyle = PLANE_COLOR;
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 6]);
    // Why fainter when off: the quad is a reference; full strength signals it is driving lengths.
    ctx.globalAlpha = plane.enabled && H ? 0.95 : 0.55;
    if (pts.length === 4) {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
    }
    if (pend.length > 1) {
      ctx.beginPath();
      pend.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.font = '700 10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const dot = (p, n) => {
      KL.fns.drawHandle(p.x, p.y, PLANE_COLOR, true, false);
      ctx.fillStyle = '#000000';
      ctx.fillText(String(n), p.x, p.y + 0.5);
    };
    pts.forEach((p, i) => dot(p, i + 1));
    pend.forEach((p, i) => dot(p, i + 1));
    if (pts.length === 4 && plane.width && plane.depth) {
      const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      const w = mid(pts[0], pts[1]), d = mid(pts[1], pts[2]);
      ctx.textAlign = 'left'; // drawCanvasPill inherits this state and lays text out from the left
      KL.fns.drawCanvasPill(w.x + 6, w.y + 6, `W ${plane.width} ${plane.unit}`, PLANE_COLOR, false);
      KL.fns.drawCanvasPill(d.x + 6, d.y + 6, `D ${plane.depth} ${plane.unit}`, PLANE_COLOR, false);
    }
    ctx.restore();
  }

  // ============================================================================================
  // UI: toolbar tools and the sidebar section
  // ============================================================================================

  const SVG = inner => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const TOOL_BUTTONS = [
    ['segment', 'Segment', 'Segment inclination from vertical', '<line x1="8" y1="20" x2="16" y2="4"/><line x1="8" y1="20" x2="8" y2="6" stroke-dasharray="2 3"/><circle cx="8" cy="20" r="1.5"/>'],
    ['twoline', 'Lines∠', 'Angle between two lines', '<line x1="3" y1="20" x2="13" y2="4"/><line x1="7" y1="4" x2="21" y2="18"/>'],
    ['plane', 'Plane', 'Floor-plane perspective correction', '<path d="M7 7h10l4 12H3z" stroke-dasharray="3 2"/><circle cx="7" cy="7" r="1.2"/><circle cx="17" cy="7" r="1.2"/><circle cx="21" cy="19" r="1.2"/><circle cx="3" cy="19" r="1.2"/>']
  ];
  for (const [tool, name, title, icon] of TOOL_BUTTONS) {
    const b = document.createElement('button');
    b.className = 'tool-btn';
    b.dataset.tool = tool;
    b.setAttribute('data-adv', '');
    b.style.display = 'none';
    b.title = title;
    b.setAttribute('onclick', `selectTool('${tool}')`);
    b.innerHTML = `${SVG(icon)}<span>${name}</span>`;
    KL.toolbar.appendChild(b);
  }

  const section = document.createElement('div');
  section.dataset.advSection = MOD;
  section.innerHTML = `
    <div class="section-label">Segments &amp; perspective</div>
    <div class="section-label" style="margin-top:4px">Floor plane: W (corner 1→2) × D (2→3)</div>
    <div class="scale-input-row">
      <div class="modal-actions" style="margin-top:0">
        <input type="text" inputmode="decimal" id="measPlaneW" class="text-input" style="padding-right:11px" placeholder="Width 1→2" title="Real width of the rectangle (corner 1 to 2)">
        <input type="text" inputmode="decimal" id="measPlaneD" class="text-input" style="padding-right:11px" placeholder="Depth 2→3" title="Real depth of the rectangle (corner 2 to 3)">
      </div>
      <div class="unit-pills">
        <button type="button" class="unit-btn" data-meas-unit="m">m</button>
        <button type="button" class="unit-btn" data-meas-unit="cm">cm</button>
      </div>
    </div>
    <div class="modal-actions" style="margin-top:8px">
      <button type="button" class="action-btn" id="measPlaneCorners" title="Tap the 4 corners of a known floor rectangle">Tap 4 corners</button>
      <button type="button" class="action-btn" id="measPlaneUse" title="Measure Line lengths on the floor plane">Use plane</button>
    </div>
    <div id="measPlaneStatus" class="measure-list" style="margin-top:8px"></div>
    <div class="empty-state" style="margin-top:8px;padding:10px 12px">Plane lengths are only valid for points on that plane (feet, floor marks). Segment and Lines∠ angles are 2D, in the image.</div>`;
  KL.panel.appendChild(section);

  const $ = id => document.getElementById(id);

  /** Reflect plane state in the sidebar (inputs untouched while the user is typing in them). */
  function syncPlaneUI() {
    const w = $('measPlaneW'), d = $('measPlaneD');
    // Why clear the red border too: a load/reset/undo replaces the text, so an old error mark is stale.
    if (document.activeElement !== w) { w.value = plane.width ?? ''; w.style.borderColor = ''; }
    if (document.activeElement !== d) { d.value = plane.depth ?? ''; d.style.borderColor = ''; }
    section.querySelectorAll('[data-meas-unit]').forEach(b => b.classList.toggle('active', b.dataset.measUnit === plane.unit));
    const use = $('measPlaneUse');
    const on = plane.enabled && !!H;
    use.classList.toggle('active-toggle', on);
    use.textContent = on ? 'Plane on' : 'Use plane';
    const status = $('measPlaneStatus');
    if (!plane.corners) { status.innerHTML = ''; return; }
    const dims = plane.width && plane.depth ? `${plane.width} × ${plane.depth} ${plane.unit}` : 'enter size';
    const val = H ? dims : (plane.width && plane.depth ? 'corners invalid' : dims);
    status.innerHTML = `
      <div class="measure-item${on ? ' selected' : ''}">
        <div class="measure-left">
          <span class="measure-dot" style="background:${PLANE_COLOR}"></span>
          <span class="measure-name">Floor plane${on ? ' (in use)' : ''}</span>
        </div>
        <div class="measure-right">
          <span class="measure-val">${KL.fns.escapeHtml(val)}</span>
          <button class="trash-btn" id="measPlaneClear" title="Remove the plane">✕</button>
        </div>
      </div>`;
    $('measPlaneClear').addEventListener('click', () => {
      plane.corners = null;
      plane.enabled = false;
      pendingCorners = [];
      planeChanged();
    });
  }

  function onDimInput(key, el) {
    const v = parseDim(el.value);
    el.style.borderColor = v === null && el.value.trim() ? 'var(--ios-red)' : '';
    plane[key] = v;
    rebuildPlane();
    syncPlaneUI();
    KL.fns.syncInspectorUI();
    KL.fns.renderFrame();
  }
  $('measPlaneW').addEventListener('input', e => onDimInput('width', e.target));
  $('measPlaneD').addEventListener('input', e => onDimInput('depth', e.target));
  section.querySelectorAll('[data-meas-unit]').forEach(b => b.addEventListener('click', () => {
    plane.unit = b.dataset.measUnit;
    planeChanged();
  }));
  $('measPlaneCorners').addEventListener('click', () => {
    pendingCorners = [];
    KL.fns.selectTool('plane');
  });
  $('measPlaneUse').addEventListener('click', () => {
    if (plane.enabled) { plane.enabled = false; planeChanged(); return; }
    if (!plane.corners) { KL.fns.showBanner('Tap the 4 corners of a known floor rectangle first (Tap 4 corners).', true); return; }
    if (!plane.width || !plane.depth) { KL.fns.showBanner('Enter the rectangle\'s real width and depth first.', true); return; }
    if (!H) { KL.fns.showBanner('The corners do not form a usable rectangle - tap them again in order round it.', true); return; }
    plane.enabled = true;
    planeChanged();
    KL.fns.showBanner('Plane on: Line lengths are measured on the floor plane (valid only for points on it).', false);
  });

  // ============================================================================================
  // Session, lifecycle and hooks
  // ============================================================================================

  function resetPlane() {
    plane.corners = null; plane.width = null; plane.depth = null; plane.unit = 'm'; plane.enabled = false;
    pendingCorners = [];
    pendingLine = null;
  }

  const cleanNorm = p => p && Number.isFinite(p.nx) && Number.isFinite(p.ny)
    ? { nx: Math.max(0, Math.min(1, p.nx)), ny: Math.max(0, Math.min(1, p.ny)) }
    : null;
  const cleanDim = v => (Number.isFinite(v) && v > 0 && v <= MAX_DIM ? v : null);

  KL.session[MOD] = {
    undoable: true,
    save() {
      if (!plane.corners && plane.width == null && plane.depth == null) return null;
      return {
        corners: plane.corners ? plane.corners.map(c => ({ nx: c.nx, ny: c.ny })) : null,
        width: plane.width, depth: plane.depth, unit: plane.unit, enabled: plane.enabled
      };
    },
    /** Untrusted input: every field is validated; anything invalid falls back to "unset". */
    load(json) {
      resetPlane();
      if (json && typeof json === 'object') {
        if (Array.isArray(json.corners) && json.corners.length === 4) {
          const c = json.corners.map(cleanNorm);
          if (c.every(Boolean)) plane.corners = c;
        }
        plane.width = cleanDim(json.width);
        plane.depth = cleanDim(json.depth);
        plane.unit = json.unit === 'cm' ? 'cm' : 'm';
        plane.enabled = json.enabled === true && !!plane.corners;
      }
      rebuildPlane();
      syncPlaneUI();
    }
  };

  KL.on('reset', () => { resetPlane(); rebuildPlane(); syncPlaneUI(); });
  KL.on('render', ({ ctx, box }) => {
    ctx.save(); renderPlane(ctx, box); ctx.restore();
    ctx.save(); renderPendingLine(ctx, box); ctx.restore();
  });
  // Why: plane lengths switch off with Advanced mode, so the list must re-read them.
  KL.on('advanced', () => KL.fns.syncInspectorUI());

  KL.modules[MOD] = { segmentInclination, lineAngle, computeHomography, applyHomography, planeLength, getPlane: () => ({ ...plane, usable: !!H }) };

  syncPlaneUI();
})();
