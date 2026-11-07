/** adv/tracking.js - manual point tracking (digitising) with kinematics, joint angles over time, a graph and CSV */
(() => {
  const KL = window.KL;
  const fns = KL.fns;

  // ---- Constants ---------------------------------------------------------------------------
  const MAX_TRACKS = 50;          // Spec cap; also bounds what a session file can make us allocate
  const MAX_POINTS = 20000;       // Spec cap on points across all tracks (~13 min of 25 fps on one track)
  const MAX_ANGLES = 20;          // Far above the handful of joints a coach graphs at once
  const MAX_FRAME = 1e6;          // Highest frame index accepted from a file (11 h at 25 fps)
  const MAX_GAP_FRAMES = 2;       // Spec: a finite difference never spans more than 2 frames each side
  const HIT_RADIUS = 14;          // px: grab radius for a current-frame point (handles are 6 px)
  const TAP_SLOP = 3;             // px: same tap/drag threshold the core uses
  const NAME_MAX = 40;            // Characters in a track name (fits the list row and canvas pill)
  const GRAPH_H = 160;            // CSS px height of the sidebar graph (spec ~160)
  const ADVANCE_CHOICES = [0, 1, 2, 5]; // Frames to step after a click (spec)
  const PRESETS = ['Hip', 'Knee', 'Ankle', 'Shoulder', 'Elbow', 'Wrist', 'Toe', 'Bar'];
  const PALETTE = ['#30D158', '#0A84FF', '#FF9F0A', '#FF453A', '#BF5AF2', '#64D2FF'];
  const UNIT_TO_M = { m: 1, cm: 0.01, mm: 0.001 }; // Calibration units -> metres, so speed is always m/s
  const ID_RE = /^[\w-]{1,64}$/;  // Same id rule the core uses
  const COLOR_RE = /^#[0-9a-f]{6}$/i;

  // ---- State -------------------------------------------------------------------------------
  // tracks: [{ id, name, color, points: { [frameIndex]: {nx, ny} } }]
  // angles: [{ id, a, b, c }] track ids; b is the vertex.
  let tracks = [];
  let angles = [];
  let selectedTrackId = null;
  let selectedAngleId = null;     // angle plotted when the graph shows "Angle"
  let advance = 1;                // frames to step after each click (default 1, spec)
  let series = 'speed';           // graph series: 'speed' | 'height' | 'angle'
  let version = 0;                // bumped on every data change; keys the kinematics cache
  let idSeq = 0;
  // Why a running count: recounting every track on each new point made filling 20000 points
  // (pose) quadratic, over a second of frozen UI.
  let pointCount = 0;

  // ---- Data & session ----------------------------------------------------------------------
  const newId = prefix => `${prefix}_${Date.now().toString(36)}_${(idSeq++).toString(36)}`;
  const trackById = id => tracks.find(t => t.id === id) || null;
  const clamp01 = v => Math.max(0, Math.min(1, v));
  // Why typeof checks before String(): an object from a hostile file can make String() throw
  // (a non-callable toString), and a missing id must not become the valid id "undefined".
  const safeStr = v => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

  /** Sorted digitised frame indices of a track. */
  function framesOf(track) {
    return Object.keys(track.points).map(Number).sort((a, b) => a - b);
  }

  /** Mark data changed: invalidates the kinematics cache and refreshes the sidebar. */
  function touch() {
    version++;
    scheduleUI();
  }

  /**
   * Create a track. Why the colour cycles the palette: tracks drawn on one body must be told
   * apart at a glance on the canvas and in the graph.
   * @returns {object|null} the track, or null at the cap
   */
  function createTrack(name) {
    if (tracks.length >= MAX_TRACKS) { fns.showBanner(`At most ${MAX_TRACKS} tracks.`, true); return null; }
    const t = { id: newId('trk'), name: String(name).trim().slice(0, NAME_MAX) || `Point ${tracks.length + 1}`, color: PALETTE[tracks.length % PALETTE.length], points: {} };
    tracks.push(t);
    touch();
    return t;
  }

  /** Set a track's point on a frame. Returns false at the point cap or for invalid input. */
  function setPoint(track, frame, pt) {
    if (!track || !Number.isInteger(frame) || frame < 0 || frame > MAX_FRAME) return false;
    if (!pt || !Number.isFinite(pt.nx) || !Number.isFinite(pt.ny)) return false;
    if (!track.points[frame]) {
      if (pointCount >= MAX_POINTS) { fns.showBanner(`Point limit reached (${MAX_POINTS}).`, true); return false; }
      pointCount++;
    }
    track.points[frame] = { nx: clamp01(pt.nx), ny: clamp01(pt.ny) };
    touch();
    return true;
  }

  function deleteTrack(id) {
    const gone = trackById(id);
    if (gone) pointCount -= Object.keys(gone.points).length;
    tracks = tracks.filter(t => t.id !== id);
    // Why: an angle without one of its three tracks can never be computed again.
    angles = angles.filter(a => a.a !== id && a.b !== id && a.c !== id);
    if (selectedTrackId === id) selectedTrackId = tracks.length ? tracks[tracks.length - 1].id : null;
    if (selectedAngleId && !angles.some(a => a.id === selectedAngleId)) selectedAngleId = angles.length ? angles[0].id : null;
    touch();
    fns.renderFrame();
  }

  /** Validate a session's tracking block. Untrusted input: every field is checked and capped. */
  function loadData(json) {
    // Why keep the selections when their ids survive: undo restores through here, and the user
    // should stay on the track they were digitising.
    const prevTrack = selectedTrackId, prevAngle = selectedAngleId;
    tracks = []; angles = []; selectedTrackId = null; selectedAngleId = null;
    if (json && typeof json === 'object') {
      let budget = MAX_POINTS;
      for (const raw of (Array.isArray(json.tracks) ? json.tracks : []).slice(0, MAX_TRACKS)) {
        if (!raw || typeof raw !== 'object') continue;
        const id = safeStr(raw.id);
        if (!ID_RE.test(id) || tracks.some(t => t.id === id)) continue;
        const points = {};
        const src = raw.points && typeof raw.points === 'object' ? raw.points : {};
        for (const [k, p] of Object.entries(src)) {
          if (budget <= 0) break;
          const f = Number(k);
          if (!/^\d{1,7}$/.test(k) || f > MAX_FRAME || !p || !Number.isFinite(p.nx) || !Number.isFinite(p.ny)) continue;
          if (!points[f]) budget--; // Why: "7" and "007" name the same frame and must not count twice
          points[f] = { nx: clamp01(p.nx), ny: clamp01(p.ny) };
        }
        tracks.push({
          id,
          name: safeStr(raw.name).trim().slice(0, NAME_MAX) || `Point ${tracks.length + 1}`,
          color: COLOR_RE.test(raw.color) ? raw.color : PALETTE[tracks.length % PALETTE.length],
          points
        });
      }
      const ids = new Set(tracks.map(t => t.id));
      for (const raw of (Array.isArray(json.angles) ? json.angles : []).slice(0, MAX_ANGLES)) {
        const id = raw ? safeStr(raw.id) : '';
        if (!ID_RE.test(id) || ![raw.a, raw.b, raw.c].every(x => ids.has(x))) continue;
        if (new Set([raw.a, raw.b, raw.c]).size !== 3 || angles.some(a => a.id === id)) continue;
        angles.push({ id, a: raw.a, b: raw.b, c: raw.c });
      }
      pointCount = MAX_POINTS - budget;
    } else {
      pointCount = 0;
    }
    selectedTrackId = trackById(prevTrack) ? prevTrack : (tracks.length ? tracks[0].id : null);
    selectedAngleId = angles.some(a => a.id === prevAngle) ? prevAngle : (angles.length ? angles[0].id : null);
    version++;
    refreshUI();
  }

  KL.session.tracking = {
    // Why undoable: a mis-click while digitising must be one Undo away like any markup.
    undoable: true,
    save() {
      if (!tracks.length) return null;
      // Why no UI state (selection, advance step): every saved field becomes an undo step.
      return { tracks, angles };
    },
    load(json) { loadData(json); fns.renderFrame(); }
  };
  KL.on('reset', () => loadData(null));

  // ---- Kinematics --------------------------------------------------------------------------
  // Positions are taken in the video's native pixel grid (W x H), so they do not depend on the
  // window size or zoom. With a confirmed scale they are converted to metres:
  //   s [m/px] = calibratedLength(unit segment across the full width) [m] / W [px]
  //   x [m] = nx' * W * s         y [m] = (1 - ny) * H * s     (origin bottom-left, y positive up)
  // nx' = 1 - nx while the view is mirrored. Why: x, vx and ax then follow the picture the coach
  // sees, the same convention as the core's line tilt and arrow direction; speed and y are unchanged.
  // Without a scale s = 1 and the unit is native px.

  /** Native video size in px (the core's getVideoBox falls back to 1280x720 the same way). */
  function nativeSize() {
    const v = KL.video;
    return KL.hasVideo && v.videoWidth ? { W: v.videoWidth, H: v.videoHeight } : { W: 1280, H: 720 };
  }

  /**
   * Length unit and metres per native pixel, from the core's confirmed Scale reference.
   * Why a full-width unit segment through calibratedLength: it is the core's one calibration
   * path, and the box scale is uniform in x and y.
   * Why KL.lengthOverride is bypassed: the override (adv/measure.js floor plane) maps floor
   * points through a perspective homography, so its metres-per-pixel varies across the frame and
   * the image's top edge often lies beyond the horizon. Tracked joints are not on the floor; one
   * uniform scale from the sagittal Scale reference is the only one that applies to them.
   * @returns {{s: number, unit: 'm'|'px'}}
   */
  function scaleInfo(box) {
    const { W } = nativeSize();
    const override = KL.lengthOverride;
    let cal;
    KL.lengthOverride = null; // synchronous; restored in finally even if calibratedLength throws
    try { cal = fns.calibratedLength({ p1: { nx: 0, ny: 0 }, p2: { nx: 1, ny: 0 } }, box); } finally { KL.lengthOverride = override; }
    if (cal && cal.value > 0 && Number.isFinite(cal.value) && UNIT_TO_M[cal.unit]) {
      return { s: cal.value * UNIT_TO_M[cal.unit] / W, unit: 'm' };
    }
    return { s: 1, unit: 'px' };
  }

  /**
   * Central difference over neighbouring digitised samples:
   *   d_i = (q_{i+1} - q_{i-1}) / (t_{i+1} - t_{i-1}),   t = frame / fps [s]
   * Only when both neighbours exist and each is at most MAX_GAP_FRAMES away; otherwise null.
   * Why no one-sided ends: a forward difference at the first frame is only first-order accurate
   * and reads systematically off at the start and end of a movement; a gap means "unknown".
   * @param {Array<{f:number,t:number}>} rows samples sorted by frame
   * @param {(r:object)=>number|null} get value to differentiate
   * @returns {Array<number|null>} derivative per row
   */
  function centralDiff(rows, get) {
    return rows.map((r, i) => {
      const p = rows[i - 1], n = rows[i + 1];
      if (!p || !n || r.f - p.f > MAX_GAP_FRAMES || n.f - r.f > MAX_GAP_FRAMES) return null;
      const qp = get(p), qn = get(n);
      if (qp === null || qn === null) return null;
      return (qn - qp) / (n.t - p.t);
    });
  }

  let cache = { key: '', byTrack: new Map() };

  /**
   * Per-frame kinematics of a track, cached until the data, fps or scale change.
   * Rows: { f, t [s], x, y [unit], vx, vy, speed [unit/s], ax, ay, acc [unit/s^2] }; derivatives
   * are null where the central difference is not defined. Acceleration is the central difference
   * of the velocity series (same gap rule), so it needs 2 neighbours on each side.
   */
  function kinematics(track, box) {
    const fps = fns.getVideoFps();
    const { W, H } = nativeSize();
    const sc = scaleInfo(box);
    const mirror = !!KL.view.mirror;
    const key = `${version}|${fps}|${sc.s}|${W}x${H}|${mirror}`;
    if (cache.key !== key) cache = { key, byTrack: new Map() };
    if (cache.byTrack.has(track.id)) return cache.byTrack.get(track.id);
    const rows = framesOf(track).map(f => {
      const p = track.points[f];
      return { f, t: f / fps, x: (mirror ? 1 - p.nx : p.nx) * W * sc.s, y: (1 - p.ny) * H * sc.s };
    });
    const vx = centralDiff(rows, r => r.x), vy = centralDiff(rows, r => r.y);
    rows.forEach((r, i) => {
      r.vx = vx[i]; r.vy = vy[i];
      r.speed = r.vx === null ? null : Math.hypot(r.vx, r.vy); // |v| = sqrt(vx^2 + vy^2)
    });
    const ax = centralDiff(rows, r => r.vx), ay = centralDiff(rows, r => r.vy);
    rows.forEach((r, i) => {
      r.ax = ax[i]; r.ay = ay[i];
      r.acc = r.ax === null ? null : Math.hypot(r.ax, r.ay);
    });
    const out = { rows, unit: sc.unit, byFrame: new Map(rows.map(r => [r.f, r])) };
    cache.byTrack.set(track.id, out);
    return out;
  }

  /**
   * Angle A-B-C (B = vertex) on every frame where all three tracks have a point, in degrees,
   * interior 0-180 like the Angle tool (core computeAngleDegrees on native-px points, so the
   * aspect ratio is respected and mirroring cannot change it).
   * @returns {Array<{f:number, t:number, deg:number}>}
   */
  function angleSeries(angle) {
    const A = trackById(angle.a), B = trackById(angle.b), C = trackById(angle.c);
    if (!A || !B || !C) return [];
    const fps = fns.getVideoFps();
    const { W, H } = nativeSize();
    const px = p => ({ x: p.nx * W, y: p.ny * H });
    return framesOf(B)
      .filter(f => A.points[f] && C.points[f])
      .map(f => ({ f, t: f / fps, deg: fns.computeAngleDegrees(px(A.points[f]), px(B.points[f]), px(C.points[f])) }));
  }

  const angleName = a => [a.a, a.b, a.c].map(id => (trackById(id) || { name: '?' }).name).join('-');
  /** Decimals for a value in this unit: mm-level for metres, 0.1 px for pixels. */
  const dec = unit => (unit === 'm' ? 3 : 1);

  // ---- UI ----------------------------------------------------------------------------------
  const esc = fns.escapeHtml;
  const MUTED = 'color:var(--text-muted); font-size:11px; line-height:1.4';
  const section = document.createElement('div');
  section.dataset.advSection = 'tracking';
  section.innerHTML = `
    <div class="section-label">Point tracking</div>
    <div style="display:flex; flex-direction:column; gap:8px">
      <div class="measure-list" data-trk="list"></div>
      <input type="text" class="text-input" data-trk="name" maxlength="${NAME_MAX}" placeholder="Track name, e.g. Knee">
      <div class="preset-grid">${PRESETS.map(p => `<button type="button" class="preset-chip" data-trk-preset="${p}">${p}</button>`).join('')}</div>
      <div class="modal-actions">
        <button type="button" class="action-btn primary" data-trk="add" title="Add a track and pick the Track tool (T)">Add track</button>
        <button type="button" class="action-btn" data-trk="rename" title="Rename the selected track to the typed name">Rename</button>
      </div>
      <div class="scale-input-row">
        <span style="${MUTED}">Advance after click (frames)</span>
        <div class="unit-pills" data-trk="advance">${ADVANCE_CHOICES.map(n => `<button type="button" class="unit-btn" data-val="${n}">${n}</button>`).join('')}</div>
      </div>
      <div style="${MUTED}" data-trk="hint"></div>
      <div style="${MUTED}">Joint angle over time (A, vertex B, C)</div>
      <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:6px">
        <select class="text-input" data-trk-angle="a" title="Point A"></select>
        <select class="text-input" data-trk-angle="b" title="Vertex B"></select>
        <select class="text-input" data-trk-angle="c" title="Point C"></select>
      </div>
      <button type="button" class="action-btn" data-trk="addAngle">Add angle</button>
      <div class="measure-list" data-trk="angles"></div>
      <div class="scale-input-row">
        <span style="${MUTED}">Graph</span>
        <div class="unit-pills" data-trk="series">
          <button type="button" class="unit-btn" data-val="speed">Speed</button>
          <button type="button" class="unit-btn" data-val="height">Height</button>
          <button type="button" class="unit-btn" data-val="angle">Angle</button>
        </div>
      </div>
      <div class="inspector-card" style="padding:6px">
        <canvas data-trk="graph" style="width:100%; height:${GRAPH_H}px; display:block; cursor:pointer" title="Click to jump to that frame"></canvas>
      </div>
      <div style="${MUTED}" data-trk="caption"></div>
    </div>`;
  KL.panel.appendChild(section);

  const $ = k => section.querySelector(`[data-trk="${k}"]`);
  const nameInput = $('name');
  const angleSelects = ['a', 'b', 'c'].map(k => section.querySelector(`[data-trk-angle="${k}"]`));
  const graph = $('graph');
  // Why blur after a pick: a focused <select> swallows T (KL.isTextEntry) and the arrow keys.
  angleSelects.forEach(s => s.addEventListener('change', () => s.blur()));

  section.querySelectorAll('[data-trk-preset]').forEach(chip => chip.addEventListener('click', () => {
    nameInput.value = chip.dataset.trkPreset;
  }));
  $('add').addEventListener('click', addTrackFromInput);
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') addTrackFromInput(); });
  $('rename').addEventListener('click', () => {
    const t = trackById(selectedTrackId), name = nameInput.value.trim().slice(0, NAME_MAX);
    if (!t) { fns.showBanner('Select a track to rename.', true); return; }
    if (!name) { fns.showBanner('Type the new name first.', true); return; }
    t.name = name;
    nameInput.value = '';
    touch();
    fns.renderFrame();
  });
  $('advance').addEventListener('click', e => {
    const b = e.target.closest('.unit-btn');
    if (b) { advance = Number(b.dataset.val); refreshUI(); }
  });
  $('series').addEventListener('click', e => {
    const b = e.target.closest('.unit-btn');
    if (b) { series = b.dataset.val; refreshUI(); }
  });
  $('addAngle').addEventListener('click', () => {
    const [a, b, c] = angleSelects.map(s => s.value);
    if (!a || !b || !c || new Set([a, b, c]).size !== 3) { fns.showBanner('Pick three different tracks: A, vertex B, C.', true); return; }
    if (angles.length >= MAX_ANGLES) { fns.showBanner(`At most ${MAX_ANGLES} angles.`, true); return; }
    const ang = { id: newId('ang'), a, b, c };
    angles.push(ang);
    selectedAngleId = ang.id;
    series = 'angle';
    touch();
  });
  // Row clicks and deletes, delegated because the lists are rebuilt on every refresh.
  $('list').addEventListener('click', e => {
    const row = e.target.closest('[data-id]');
    if (!row) return;
    if (e.target.closest('.trash-btn')) { deleteTrack(row.dataset.id); return; }
    selectedTrackId = row.dataset.id;
    refreshUI();
    fns.renderFrame();
  });
  $('angles').addEventListener('click', e => {
    const row = e.target.closest('[data-id]');
    if (!row) return;
    if (e.target.closest('.trash-btn')) {
      angles = angles.filter(a => a.id !== row.dataset.id);
      if (selectedAngleId === row.dataset.id) selectedAngleId = angles.length ? angles[0].id : null;
      touch();
      return;
    }
    selectedAngleId = row.dataset.id;
    series = 'angle';
    refreshUI();
  });

  function addTrackFromInput() {
    const t = createTrack(nameInput.value);
    if (!t) return;
    selectedTrackId = t.id;
    nameInput.value = '';
    nameInput.blur(); // Why: so T and the arrow keys work straight away
    fns.selectTool('track');
    refreshUI();
  }

  let uiQueued = false;
  /** Coalesce refreshes: pose fills hundreds of points in one go, and one rebuild is enough. */
  function scheduleUI() {
    if (uiQueued) return;
    uiQueued = true;
    requestAnimationFrame(() => { uiQueued = false; refreshUI(); });
  }

  const curFrame = () => (KL.hasVideo ? fns.currentFrameIndex() : null);
  const fmtSpeed = (v, unit) => (v === null || v === undefined ? '--' : `${v.toFixed(unit === 'm' ? 2 : 0)} ${unit}/s`);

  /** Everything the sidebar shows depends on; the render hook rebuilds only when it changes. */
  function uiKey() {
    const sc = scaleInfo(fns.getVideoBox());
    return [version, curFrame(), fns.getVideoFps(), sc.s, selectedTrackId, selectedAngleId, series, advance,
      KL.bookmarks.map(b => b.time).join(','), graph.clientWidth, !!KL.lengthOverride].join('|');
  }
  let lastUIKey = '';

  /** Rebuild the track list, angle controls, pills, hint and graph. */
  function refreshUI() {
    lastUIKey = uiKey();
    const box = fns.getVideoBox();
    const f = curFrame();
    $('list').innerHTML = tracks.length ? tracks.map(t => {
      const k = kinematics(t, box);
      const r = f === null ? null : k.byFrame.get(f);
      const n = Object.keys(t.points).length;
      return `
        <div class="measure-item ${t.id === selectedTrackId ? 'selected' : ''}" data-id="${esc(t.id)}" title="${n} point(s)${r ? '' : ' · no point on this frame'}">
          <div class="measure-left">
            <span class="measure-dot" style="background:${t.color}"></span>
            <span class="measure-name">${esc(t.name)}</span>
          </div>
          <div class="measure-right">
            <span class="measure-val">${r ? fmtSpeed(r.speed, k.unit) : `${n} pts`}</span>
            <button type="button" class="trash-btn" title="Delete track">✕</button>
          </div>
        </div>`;
    }).join('') : '<div class="empty-state">Add a track (e.g. Knee), then click the joint on each frame. Speeds need a confirmed scale for m/s.</div>';

    // Why compare before rebuilding: replacing the options of an open <select> closes it.
    const opts = tracks.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
    angleSelects.forEach((s, i) => {
      const html = `<option value="">${['A…', 'B…', 'C…'][i]}</option>` + opts;
      const keep = s.value;
      if (s.dataset.trkKey !== html) { s.innerHTML = html; s.dataset.trkKey = html; }
      s.value = trackById(keep) ? keep : '';
    });
    $('angles').innerHTML = angles.map(a => {
      const cur = f === null ? null : angleSeries(a).find(r => r.f === f);
      return `
        <div class="measure-item ${a.id === selectedAngleId ? 'selected' : ''}" data-id="${esc(a.id)}">
          <div class="measure-left">
            <span class="measure-dot" style="background:var(--ios-purple)"></span>
            <span class="measure-name">${esc(angleName(a))}</span>
          </div>
          <div class="measure-right">
            <span class="measure-val">${cur ? cur.deg.toFixed(1) + '°' : '--'}</span>
            <button type="button" class="trash-btn" title="Delete angle">✕</button>
          </div>
        </div>`;
    }).join('');

    $('advance').querySelectorAll('.unit-btn').forEach(b => b.classList.toggle('active', Number(b.dataset.val) === advance));
    $('series').querySelectorAll('.unit-btn').forEach(b => b.classList.toggle('active', b.dataset.val === series));
    const unit = scaleInfo(box).unit;
    $('hint').textContent = (unit === 'm' ? 'Scale confirmed: positions in m, speed in m/s.' : 'No scale: positions in video px, speed in px/s. Calibrate with the Scale tool for m/s.')
      + (KL.lengthOverride ? ' The floor plane is not used for tracks (they are not on the floor).' : '')
      + ` Speed needs points no more than ${MAX_GAP_FRAMES} frames apart.`;
    drawGraph();
  }

  // ---- Track tool --------------------------------------------------------------------------
  // Click = place the selected track's point on this frame, then step `advance` frames, so a
  // movement is digitised by clicking the joint over and over. Pressing on a point already on
  // this frame grabs it: dragging moves it (no step), tapping the selected track's point
  // confirms it and steps.
  const btnHtml = `<button class="tool-btn" data-tool="track" data-adv style="display:none" onclick="selectTool('track')" title="Point tracking: click a landmark on each frame (T)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="6" r="2.5"/><path d="M3 20c3-1 4-6 7-8s5 0 6-3"/><circle cx="4" cy="19" r="1"/><circle cx="10" cy="12" r="1"/></svg><span>Track</span></button>`;
  KL.toolbar.insertAdjacentHTML('beforeend', btnHtml);

  /** Point of the current frame under the pointer, preferring the selected track. */
  function hitPoint(rawPt, box, f) {
    const order = [...tracks].sort((a, b) => (b.id === selectedTrackId) - (a.id === selectedTrackId));
    for (const t of order) {
      const p = t.points[f];
      if (!p) continue;
      const px = fns.normToPixel(p, box);
      if (Math.hypot(px.x - rawPt.x, px.y - rawPt.y) <= HIT_RADIUS) return { track: t, px };
    }
    return null;
  }

  KL.tools.track = {
    capturesAll: true, // Why: joints are often under an angle markup; digitising must still land
    prompt: () => {
      const t = trackById(selectedTrackId);
      return t
        ? `Track: click ${t.name} on each frame (steps ${advance} frame${advance === 1 ? '' : 's'}); drag a point to adjust`
        : 'Track: add a track in the sidebar (e.g. Knee), then click it on each frame';
    },
    onDown({ rawPt, normPt, box }) {
      if (!KL.hasVideo) { fns.showBanner('Open a video first, then track points frame by frame.', true); return; }
      if (!KL.video.paused) { KL.video.pause(); fns.updatePlayIcon(); }
      const f = fns.currentFrameIndex();
      const hit = hitPoint(rawPt, box, f);
      if (hit) {
        const wasSelected = hit.track.id === selectedTrackId;
        selectedTrackId = hit.track.id;
        // Why grab offset: the point stays where it sits relative to the pointer instead of jumping.
        KL.startDrag({ tool: 'track', trackId: hit.track.id, frame: f, grab: { x: hit.px.x - rawPt.x, y: hit.px.y - rawPt.y }, startPx: rawPt, moved: false, placed: false, wasSelected });
        refreshUI();
        return;
      }
      let t = trackById(selectedTrackId);
      if (!t) {
        // Why auto-create: a first click with no track should digitise, not be lost.
        t = createTrack(nameInput.value || 'Point 1');
        if (!t) return;
        selectedTrackId = t.id;
        nameInput.value = '';
      }
      if (!setPoint(t, f, normPt)) return;
      KL.startDrag({ tool: 'track', trackId: t.id, frame: f, grab: null, startPx: rawPt, moved: false, placed: true });
    },
    onMove({ rawPt, normPt, box, drag }) {
      const t = trackById(drag.trackId);
      if (!t) return;
      if (!drag.moved && Math.hypot(rawPt.x - drag.startPx.x, rawPt.y - drag.startPx.y) <= TAP_SLOP) return;
      drag.moved = true;
      const pos = drag.grab ? fns.pixelToNorm(rawPt.x + drag.grab.x, rawPt.y + drag.grab.y, box) : normPt;
      setPoint(t, drag.frame, pos);
    },
    onUp({ drag }) {
      fns.updatePromptBanner();
      // A new point (even nudged while held) or a tap confirming the selected track's point steps on.
      const step = drag.placed || (!drag.moved && drag.wasSelected);
      if (!step || advance === 0) return;
      const last = fns.totalFrames() - 1;
      if (drag.frame >= last) { fns.showBanner('Last frame reached.', false); return; }
      fns.seekToFrame(drag.frame + advance);
      fns.updateScrubberUI();
    }
  };

  // ---- Canvas overlay ----------------------------------------------------------------------
  KL.on('render', ({ ctx, box }) => {
    if (!KL.advanced) return;
    const f = curFrame();
    for (const t of tracks) {
      const frames = framesOf(t);
      if (!frames.length) continue;
      const pts = frames.map(n => fns.normToPixel(t.points[n], box));
      const isSel = t.id === selectedTrackId;
      ctx.save();
      // Path: thin and semi-transparent so it never hides the joint being digitised.
      ctx.strokeStyle = t.color;
      ctx.fillStyle = t.color;
      ctx.globalAlpha = isSel ? 0.6 : 0.4;
      ctx.lineWidth = 1.5; // px: thinner than markup lines (2+) so the path reads as a trace
      ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
      ctx.globalAlpha = isSel ? 0.85 : 0.6;
      pts.forEach((p, i) => {
        if (frames[i] === f) return;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2); // 2.5 px: visible but smaller than a 6 px handle
        ctx.fill();
      });
      ctx.restore();
      const cur = f === null ? null : t.points[f];
      if (cur) {
        const p = fns.normToPixel(cur, box);
        const r = kinematics(t, box);
        const k = r.byFrame.get(f);
        fns.drawHandle(p.x, p.y, t.color, false, isSel);
        const txt = k && k.speed !== null ? `${t.name} · ${fmtSpeed(k.speed, r.unit)}` : t.name;
        // Why +12/-34 px: up and right of the 6 px handle, clear of the 12 px selection ring
        fns.drawCanvasPill(p.x + 12, p.y - 34, txt, t.color, isSel);
      }
    }
    // Why here: the render hook runs after every seek, drag and playback frame, so the list's
    // speed and the graph cursor follow the frame without polling.
    if (uiKey() !== lastUIKey) refreshUI();
  });

  // ---- Graph -------------------------------------------------------------------------------
  const css = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  const PAD = { l: 44, r: 8, t: 14, b: 20 }; // CSS px: room for y labels (left), time labels (bottom)
  let layout = null; // plot rectangle and time span of the last draw, for click-to-seek

  /** Points of the chosen series: [{f, t, v}], with unit and caption. */
  function seriesData(box) {
    if (series === 'angle') {
      const a = angles.find(x => x.id === selectedAngleId);
      if (!a) return { pts: [], unit: '°', caption: 'Add an angle from three tracks to graph it.' };
      return { pts: angleSeries(a).map(r => ({ f: r.f, t: r.t, v: r.deg })), unit: '°', caption: `${angleName(a)} angle (interior, 0-180°)` };
    }
    const t = trackById(selectedTrackId);
    if (!t) return { pts: [], unit: '', caption: 'Select a track to graph it.' };
    const k = kinematics(t, box);
    if (series === 'speed') {
      return { pts: k.rows.filter(r => r.speed !== null).map(r => ({ f: r.f, t: r.t, v: r.speed })), unit: `${k.unit}/s`, caption: `${t.name} speed (central difference)` };
    }
    return { pts: k.rows.map(r => ({ f: r.f, t: r.t, v: r.y })), unit: k.unit, caption: `${t.name} height above the bottom of the frame` };
  }

  /** Draw the graph at device-pixel resolution with time on x and the series on y. */
  function drawGraph() {
    const cw = graph.clientWidth;
    if (!cw) { layout = null; return; } // hidden (Advanced off or sidebar collapsed)
    const dpr = window.devicePixelRatio || 1;
    graph.width = Math.round(cw * dpr);
    graph.height = Math.round(GRAPH_H * dpr);
    const g = graph.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, GRAPH_H);
    const box = fns.getVideoBox();
    const fps = fns.getVideoFps();
    const data = seriesData(box);
    $('caption').textContent = data.caption;
    const textCol = css('--text-secondary', '#98989F');
    const lineCol = css('--border-subtle', 'rgba(255,255,255,0.11)');
    const x0 = PAD.l, y0 = PAD.t, w = cw - PAD.l - PAD.r, h = GRAPH_H - PAD.t - PAD.b;
    const tMax = Math.max(1 / fps, (fns.totalFrames() - 1) / fps);
    layout = { x0, w, tMax };
    const X = t => x0 + (t / tMax) * w;

    let lo = 0, hi = 1;
    if (data.pts.length) {
      lo = Math.min(...data.pts.map(p => p.v));
      hi = Math.max(...data.pts.map(p => p.v));
      if (series === 'speed') lo = 0; // speed is never negative; a zero baseline reads honestly
      const pad = (hi - lo) * 0.1 || 1; // 10% headroom; a flat series gets +-1 unit
      if (series !== 'speed') lo -= pad;
      hi += pad;
    }
    const Y = v => y0 + h - ((v - lo) / (hi - lo)) * h;

    // Grid and labels: three y ticks (bottom, middle, top) and the clip's start and end time.
    g.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
    g.fillStyle = textCol;
    g.strokeStyle = lineCol;
    g.lineWidth = 1;
    g.textBaseline = 'middle';
    g.textAlign = 'right';
    const decimals = Math.abs(hi - lo) >= 10 ? 0 : Math.abs(hi - lo) >= 1 ? 1 : 2;
    for (const v of [lo, (lo + hi) / 2, hi]) {
      g.beginPath(); g.moveTo(x0, Y(v)); g.lineTo(x0 + w, Y(v)); g.stroke();
      g.fillText(v.toFixed(decimals), x0 - 4, Y(v));
    }
    g.textAlign = 'left';
    g.fillText(data.unit, 2, 6);
    g.textBaseline = 'top';
    g.fillText('0 s', x0, y0 + h + 6);
    g.textAlign = 'right';
    g.fillText(`${tMax.toFixed(2)} s`, x0 + w, y0 + h + 6);

    // Bookmark ticks along the time axis.
    g.strokeStyle = css('--ios-orange', '#FF9F0A');
    g.lineWidth = 2;
    for (const bm of KL.bookmarks) {
      const x = X(bm.time);
      g.beginPath(); g.moveTo(x, y0 + h - 5); g.lineTo(x, y0 + h + 3); g.stroke();
    }

    if (!data.pts.length) {
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = textCol;
      g.fillText('No data yet', x0 + w / 2, y0 + h / 2);
    } else {
      const t = trackById(selectedTrackId);
      g.strokeStyle = g.fillStyle = series === 'angle' ? css('--ios-purple', '#BF5AF2') : (t ? t.color : '#30D158');
      g.lineWidth = 1.8;
      g.beginPath();
      data.pts.forEach((p, i) => {
        // Why break the line at gaps: a straight line across undigitised frames would invent data.
        const join = i > 0 && p.f - data.pts[i - 1].f <= MAX_GAP_FRAMES;
        if (join) g.lineTo(X(p.t), Y(p.v)); else g.moveTo(X(p.t), Y(p.v));
      });
      g.stroke();
      for (const p of data.pts) { g.beginPath(); g.arc(X(p.t), Y(p.v), 1.6, 0, Math.PI * 2); g.fill(); }
    }

    // Cursor at the current frame.
    const f = curFrame();
    if (f !== null) {
      g.strokeStyle = css('--text-primary', '#FFFFFF');
      g.globalAlpha = 0.7;
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(X(f / fps), y0); g.lineTo(X(f / fps), y0 + h); g.stroke();
      g.globalAlpha = 1;
    }
  }

  graph.addEventListener('click', e => {
    if (!layout || !KL.hasVideo) return;
    const rect = graph.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - rect.left - layout.x0) / layout.w)) * layout.tMax;
    KL.video.pause();
    fns.updatePlayIcon();
    fns.seekToFrame(Math.round(t * fns.getVideoFps())); // frame n starts at n / fps
    fns.updateScrubberUI();
  });

  // ---- CSV, keyboard, public API -----------------------------------------------------------
  const bmNameAt = f => {
    const bm = KL.bookmarks.find(b => fns.bookmarkFrame(b) === f);
    return bm ? (bm.name || 'Unnamed') : '';
  };
  // Why the -0 fix: noise below the last decimal printed as "-0.000", which reads as a real sign.
  const num = (v, d) => (v === null || v === undefined ? '' : (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d));

  /**
   * One row per track per digitised frame (Value = speed), then one per frame of each angle.
   * Notes carry position (x right as displayed, y up, from the bottom-left of the frame), velocity and
   * acceleration components, blank where the central difference is undefined.
   */
  KL.on('csv', ({ rows, box }) => {
    if (!KL.advanced) return; // Why: Basic mode exports exactly what it always did
    for (const t of tracks) {
      const k = kinematics(t, box);
      const d = dec(k.unit);
      for (const r of k.rows) {
        rows.push([bmNameAt(r.f), r.f, r.t.toFixed(3), '', t.name, 'track', num(r.speed, d), `${k.unit}/s`, '',
          `x=${num(r.x, d)},y=${num(r.y, d)},vx=${num(r.vx, d)},vy=${num(r.vy, d)},ax=${num(r.ax, d)},ay=${num(r.ay, d)} (${k.unit}, ${k.unit}/s, ${k.unit}/s2)`]);
      }
    }
    for (const a of angles) {
      for (const r of angleSeries(a)) {
        rows.push([bmNameAt(r.f), r.f, r.t.toFixed(3), '', angleName(a), 'track-angle', r.deg.toFixed(1), 'deg', '', 'interior']);
      }
    }
  });

  window.addEventListener('keydown', e => {
    if (!KL.advanced || KL.isTextEntry(document.activeElement)) return;
    if (e.code !== 'KeyT' || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    fns.selectTool('track');
  });

  KL.on('advanced', () => refreshUI()); // the graph has no width while hidden, so draw on show

  KL.modules.tracking = {
    /**
     * Add or move a point, creating the track by name if it does not exist (used by adv/pose.js).
     * @param {string} trackName exact track name
     * @param {number} frame frame index (integer >= 0)
     * @param {{nx:number, ny:number}} pt normalized video coordinates
     * @returns {boolean} true if stored
     */
    addPoint(trackName, frame, pt) {
      const name = String(trackName || '').trim().slice(0, NAME_MAX);
      if (!name) return false;
      let t = tracks.find(x => x.name === name);
      if (!t) {
        t = createTrack(name);
        if (!t) return false;
        if (!selectedTrackId) selectedTrackId = t.id;
      }
      return setPoint(t, frame, pt);
    },
    /** Deep copy of all tracks: [{id, name, color, points: {frame: {nx, ny}}}]. */
    getTracks() {
      return tracks.map(t => ({ id: t.id, name: t.name, color: t.color, points: JSON.parse(JSON.stringify(t.points)) }));
    }
  };

  refreshUI();
})();
