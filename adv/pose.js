/** adv/pose.js - automatic pose detection (MediaPipe PoseLandmarker) that creates joint angles and fills tracks */
(() => {
  // ---- Model source ------------------------------------------------------------------------
  // Why 0.10.14: a published, long-stable release (2024) whose bundle, wasm and the float16
  // "full" model were all verified to exist (HTTP 200, CORS *) before relying on them.
  const TASKS_VERSION = '0.10.14';
  const BUNDLE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}/vision_bundle.mjs`;
  const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}/wasm`;
  const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';
  const MODEL_MB = 9; // pose_landmarker_full.task is 9.4 MB (Content-Length 9398198)

  const MIN_VISIBILITY = 0.5;  // Why 0.5: MediaPipe's own "landmark is visible" threshold
  const SEEK_TIMEOUT_MS = 3000; // Give up waiting for a seek after 3 s (stalled decoder) and move on
  const RVFC_GRACE_MS = 150;   // rVFC never fires if the frame was already presented at 'seeked'; wait at most this long
  const PROBE_POLL_MS = 100;   // How often to check whether the core's fps probe has finished
  const PROBE_WAIT_MS = 4000;  // Core probe gives up after 2.5 s (FPS_PROBE_TIMEOUT_MS); 4 s leaves margin

  // MediaPipe BlazePose landmark indices (33-point model), per body side.
  // Why subject-relative: MediaPipe's "left" is the athlete's left, which is what a coach means
  // by "left side facing the camera"; mirroring the view does not change it.
  const LANDMARKS = {
    left: { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27, toe: 31 },
    right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28, toe: 32 }
  };
  // Joint angles: [label, arm point, vertex, arm point]; interior 0-180 like the Angle tool.
  const ANGLES = [
    ['hip', 'shoulder', 'hip', 'knee'],
    ['knee', 'hip', 'knee', 'ankle'],
    ['ankle', 'knee', 'ankle', 'toe'],
    ['shoulder', 'hip', 'shoulder', 'elbow'],
    ['elbow', 'shoulder', 'elbow', 'wrist']
  ];
  const ANGLE_COLORS = ['#30D158', '#0A84FF', '#FF9F0A', '#FF453A', '#BF5AF2'];
  const TRACK_JOINTS = ['hip', 'knee', 'ankle', 'shoulder', 'elbow', 'wrist', 'toe'];

  const state = { side: 'left', step: 1, range: 'clip', busy: false, cancel: false, runToken: 0, mode: null };
  let landmarker = null;
  let loading = null;
  let loadAttempts = 0; // failed model loads so far; used to cache-bust the bundle URL on retry
  let grabCanvas = null;

  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const sideName = () => cap(state.side);

  // ---- UI ------------------------------------------------------------------------------------
  const TEXT = 'font-size:12px; color:var(--text-secondary)';
  const section = document.createElement('div');
  section.dataset.advSection = 'pose';
  section.style.cssText = 'display:flex; flex-direction:column; gap:8px';
  section.innerHTML = `
    <div class="section-label" style="margin-bottom:0">Pose detection (beta)</div>
    <div class="scale-input-row">
      <span style="${TEXT}">Side facing camera</span>
      <div class="unit-pills" data-pose-pills="side">
        <button type="button" class="unit-btn active" data-val="left">Left</button>
        <button type="button" class="unit-btn" data-val="right">Right</button>
      </div>
    </div>
    <button type="button" class="action-btn primary" data-pose-btn="detect" title="Find the body on this frame and add hip, knee, ankle, shoulder and elbow angles">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4.5" r="2"/><path d="M12 7v6l-3 7M12 13l3 7M7 10h10"/></svg>
      <span>Detect on this frame</span>
    </button>
    <div data-pose-track style="display:none; flex-direction:column; gap:8px">
      <div class="scale-input-row">
        <span style="${TEXT}">Every Nth frame</span>
        <div class="unit-pills" data-pose-pills="step">
          <button type="button" class="unit-btn active" data-val="1">1</button>
          <button type="button" class="unit-btn" data-val="2">2</button>
          <button type="button" class="unit-btn" data-val="5">5</button>
        </div>
      </div>
      <div class="scale-input-row">
        <span style="${TEXT}">Range</span>
        <div class="unit-pills" data-pose-pills="range">
          <button type="button" class="unit-btn active" data-val="clip" title="Every frame of the clip">Clip</button>
          <button type="button" class="unit-btn" data-val="phase" title="From the bookmark at or before this frame to the next bookmark">Phase</button>
        </div>
      </div>
      <button type="button" class="action-btn" data-pose-btn="track" title="Detect the pose on every frame and fill Point tracking tracks">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-5 4 4 8-8"/><circle cx="20" cy="8" r="1.5"/></svg>
        <span>Track whole clip</span>
      </button>
    </div>
    <div data-pose-status style="${TEXT}; line-height:1.45"></div>
    <div style="font-size:11px; color:var(--text-muted); line-height:1.45">The pose model (about ${MODEL_MB} MB) downloads from Google's CDN the first time you press a button. Your video never leaves this device: detection runs in the browser.</div>`;
  KL.panel.appendChild(section);

  const $ = sel => section.querySelector(sel);
  const detectBtn = $('[data-pose-btn="detect"]');
  const trackBtn = $('[data-pose-btn="track"]');
  const trackBox = $('[data-pose-track]');
  const statusEl = $('[data-pose-status]');

  section.querySelectorAll('[data-pose-pills]').forEach(group => {
    group.addEventListener('click', e => {
      const btn = e.target.closest('.unit-btn');
      if (!btn || state.busy) return;
      const key = group.dataset.posePills;
      state[key] = key === 'step' ? Number(btn.dataset.val) : btn.dataset.val;
      group.querySelectorAll('.unit-btn').forEach(b => b.classList.toggle('active', b === btn));
      refreshUI();
    });
  });
  detectBtn.addEventListener('click', () => detectThisFrame());
  trackBtn.addEventListener('click', () => (state.busy ? (state.cancel = true) : trackClip()));

  function setStatus(msg) { statusEl.textContent = msg || ''; }

  /** Show the clip-tracking block only when the tracking module exists, and the range it would cover. */
  function refreshUI() {
    const hasTracking = !!(KL.modules.tracking && KL.modules.tracking.addPoint);
    trackBox.style.display = hasTracking ? 'flex' : 'none';
    detectBtn.disabled = state.busy;
    detectBtn.style.opacity = state.busy ? '0.5' : '';
    trackBtn.classList.toggle('danger', state.busy && state.mode === 'track');
    trackBtn.querySelector('span').textContent = state.busy && state.mode === 'track' ? 'Cancel' : (state.range === 'clip' ? 'Track whole clip' : 'Track this phase');
    trackBtn.disabled = state.busy && state.mode !== 'track';
  }
  // Why on 'advanced': the tracking module's script loads after this one (alphabetical build
  // order), so it only exists by the time the saved mode is restored on DOMContentLoaded.
  // Why cancel when Advanced goes off: a hidden run would keep seeking the core's video.
  KL.on('advanced', ({ on } = {}) => { if (on === false && state.busy) state.cancel = true; refreshUI(); });
  KL.on('reset', () => { state.cancel = true; state.runToken++; setStatus(''); });

  // ---- Model loading ---------------------------------------------------------------------------

  /**
   * Load the PoseLandmarker on first use (never at page load).
   * Why try GPU then CPU: the WebGL delegate is much faster but unavailable on some machines
   * (and in headless browsers); CPU always works.
   * @param {string[]} delegates delegates to try in order
   * @returns {Promise<object>} the PoseLandmarker
   */
  async function ensureLandmarker(delegates = ['GPU', 'CPU']) {
    if (landmarker) return landmarker;
    if (!loading) {
      loading = (async () => {
        // Why the query on retry: the browser caches a failed dynamic import for the page's
        // lifetime, so re-importing the same URL after going back online would fail again.
        const vision = await import(loadAttempts ? `${BUNDLE_URL}?retry=${loadAttempts}` : BUNDLE_URL);
        const fileset = await vision.FilesetResolver.forVisionTasks(WASM_URL);
        let lastErr = null;
        for (const delegate of delegates) {
          try {
            const lm = await vision.PoseLandmarker.createFromOptions(fileset, {
              baseOptions: { modelAssetPath: MODEL_URL, delegate },
              runningMode: 'IMAGE',
              numPoses: 1 // Why 1: one athlete per clip; extra poses would only add false joints
            });
            lm.klDelegate = delegate;
            return lm;
          } catch (err) { lastErr = err; }
        }
        throw lastErr;
      })();
    }
    try {
      landmarker = await loading;
      return landmarker;
    } catch (err) {
      loading = null; // allow a retry once the connection is back
      loadAttempts++;
      throw err;
    }
  }

  /** Draw the displayed video frame at native resolution (unmirrored) and run detection on it. */
  async function detectCurrentFrame() {
    const video = KL.video;
    const w = video.videoWidth, h = video.videoHeight;
    if (!grabCanvas) grabCanvas = document.createElement('canvas');
    if (grabCanvas.width !== w || grabCanvas.height !== h) { grabCanvas.width = w; grabCanvas.height = h; }
    grabCanvas.getContext('2d').drawImage(video, 0, 0, w, h);
    let lm = await ensureLandmarker();
    let result;
    try {
      result = lm.detect(grabCanvas);
    } catch (err) {
      if (lm.klDelegate !== 'GPU') throw err;
      // Why: a GPU delegate can create fine but fail on the first frame; fall back once to CPU.
      landmarker = null; loading = null;
      try { lm.close(); } catch (e) { /* already unusable */ }
      lm = await ensureLandmarker(['CPU']);
      result = lm.detect(grabCanvas);
    }
    return result && result.landmarks && result.landmarks[0] ? result.landmarks[0] : null;
  }

  /**
   * The chosen side's joints as normalized points, or null where the landmark is unreliable.
   * MediaPipe x/y are already 0..1 of the image, the same frame KineLab stores markups in.
   * @returns {{pts: Object<string,{nx,ny}|null>}}
   */
  function sideJoints(landmarks) {
    const pts = {};
    for (const [joint, idx] of Object.entries(LANDMARKS[state.side])) {
      const l = landmarks[idx];
      // Why also reject off-image points: the model extrapolates hidden joints beyond the frame,
      // and clamping them onto the edge would silently bend the angle.
      const ok = l && Number.isFinite(l.x) && Number.isFinite(l.y) && l.x >= 0 && l.x <= 1 && l.y >= 0 && l.y <= 1 &&
        !(Number.isFinite(l.visibility) && l.visibility < MIN_VISIBILITY);
      pts[joint] = ok ? { nx: l.x, ny: l.y } : null;
    }
    return pts;
  }

  /**
   * Wait for the core's frame-rate probe (it plays the clip for up to 2.5 s after opening it).
   * Why wait rather than pause: pausing starves the probe, so the clip keeps the 30 fps default
   * and every frame index (track frames, the bookmark that owns the angles) is computed under
   * the wrong rate; the probe's own timeout would also jump the video back to frame 0 mid-run.
   * Why the bare core variable: KL exposes no probe state.
   */
  async function waitForFpsProbe() {
    const probing = () => typeof abortFpsProbe === 'function';
    const until = Date.now() + PROBE_WAIT_MS;
    while (probing() && Date.now() < until) await new Promise(r => setTimeout(r, PROBE_POLL_MS));
  }

  /** Pause and make sure the current frame is actually presented before grabbing it. */
  async function settleCurrentFrame() {
    const video = KL.video;
    await waitForFpsProbe();
    // Why also when seeking: the probe ends with a seek to frame 0 that may still be in flight.
    if (!video.paused || video.readyState < 2 || video.seeking) {
      video.pause();
      KL.fns.updatePlayIcon();
      await seekAndWait(KL.fns.currentFrameIndex());
    }
  }

  /**
   * Seek to frame n and resolve once it is on screen ('seeked', then requestVideoFrameCallback
   * or a short grace period when the frame was already presented).
   */
  function seekAndWait(n) {
    const video = KL.video;
    return new Promise(resolve => {
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(guard); resolve(); } };
      const guard = setTimeout(finish, SEEK_TIMEOUT_MS);
      video.addEventListener('seeked', () => {
        if (typeof video.requestVideoFrameCallback === 'function') {
          video.requestVideoFrameCallback(() => finish());
          setTimeout(finish, RVFC_GRACE_MS);
        } else finish();
      }, { once: true });
      KL.fns.seekToFrame(n);
    });
  }

  function loadFailed(err) {
    console.error('KineLab pose model load failed:', err);
    setStatus('Pose model could not be loaded.');
    KL.fns.showBanner('Could not load the pose model from Google\'s CDN. Check the internet connection (it is needed once to download the model) and try again.', true);
  }

  // ---- Detect on this frame ----------------------------------------------------------------

  /**
   * Detect the pose on the displayed frame and add one editable 'angle' markup per joint of
   * the chosen side, owned by the current bookmark. Re-detecting replaces the same-named
   * angles on the same bookmark instead of stacking duplicates.
   */
  async function detectThisFrame() {
    if (state.busy) return;
    if (!KL.hasVideo) { KL.fns.showBanner('Open a video first, then detect the pose on a frame.', true); return; }
    state.busy = true; state.mode = 'detect'; refreshUI();
    const token = state.runToken;
    try {
      setStatus(landmarker ? 'Detecting…' : 'Loading pose model…');
      await settleCurrentFrame();
      let landmarks;
      try { landmarks = await detectCurrentFrame(); } catch (err) { loadFailed(err); return; }
      if (token !== state.runToken) return; // a new clip was opened meanwhile
      if (!landmarks) {
        setStatus('No person found on this frame.');
        KL.fns.showBanner('No person detected on this frame. Try a frame where the whole body is in view.', true);
        return;
      }
      const pts = sideJoints(landmarks);
      const bookmarkId = KL.fns.bookmarkIdForNewItem('angle');
      const side = sideName();
      const stamp = Date.now();
      const added = [], skipped = [];
      ANGLES.forEach(([joint, a, v, c], i) => {
        const label = `${side} ${joint}`;
        const missing = [a, v, c].filter(k => !pts[k]);
        if (missing.length) { skipped.push(`${joint} (${missing.join(', ')} not visible)`); return; }
        // Why replace: pressing Detect again (e.g. after switching side or re-bookmarking)
        // should refresh this phase's angles, not pile up copies.
        KL.annotations = KL.annotations.filter(x => !(x.type === 'angle' && x.label === label && x.bookmarkId === bookmarkId));
        const item = {
          id: `ang_${stamp}_${i}`,
          type: 'angle',
          label,
          color: ANGLE_COLORS[i],
          dashed: false,
          reflex: false,
          bookmarkId,
          p1: { ...pts[a] },
          vertex: { ...pts[v] },
          p3: { ...pts[c] }
        };
        KL.annotations.push(item);
        added.push(item);
      });
      if (added.length) KL.selectedId = added[0].id;
      KL.fns.syncInspectorUI();
      KL.fns.renderFrame();
      const where = bookmarkId ? 'on this bookmark' : 'on every frame (bookmark the frame first to keep them to this phase)';
      const msg = added.length
        ? `Added ${added.length} ${side.toLowerCase()} angle${added.length === 1 ? '' : 's'} ${where}.` + (skipped.length ? ` Skipped ${skipped.join('; ')}.` : '')
        : `No angles added: ${skipped.join('; ')}. Is the ${side.toLowerCase()} side facing the camera?`;
      setStatus(msg);
      KL.fns.showBanner(msg, !added.length);
    } finally {
      state.busy = false; refreshUI();
    }
  }

  // ---- Track whole clip ----------------------------------------------------------------------

  /** Frame range to track: the whole clip, or the active phase (bookmark at/before now to the next one). */
  function trackRange() {
    const last = KL.fns.totalFrames() - 1;
    if (state.range === 'clip') return { start: 0, end: last };
    const cur = KL.fns.currentFrameIndex();
    const frames = KL.bookmarks.map(b => KL.fns.bookmarkFrame(b));
    const before = frames.filter(f => f <= cur);
    const after = frames.filter(f => f > cur);
    return {
      start: before.length ? Math.max(...before) : 0,
      end: Math.min(last, after.length ? Math.min(...after) : last)
    };
  }

  /**
   * Detect every Nth frame of the range and add the chosen side's joints to tracks named
   * '<Side> hip' etc. via KL.modules.tracking.addPoint, then return to the starting frame.
   * Why buffer and add at the end: the core commits undo steps every 250 ms, so adding points
   * live would split one run into dozens of undo steps; one flush is one step. Cancel keeps
   * the frames already detected.
   */
  async function trackClip() {
    const tracking = KL.modules.tracking;
    if (!tracking || !tracking.addPoint) return;
    if (!KL.hasVideo) { KL.fns.showBanner('Open a video first, then track the clip.', true); return; }
    const video = KL.video;
    state.busy = true; state.cancel = false; state.mode = 'track'; refreshUI();
    const token = state.runToken;
    let startFrame = 0;
    const side = sideName();
    const buffer = []; // [{frame, pts}]
    let stoppedBy = null;
    let noPose = 0; // frames where the model found nobody
    let noSeek = 0; // frames the decoder never landed on
    try {
      await waitForFpsProbe();
      video.pause(); KL.fns.updatePlayIcon();
      // Why read the start frame only now: the fps (and so the frame index) is final after the probe.
      startFrame = KL.fns.currentFrameIndex();
      setStatus(landmarker ? 'Starting…' : 'Loading pose model…');
      try { await ensureLandmarker(); } catch (err) { loadFailed(err); return; }
      const { start, end } = trackRange();
      const frames = [];
      for (let f = start; f <= end; f += state.step) frames.push(f);
      for (let i = 0; i < frames.length; i++) {
        if (token !== state.runToken) return; // new clip opened: drop everything
        if (state.cancel) { stoppedBy = 'cancel'; break; }
        if (!video.paused) { stoppedBy = 'playback'; break; }
        const f = frames[i];
        setStatus(`Detecting frame ${f} (${i + 1} of ${frames.length}, ${Math.round((i / frames.length) * 100)}%)`);
        await seekAndWait(f);
        if (KL.fns.currentFrameIndex() !== f) { noSeek++; continue; } // seek did not land (stalled decoder)
        let landmarks;
        try { landmarks = await detectCurrentFrame(); } catch (err) { loadFailed(err); stoppedBy = 'error'; break; }
        if (landmarks) buffer.push({ frame: f, pts: sideJoints(landmarks) }); else noPose++;
      }
      if (token !== state.runToken) return;
      let added = 0, refused = 0; // refused: the tracking module's track/point caps were hit
      for (const { frame, pts } of buffer) {
        for (const joint of TRACK_JOINTS) {
          if (!pts[joint]) continue;
          if (tracking.addPoint(`${side} ${joint}`, frame, pts[joint]) === false) refused++; else added++;
        }
      }
      if (stoppedBy !== 'playback') await seekAndWait(startFrame);
      KL.fns.renderFrame();
      const head = stoppedBy === 'cancel' ? 'Cancelled; kept' : stoppedBy === 'playback' ? 'Stopped by playback; kept' : stoppedBy === 'error' ? 'Stopped by an error; kept' : 'Done:';
      const msg = `${head} ${added} points on ${buffer.length} frame${buffer.length === 1 ? '' : 's'} in ${side.toLowerCase()} joint tracks.` +
        (noPose ? ` No person found on ${noPose} frame${noPose === 1 ? '' : 's'}.` : '') +
        (noSeek ? ` ${noSeek} frame${noSeek === 1 ? '' : 's'} could not be shown.` : '') +
        (refused ? ` ${refused} point${refused === 1 ? '' : 's'} not stored (tracking limit reached).` : '');
      setStatus(msg);
      if (stoppedBy !== 'error') KL.fns.showBanner(msg, added === 0);
    } finally {
      state.busy = false; state.cancel = false; state.mode = null; refreshUI();
    }
  }

  refreshUI();
})();
