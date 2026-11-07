/** adv/view.js - zoom, pan (Hand tool, wheel, pinch) and mirror for the video stage */
(() => {
  const KL = window.KL;
  if (!KL) return;

  // ---- Constants -------------------------------------------------------------------------
  const ZOOM_MIN = 1;          // 1 = Fit: the whole frame fits the stage
  const ZOOM_MAX = 8;          // Why 8x: a 1080p frame then shows ~135 px of source per stage height; more is just blur
  const ZOOM_STEP = 1.25;      // Why 1.25: four presses ~ doubles the zoom, fine enough to frame a joint
  const MIN_VISIBLE = 0.2;     // Why 20%: the picture can never be dragged fully off-screen and "lost"
  const WHEEL_ZOOM_K = 0.01;   // Zoom factor per wheel delta px: factor = exp(-deltaY * k)
  const WHEEL_DELTA_CAP = 25;  // Why cap: a mouse notch with Ctrl is ~100 px; uncapped that is a 2.7x jump
  const LINE_PX = 16;          // Pixels per wheel "line" (deltaMode 1, Firefox mouse wheels)

  const v = KL.view;
  let mirrorPref = false;      // The user's mirror choice; only applied while Advanced is on

  // ---- Geometry --------------------------------------------------------------------------
  // Why derive the stage size from getVideoBox: box.x = (sw - w)/2 + panX, so
  // sw = 2 * (box.x - panX) + w. This keeps reserveRight (compare mode) and any future change
  // to the box maths in one place, the core.
  function stageSize(box) {
    return { sw: 2 * (box.x - v.panX) + box.w, sh: 2 * (box.y - v.panY) + box.h };
  }

  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  /**
   * Keep at least MIN_VISIBLE of the box on screen on each axis.
   * Overlap of [box.x, box.x + w] with [0, sw] must be >= m, m = 0.2 * min(w, sw) (px), which
   * holds when m - w <= box.x <= sw - m. With base = box.x - panX that bounds panX.
   * Why min(w, sw): at high zoom 20% of the box is wider than the stage itself.
   */
  function clampPan() {
    const box = KL.fns.getVideoBox();
    const { sw, sh } = stageSize(box);
    const bx = box.x - v.panX, by = box.y - v.panY;
    const mx = MIN_VISIBLE * Math.min(box.w, sw), my = MIN_VISIBLE * Math.min(box.h, sh);
    v.panX = clamp(v.panX, mx - box.w - bx, sw - mx - bx);
    v.panY = clamp(v.panY, my - box.h - by, sh - my - by);
  }

  /**
   * Set the zoom keeping the stage point (cx, cy) (CSS px, canvas-relative) over the same
   * picture point. With u = (cx - box.x) / w fixed and w' = w * z' / z:
   *   panX' = cx - u * w' - (sw - w') / 2   (same for y).
   * Measurements are unaffected: every markup is normalized and lengths are ratios to the scale.
   */
  function zoomAt(newZoom, cx, cy) {
    const box = KL.fns.getVideoBox();
    const { sw, sh } = stageSize(box);
    const z0 = v.zoom;
    const z = clamp(Number.isFinite(newZoom) ? newZoom : z0, ZOOM_MIN, ZOOM_MAX);
    // Why: zooming out at 100% on a Hand-panned picture means "show me the whole frame".
    if (z === z0) { if (z === ZOOM_MIN && newZoom < z0 && (v.panX || v.panY)) fit(); return; }
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) { cx = sw / 2; cy = sh / 2; } // API callers
    const u = (cx - box.x) / (box.w || 1), t = (cy - box.y) / (box.h || 1);
    const w = box.w * z / z0, h = box.h * z / z0;
    v.zoom = z;
    v.panX = cx - u * w - (sw - w) / 2;
    v.panY = cy - t * h - (sh - h) / 2;
    // Why: zooming all the way out means "show me the whole frame", so recentre it.
    if (z === ZOOM_MIN && z < z0) { v.panX = 0; v.panY = 0; }
    clampPan();
    afterChange();
  }

  /** Zoom by a factor around the stage centre (buttons and keys). */
  function zoomCentre(factor) {
    const { sw, sh } = stageSize(KL.fns.getVideoBox());
    zoomAt(v.zoom * factor, sw / 2, sh / 2);
  }

  /** Back to Fit: zoom 1, no pan. */
  function fit() {
    v.zoom = ZOOM_MIN; v.panX = 0; v.panY = 0;
    afterChange();
  }

  /** Pan by a stage-pixel delta, clamped. */
  function panBy(dx, dy) {
    v.panX += dx; v.panY += dy;
    clampPan();
    afterChange();
  }

  /**
   * Set the user's mirror preference (kept across clips; shown only in Advanced mode).
   * @param {boolean} on
   */
  function setMirror(on) {
    mirrorPref = !!on;
    applyMirror();
  }

  // Why the preference is separate: with Advanced off the toggle is hidden, so a mirrored
  // picture would have no visible way back; the choice returns when Advanced is switched on.
  function applyMirror() {
    v.mirror = KL.advanced && mirrorPref;
    afterChange();
  }

  function afterChange() {
    syncUI();
    KL.fns.renderFrame();
  }

  // ---- Sidebar section -------------------------------------------------------------------
  const section = document.createElement('div');
  section.dataset.advSection = 'view';
  section.innerHTML = `
    <div class="section-label">View</div>
    <div class="scale-input-row">
      <div class="measure-val" id="viewZoomReadout">Zoom 100%</div>
      <div class="unit-pills">
        <button type="button" class="unit-btn" id="viewZoomOutBtn" title="Zoom out (-)">&minus;</button>
        <button type="button" class="unit-btn" id="viewFitBtn" title="Fit the whole frame (0)">Fit</button>
        <button type="button" class="unit-btn" id="viewZoomInBtn" title="Zoom in (+)">+</button>
      </div>
    </div>
    <button type="button" class="action-btn" id="viewMirrorBtn" style="width:100%;margin-top:8px" title="Mirror the picture left-right (M)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M8 7 3 12l5 5V7z"/><path d="M16 7l5 5-5 5V7z"/></svg>
      <span>Mirror</span>
    </button>
    <div style="font-size:11.5px;line-height:1.4;color:var(--text-muted);margin-top:6px">Ctrl/&#8984; + scroll or pinch to zoom at the cursor; scroll or the Hand tool (H) pans. Mirror flips markups with the picture: lengths and angles are unchanged, but line tilt signs flip.</div>`;
  KL.panel.appendChild(section);

  const zoomReadout = section.querySelector('#viewZoomReadout');
  const fitBtn = section.querySelector('#viewFitBtn');
  const mirrorBtn = section.querySelector('#viewMirrorBtn');
  section.querySelector('#viewZoomOutBtn').addEventListener('click', () => zoomCentre(1 / ZOOM_STEP));
  section.querySelector('#viewZoomInBtn').addEventListener('click', () => zoomCentre(ZOOM_STEP));
  fitBtn.addEventListener('click', fit);
  mirrorBtn.addEventListener('click', () => setMirror(!mirrorPref));

  function syncUI() {
    zoomReadout.textContent = `Zoom ${Math.round(v.zoom * 100)}%`;
    fitBtn.classList.toggle('active', v.zoom === ZOOM_MIN && v.panX === 0 && v.panY === 0);
    mirrorBtn.classList.toggle('active-toggle', mirrorPref);
  }

  // ---- Hand tool -------------------------------------------------------------------------
  KL.toolbar.insertAdjacentHTML('beforeend',
    `<button class="tool-btn" data-tool="hand" data-adv style="display:none" onclick="selectTool('hand')" title="Hand: drag to pan the picture (H)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg><span>Hand</span></button>`);

  let handDragging = false;
  KL.tools.hand = {
    capturesAll: true, // Why: a pan must start anywhere, even on top of a markup
    prompt: 'Hand: drag to pan the picture. Ctrl/⌘ + scroll or pinch zooms; 0 fits.',
    onDown({ rawPt }) {
      // Why rawPt: the touch finger lift is for placing points; panning follows the finger itself.
      KL.startDrag({ noLoupe: true, startX: rawPt.x, startY: rawPt.y, panX0: v.panX, panY0: v.panY });
      document.getElementById('loupeContainer').style.display = 'none'; // the core opens it on every press
      handDragging = true;
    },
    onMove({ rawPt, drag }) {
      v.panX = drag.panX0 + (rawPt.x - drag.startX);
      v.panY = drag.panY0 + (rawPt.y - drag.startY);
      clampPan();
      syncUI();
    },
    onUp() { handDragging = false; syncUI(); }
  };

  // Grab cursor while the Hand tool is active. Why only when our state changes: other tools
  // and modules may set their own cursor; we only undo what we set.
  let cursorSet = '';
  KL.on('render', () => {
    const want = KL.activeTool === 'hand' ? (handDragging ? 'grabbing' : 'grab') : '';
    if (want !== cursorSet) { KL.canvas.style.cursor = want; cursorSet = want; }
  });

  // ---- Wheel: Ctrl/Cmd + wheel (and trackpad pinch) zooms, plain wheel pans ---------------
  function canvasPoint(e) {
    const r = KL.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  KL.canvas.addEventListener('wheel', (e) => {
    if (!KL.advanced) return;
    const unit = e.deltaMode === 1 ? LINE_PX : (e.deltaMode === 2 ? KL.stage.clientHeight : 1);
    const dx = e.deltaX * unit, dy = e.deltaY * unit;
    if (e.ctrlKey || e.metaKey) {
      // Chrome/Edge/Firefox report a trackpad pinch as a wheel event with ctrlKey set.
      // Why preventDefault even mid-drag: otherwise the browser zooms the whole page instead.
      e.preventDefault();
      if (KL.dragging) return; // the box must not move under a handle being dragged
      const p = canvasPoint(e);
      zoomAt(v.zoom * Math.exp(-clamp(dy, -WHEEL_DELTA_CAP, WHEEL_DELTA_CAP) * WHEEL_ZOOM_K), p.x, p.y);
    } else if (v.zoom > ZOOM_MIN) {
      e.preventDefault();
      if (KL.dragging) return;
      panBy(-dx, -dy); // scrolling down moves the view down the picture, i.e. the picture up
    }
  }, { passive: false });

  // Desktop Safari sends trackpad pinch as gesture events, not ctrl+wheel. Why skip on touch
  // devices: iOS also fires them for two-finger touches, which the pointer pinch below handles.
  let gestureZoom0 = null;
  const gestureOk = () => KL.advanced && !(navigator.maxTouchPoints > 0) && touchPointers.size === 0;
  KL.canvas.addEventListener('gesturestart', (e) => { if (!gestureOk()) return; e.preventDefault(); gestureZoom0 = v.zoom; });
  KL.canvas.addEventListener('gesturechange', (e) => {
    if (gestureZoom0 === null || !gestureOk()) return;
    e.preventDefault();
    const p = canvasPoint(e);
    zoomAt(gestureZoom0 * e.scale, p.x, p.y);
  });
  KL.canvas.addEventListener('gestureend', () => { gestureZoom0 = null; });

  // ---- Two-finger touch pinch ------------------------------------------------------------
  // Why window capture listeners: they run before the core's canvas handlers, so the second
  // finger can be kept away from the drawing code entirely. One finger is never touched.
  const touchPointers = new Map(); // pointerId -> {x, y} canvas px
  let pinch = null;                // {ids, d0, zoom0, mid0, box0} while two fingers zoom
  let suppress = false;            // swallow pointer events until every pinch finger is up
  let preSnap = null, prePending = null; // state before the first finger, to undo its edits
  let syntheticCancel = false;

  const onCanvas = (e) => e.target === KL.canvas;
  const swallow = (e) => { e.stopImmediatePropagation(); e.preventDefault(); };

  /** Core pending-angle points, read directly. Why: KL has no accessor for them yet. */
  function pendingPts() {
    try { return pendingAnglePts; } catch (err) { return null; } // eslint-disable-line no-undef
  }

  /**
   * Abort whatever the first finger started in the core (a line, a handle drag, an angle
   * point) and put the state back as it was before that finger landed.
   */
  function cancelFirstFinger(firstId) {
    KL.startDrag({ tool: '__view_pinch', noLoupe: true }); // a custom drag with no tool ends harmlessly
    handDragging = false; // Why: the Hand drag replaced above never gets its onUp
    if (preSnap) KL.restore(preSnap);
    const cur = pendingPts();
    if (cur && prePending) { cur.splice(0, cur.length, ...prePending); KL.fns.updatePromptBanner(); }
    syntheticCancel = true;
    try { KL.canvas.dispatchEvent(new PointerEvent('pointercancel', { pointerId: firstId, bubbles: true })); }
    finally { syntheticCancel = false; }
  }

  function pinchGeometry() {
    const [a, b] = pinch.ids.map(id => touchPointers.get(id));
    return { d: Math.hypot(b.x - a.x, b.y - a.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }

  window.addEventListener('pointerdown', (e) => {
    if (syntheticCancel || !onCanvas(e) || !KL.advanced || e.pointerType === 'mouse') return;
    touchPointers.set(e.pointerId, canvasPoint(e));
    if (touchPointers.size === 2) {
      swallow(e);
      try { KL.canvas.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
      const ids = [...touchPointers.keys()];
      // Why only when not suppressing: after one pinch finger lifts and lands again, finger 1
      // was already cancelled; the second pinch simply starts from the current view.
      if (!suppress) { cancelFirstFinger(ids[0]); suppress = true; }
      pinch = { ids, zoom0: v.zoom };
      const g = pinchGeometry();
      const box0 = KL.fns.getVideoBox();
      Object.assign(pinch, { d0: Math.max(1, g.d), mid0: g.mid, box0, stage: stageSize(box0) });
      return;
    }
    if (suppress) { swallow(e); return; }
    if (touchPointers.size === 1) {
      KL.commit(); // flush pending changes so the restore below cannot swallow an undo step
      preSnap = KL.snapshot();
      const cur = pendingPts();
      prePending = cur ? cur.slice() : null;
      // single finger: the core draws as usual
    }
  }, true);

  window.addEventListener('pointermove', (e) => {
    if (!touchPointers.has(e.pointerId)) return;
    touchPointers.set(e.pointerId, canvasPoint(e));
    if (!suppress) return;
    swallow(e);
    if (!pinch || !pinch.ids.every(id => touchPointers.has(id))) return;
    // Zoom by the finger-spread ratio and keep the picture point under the starting midpoint
    // under the current midpoint, so a pinch zooms and pans together like a photo viewer.
    const g = pinchGeometry();
    const z = clamp(pinch.zoom0 * g.d / pinch.d0, ZOOM_MIN, ZOOM_MAX);
    const { box0, mid0, stage } = pinch;
    const u = (mid0.x - box0.x) / box0.w, t = (mid0.y - box0.y) / box0.h;
    const w = box0.w * z / pinch.zoom0, h = box0.h * z / pinch.zoom0;
    v.zoom = z;
    v.panX = g.mid.x - u * w - (stage.sw - w) / 2;
    v.panY = g.mid.y - t * h - (stage.sh - h) / 2;
    clampPan();
    afterChange();
  }, true);

  function pointerEnd(e) {
    if (syntheticCancel || !touchPointers.has(e.pointerId)) return;
    touchPointers.delete(e.pointerId);
    if (suppress) swallow(e);
    if (pinch && !pinch.ids.every(id => touchPointers.has(id))) pinch = null;
    if (touchPointers.size === 0) { suppress = false; preSnap = null; prePending = null; }
  }
  window.addEventListener('pointerup', pointerEnd, true);
  window.addEventListener('pointercancel', pointerEnd, true);

  // ---- Keyboard --------------------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if (!KL.advanced || KL.isTextEntry(document.activeElement) || KL.dragging) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return; // Cmd/Ctrl +/-/0 stay the browser's page zoom
    if (e.key === '=' || e.key === '+') zoomCentre(ZOOM_STEP);
    else if (e.key === '-' || e.key === '_') zoomCentre(1 / ZOOM_STEP);
    else if (e.key === '0') fit();
    else if (e.code === 'KeyM') setMirror(!mirrorPref);
    else if (e.code === 'KeyH') KL.fns.selectTool('hand');
    else return;
    e.preventDefault();
  });

  // ---- Lifecycle and session -------------------------------------------------------------
  KL.on('videoload', fit);
  KL.on('reset', fit);
  KL.on('advanced', ({ on }) => {
    // Why reset zoom when leaving Advanced: basic mode has no View controls to undo it.
    if (!on) { v.zoom = ZOOM_MIN; v.panX = 0; v.panY = 0; }
    applyMirror();
  });

  KL.session.view = {
    undoable: false, // a view setting, not an analysis edit
    // Why null when off: an all-default view must not make an empty session look "saveable".
    save() { return mirrorPref ? { mirror: true } : null; },
    load(json) { setMirror(!!(json && typeof json === 'object' && json.mirror === true)); }
  };

  KL.modules.view = { zoomAt, fit, panBy, setMirror, get mirror() { return mirrorPref; } };
  syncUI();
})();
