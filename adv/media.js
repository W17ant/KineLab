/** adv/media.js - compare a second clip (side by side / overlay) and export the annotated clip as video */
(() => {
  const KL = window.KL;

  // ---- Constants ------------------------------------------------------------------------------
  const MODES = ['off', 'side', 'overlay'];
  const SPEEDS = [1, 0.5, 0.25];
  const DEFAULT_OPACITY = 0.5;
  const MAX_OFFSET_S = 3600;      // Why 1 h: no real comparison needs more; caps junk from session files
  const DRIFT_S = 0.1;            // Why 0.1 s: B is re-seeked during playback only past ~2.5 frames at 25 fps,
                                  // tighter would make it stutter on every decoder hiccup
  const SEEK_TIMEOUT_MS = 3000;   // Safety net if a 'seeked' event never arrives
  const RVFC_TIMEOUT_MS = 250;    // requestVideoFrameCallback never fires if the presented frame didn't change
  const EXPORT_BITRATE = 8e6;     // Why 8 Mbit/s: keeps thin markup lines and joint labels crisp at ~1080p
  const SIDE_FRACTION = 0.5;      // Side by side: right half of the stage is B's

  // ---- State ----------------------------------------------------------------------------------
  let mode = 'off';
  let opacity = DEFAULT_OPACITY;
  let offset = 0;          // seconds: B.currentTime = A.currentTime + offset while linked
  let linked = true;       // false after B was moved by hand, until "Sync here"
  let bLoaded = false;
  let bName = null;
  let bUrl = null;
  let exportSpeed = 1;
  let exportJob = null;    // { cancelled } while an export runs

  // Why a separate hidden element: B is decoded independently of A and only ever drawn to the canvas.
  const vb = document.createElement('video');
  vb.muted = true;
  vb.playsInline = true;
  vb.setAttribute('playsinline', '');
  vb.preload = 'auto';
  vb.style.display = 'none';
  document.body.appendChild(vb);

  const fns = () => KL.fns;
  const compareActive = () => KL.advanced && bLoaded && mode !== 'off';

  // ---- UI -------------------------------------------------------------------------------------
  const ICON = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const section = document.createElement('div');
  section.setAttribute('data-adv-section', 'media');
  section.innerHTML = `
    <div class="section-label">Compare &amp; export</div>
    <div style="display:flex; flex-direction:column; gap:8px">
      <input type="file" id="mediaFileInput" accept="video/mp4,video/quicktime,video/webm,video/*" style="display:none">
      <button type="button" class="action-btn" id="mediaOpenBtn" title="Open a second clip to compare against this one">
        ${ICON('<rect x="2" y="5" width="9" height="14" rx="1.5"/><rect x="13" y="5" width="9" height="14" rx="1.5"/>')}
        <span id="mediaOpenText">Open comparison video</span>
      </button>
      <div class="unit-pills" id="mediaModePills">
        <button type="button" class="unit-btn" data-media-mode="off" style="flex:1">Off</button>
        <button type="button" class="unit-btn" data-media-mode="side" style="flex:1">Side by side</button>
        <button type="button" class="unit-btn" data-media-mode="overlay" style="flex:1">Overlay</button>
      </div>
      <div>
        <div class="section-label" id="mediaOpacityLabel">Overlay opacity · 50%</div>
        <input type="range" id="mediaOpacity" class="scrubber-slider" min="0" max="100" step="1" value="50" style="width:100%">
      </div>
      <div>
        <div class="section-label" id="mediaBPosLabel">Clip B position</div>
        <input type="range" id="mediaBPos" class="scrubber-slider" min="0" max="1000" step="1" value="0" style="width:100%">
      </div>
      <div class="modal-actions">
        <button type="button" class="action-btn" id="mediaBPrev" title="Move clip B back one frame">◀ B frame</button>
        <button type="button" class="action-btn" id="mediaBNext" title="Move clip B forward one frame">B frame ▶</button>
      </div>
      <button type="button" class="action-btn" id="mediaSyncBtn" title="Lock B to A at the frames shown now">
        ${ICON('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>')}
        <span>Sync here</span>
      </button>
      <div class="empty-state" id="mediaStatus" style="padding:10px 12px">No comparison video</div>
    </div>
    <div class="section-label" style="margin-top:14px">Export annotated clip</div>
    <div style="display:flex; flex-direction:column; gap:8px">
      <div class="modal-actions">
        <select id="mediaFrom" class="text-input" style="padding-right:11px" title="Start of the exported range"></select>
        <select id="mediaTo" class="text-input" style="padding-right:11px" title="End of the exported range"></select>
      </div>
      <div class="unit-pills" id="mediaSpeedPills">
        ${SPEEDS.map(s => `<button type="button" class="unit-btn" data-media-speed="${s}" style="flex:1">${s}x</button>`).join('')}
      </div>
      <button type="button" class="action-btn primary" id="mediaExportBtn" title="Record the annotated clip frame by frame">
        ${ICON('<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>')}
        <span id="mediaExportText">Export video</span>
      </button>
    </div>`;
  KL.panel.appendChild(section);
  const $ = (id) => document.getElementById(id);

  /** Refresh every control in the section from the module state. */
  function syncUI() {
    document.querySelectorAll('[data-media-mode]').forEach(b => b.classList.toggle('active', b.dataset.mediaMode === mode));
    document.querySelectorAll('[data-media-speed]').forEach(b => b.classList.toggle('active', Number(b.dataset.mediaSpeed) === exportSpeed));
    $('mediaOpacity').value = String(Math.round(opacity * 100));
    $('mediaOpacityLabel').textContent = `Overlay opacity · ${Math.round(opacity * 100)}%`;
    $('mediaOpenText').textContent = bLoaded ? 'Replace comparison video' : 'Open comparison video';
    for (const id of ['mediaBPos', 'mediaBPrev', 'mediaBNext', 'mediaSyncBtn']) $(id).disabled = !bLoaded;
    syncBPos();
    const st = $('mediaStatus');
    if (!bLoaded) {
      st.textContent = 'No comparison video';
    } else {
      // Offset in A's frames, for a coach reading "B is 8 frames ahead"; sign: positive = B later in its clip.
      const fps = fns().getVideoFps();
      const frames = Math.round(offset * fps);
      const sign = offset >= 0 ? '+' : '−';
      st.innerHTML = `B: ${fns().escapeHtml(bName || 'clip')}<br>` +
        (linked ? `Synced · B = A ${sign} ${Math.abs(offset).toFixed(3)} s (${sign}${Math.abs(frames)} F)`
                : 'Not synced · line up both clips, then press Sync here');
    }
  }

  /** Keep the B position slider and its label on B's current time. */
  function syncBPos() {
    const dur = vb.duration || 0;
    if (!bLoaded || !dur) { $('mediaBPos').value = '0'; $('mediaBPosLabel').textContent = 'Clip B position'; return; }
    // Why A's fps for B's frame number: the browser exposes no frame rate, and comparison clips
    // normally come from the same camera setup.
    const n = Math.floor(vb.currentTime * fns().getVideoFps() + 1e-4);
    $('mediaBPos').value = String(Math.round(vb.currentTime / dur * 1000));
    $('mediaBPosLabel').textContent = `Clip B position · F${n} · ${vb.currentTime.toFixed(2)} s`;
  }

  /** Rebuild the From/To selects from the bookmarks, keeping the current choice when it still exists. */
  function syncRangeSelects() {
    const bms = [...KL.bookmarks].sort((a, b) => a.time - b.time);
    const esc = fns().escapeHtml;
    const opts = (edge) => `<option value="${edge}">${edge === 'start' ? 'Clip start' : 'Clip end'}</option>` +
      bms.map(b => `<option value="${esc(b.id)}">${esc(b.name || 'Unnamed')} · F${fns().bookmarkFrame(b)}</option>`).join('');
    for (const [id, edge] of [['mediaFrom', 'start'], ['mediaTo', 'end']]) {
      const sel = $(id);
      const keep = sel.value;
      const html = opts(edge);
      if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
      sel.value = [...sel.options].some(o => o.value === keep) ? keep : edge;
    }
  }

  // ---- Clip B: loading and sync ---------------------------------------------------------------
  $('mediaOpenBtn').addEventListener('click', () => $('mediaFileInput').click());
  $('mediaFileInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (bUrl) URL.revokeObjectURL(bUrl);
    bUrl = URL.createObjectURL(file);
    bLoaded = false;
    vb.onerror = () => {
      bLoaded = false;
      bName = null;
      applyView();
      // Same wording as the core's codec error for clip A.
      fns().showBanner(`Couldn't open "${file.name}": this browser can't decode its video codec. Convert it to H.264 MP4 and try again.`, true);
    };
    vb.onloadeddata = () => {
      bLoaded = true;
      bName = file.name;
      offset = 0;
      linked = true;
      // Why switch on: opening a comparison clip with the view off would look like nothing happened.
      if (mode === 'off') mode = 'side';
      vb.pause();
      applyView();
      syncB(true);
      fns().showBanner(`Comparison clip "${file.name}" loaded. Line it up and press Sync here.`, false);
    };
    vb.src = bUrl;
    vb.load();
  });

  /** B time that matches A's current time under the sync offset, clamped into B's clip. */
  function bTarget() {
    const raw = KL.video.currentTime + offset;
    const dur = vb.duration || 0;
    // Why minus 1e-3: parking B exactly on its duration shows no frame in some decoders.
    return { raw, t: Math.max(0, Math.min(Math.max(0, dur - 1e-3), raw)), outOfRange: raw < 0 || raw > dur };
  }

  /**
   * Move B to A.time + offset. Paused: exact seek. Playing: let B play and only re-seek past DRIFT_S.
   * @param {boolean} force seek even if B is close already
   */
  function syncB(force) {
    if (!compareActive() || !linked || exportJob) return;
    const A = KL.video;
    const { t, raw } = bTarget();
    if (!A.paused && KL.hasVideo) {
      vb.playbackRate = A.playbackRate;
      if (raw < 0 || raw >= (vb.duration || 0)) { if (!vb.paused) vb.pause(); }
      else if (vb.paused) { vb.currentTime = t; vb.play().catch(() => {}); }
      if (force || Math.abs(vb.currentTime - t) > DRIFT_S) vb.currentTime = t;
    } else {
      if (!vb.paused) vb.pause();
      if (force || Math.abs(vb.currentTime - t) > 1e-4) vb.currentTime = t;
    }
  }

  KL.on('frame', () => syncB(false));
  const A = KL.video;
  // Why pause during export: the export steps A itself; playback (Space, play button) would move
  // A between a seek and its capture and put the wrong frames in the file. Not after a new clip
  // opened: that export is already cancelled, and the core's fps probe has to play the new clip.
  A.addEventListener('play', () => {
    if (exportJob && !exportJob.newClip) { A.pause(); fns().updatePlayIcon(); } else syncB(true);
  });
  A.addEventListener('pause', () => syncB(true));
  A.addEventListener('seeked', () => syncB(false));
  A.addEventListener('ratechange', () => { vb.playbackRate = A.playbackRate; });
  vb.addEventListener('seeked', () => {
    syncBPos();
    if (!compareActive() || exportJob) return;
    fns().renderFrame();
    // Same reason as the core: the sought frame may only be presented a moment after 'seeked'.
    if (typeof vb.requestVideoFrameCallback === 'function') vb.requestVideoFrameCallback(() => { if (!exportJob) fns().renderFrame(); });
  });
  vb.addEventListener('timeupdate', syncBPos);

  /** Hand-move B (unlinks it until Sync here). */
  function moveB(t) {
    if (!bLoaded) return;
    linked = false;
    vb.pause();
    vb.currentTime = Math.max(0, Math.min(Math.max(0, (vb.duration || 0) - 1e-3), t));
    syncUI();
  }
  $('mediaBPos').addEventListener('input', (e) => moveB(Number(e.target.value) / 1000 * (vb.duration || 0)));
  // Why +0.5: aim mid-frame like the core's seekToFrame so rounding cannot land on the neighbour.
  const stepB = (d) => {
    const fps = fns().getVideoFps();
    moveB((Math.floor(vb.currentTime * fps + 1e-4) + d + 0.5) / fps);
  };
  $('mediaBPrev').addEventListener('click', () => stepB(-1));
  $('mediaBNext').addEventListener('click', () => stepB(1));
  $('mediaSyncBtn').addEventListener('click', () => {
    if (!bLoaded) return;
    // offset (s) = B.currentTime - A.currentTime, so the two moments shown now stay paired.
    offset = Math.max(-MAX_OFFSET_S, Math.min(MAX_OFFSET_S, vb.currentTime - KL.video.currentTime));
    linked = true;
    syncUI();
    fns().showBanner(`Clips synced: B runs ${offset >= 0 ? '+' : '−'}${Math.abs(offset).toFixed(3)} s from A.`, false);
  });

  document.querySelectorAll('[data-media-mode]').forEach(b => b.addEventListener('click', () => {
    mode = b.dataset.mediaMode;
    if (mode !== 'off' && !bLoaded) fns().showBanner('Open a comparison video first.', true);
    applyView();
    syncB(true);
  }));
  $('mediaOpacity').addEventListener('input', (e) => {
    opacity = Math.max(0, Math.min(1, Number(e.target.value) / 100));
    syncUI();
    fns().renderFrame();
  });
  document.querySelectorAll('[data-media-speed]').forEach(b => b.addEventListener('click', () => {
    exportSpeed = Number(b.dataset.mediaSpeed);
    syncUI();
  }));

  /** Apply the stage split for the current mode; Advanced off always restores the core view. */
  function applyView() {
    const want = compareActive() && mode === 'side' ? SIDE_FRACTION : 0;
    if (!compareActive() && !vb.paused) vb.pause();
    if (KL.view.reserveRight !== want) {
      KL.view.reserveRight = want;
      fns().resizeStage(); // re-renders with the new A box
    } else {
      fns().renderFrame();
    }
    syncUI();
  }

  KL.on('advanced', ({ on }) => {
    // Why cancel: Advanced off hides the export button (the only Cancel) and moves A's box.
    if (!on && exportJob) { exportJob.cancelled = true; setExportText('Cancelling…'); }
    applyView();
    syncB(true);
  });
  // Why keep B on a new clip A: B is the reference (e.g. last week's squat); only re-sync it.
  KL.on('reset', () => {
    if (exportJob) { exportJob.cancelled = true; exportJob.newClip = true; }
    syncRangeSelects();
  });
  KL.on('videoload', () => { syncRangeSelects(); syncB(true); syncUI(); });
  KL.on('change', syncRangeSelects);
  $('mediaFrom').addEventListener('focus', syncRangeSelects);
  $('mediaTo').addEventListener('focus', syncRangeSelects);

  // ---- Drawing --------------------------------------------------------------------------------
  /** Contain-fit B (bw x bh) into rect r; returns the draw rect. */
  function fitInto(r, bw, bh) {
    const s = Math.min(r.w / bw, r.h / bh);
    const w = bw * s, h = bh * s;
    return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
  }

  /** Right-half rect of the stage used for B in side-by-side mode (CSS px). */
  function sideRect() {
    const sw = KL.stage.clientWidth, sh = KL.stage.clientHeight;
    return { x: sw * (1 - SIDE_FRACTION), y: 0, w: sw * SIDE_FRACTION, h: sh };
  }

  KL.on('renderVideo', ({ ctx, box }) => {
    if (!compareActive() || vb.readyState < 2 || !vb.videoWidth) return;
    ctx.save();
    if (mode === 'side') {
      const r = sideRect();
      // Why clear first: a zoomed A can spill past its half, and B must not sit on top of it.
      ctx.clearRect(r.x, r.y, r.w, r.h);
      const d = fitInto(r, vb.videoWidth, vb.videoHeight);
      ctx.drawImage(vb, d.x, d.y, d.w, d.h);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(r.x + 0.5, 0);
      ctx.lineTo(r.x + 0.5, r.h);
      ctx.stroke();
    } else {
      // Same box as A (follows zoom and pan); contain-fit so a different aspect ratio is not stretched.
      const d = fitInto(box, vb.videoWidth, vb.videoHeight);
      ctx.globalAlpha = opacity;
      ctx.drawImage(vb, d.x, d.y, d.w, d.h);
    }
    ctx.restore();
    // During playback, correct drift once per drawn frame.
    if (!KL.video.paused) syncB(false);
  });

  const PILL_H = 26;    // drawCanvasPill height
  const PILL_PAD = 12;  // gap from the panel edge
  KL.on('render', ({ box }) => {
    if (!compareActive() || exportJob) return;
    const sw = KL.stage.clientWidth, sh = KL.stage.clientHeight;
    const { outOfRange } = bTarget();
    const bText = `B${linked ? '' : ' · not synced'}${linked && outOfRange ? ' · out of range' : ''}`;
    // Why bottom-left: the prompt banner sits at the top centre, right on the side-by-side seam.
    const aX = Math.max(PILL_PAD, box.x + PILL_PAD);
    const aY = Math.min(sh, box.y + box.h) - PILL_H - PILL_PAD;
    if (mode === 'side') {
      const d = fitInto(sideRect(), vb.videoWidth || 1, vb.videoHeight || 1);
      fns().drawCanvasPill(Math.min(aX, sw * (1 - SIDE_FRACTION) - 40), aY, 'A', '#30D158', false);
      fns().drawCanvasPill(d.x + PILL_PAD, Math.min(sh, d.y + d.h) - PILL_H - PILL_PAD, bText, '#0A84FF', false);
    } else {
      fns().drawCanvasPill(aX, aY, 'A', '#30D158', false);
      fns().drawCanvasPill(aX + 34, aY, `${bText} · ${Math.round(opacity * 100)}%`, '#0A84FF', false);
    }
  });

  // ---- Export annotated clip ------------------------------------------------------------------
  // Flow: pause, hide selection, then for each frame n in the range: seek A (and B), wait until the
  // frame is presented, render the stage, copy the A video box into a recording canvas at its time
  // slot. Why step instead of play: real-time playback drops frames whenever decoding or drawing
  // runs late, and a coach needs every frame. Each frame is shown for exactly
  // P = slowdown / fps seconds of recording time (fps = A's frame rate); when a seek takes longer
  // than P the recorder is paused, so the wait never ends up in the file.

  /** First supported recording type, preferring MP4 (plays everywhere) over WebM. */
  function pickMime() {
    for (const m of ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm']) {
      if (MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
  }

  /**
   * Seek a video and resolve once the new frame is presented (or a timeout passed).
   * @param {HTMLVideoElement} v
   * @param {() => void} doSeek sets currentTime
   */
  function seekAndWait(v, doSeek) {
    return new Promise(resolve => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const before = v.currentTime;
      const hasRvfc = typeof v.requestVideoFrameCallback === 'function';
      // Why register before seeking: the new frame is often presented before 'seeked' fires, and a
      // callback registered after that would wait for a frame that never comes (paused video).
      let presented = !hasRvfc, seeked = false;
      if (hasRvfc) v.requestVideoFrameCallback(() => { presented = true; if (seeked) finish(); });
      v.addEventListener('seeked', () => {
        seeked = true;
        if (presented) finish();
        else setTimeout(finish, RVFC_TIMEOUT_MS);
      }, { once: true });
      setTimeout(finish, SEEK_TIMEOUT_MS);
      doSeek();
      // Same target as now: no seek happens, so no event will come.
      if (!v.seeking && v.currentTime === before) finish();
    });
  }

  /** Frame index for a From/To select value. */
  function rangeFrame(val, edge) {
    if (val === 'start') return 0;
    if (val === 'end') return fns().totalFrames() - 1;
    const bm = KL.bookmarks.find(b => b.id === val);
    if (bm) return fns().bookmarkFrame(bm);
    return edge === 'start' ? 0 : fns().totalFrames() - 1;
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, Math.max(0, ms)));
  const setExportText = (t) => { $('mediaExportText').textContent = t; };

  $('mediaExportBtn').addEventListener('click', () => {
    if (exportJob) { exportJob.cancelled = true; setExportText('Cancelling…'); return; }
    exportClip();
  });

  /** Record the chosen range of the annotated clip and download it. */
  async function exportClip() {
    if (!KL.hasVideo) { fns().showBanner('Open a video first.', true); return; }
    if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) {
      fns().showBanner('This browser cannot record video. Try a current Chrome, Edge or Safari.', true);
      return;
    }
    const mime = pickMime();
    if (!mime) { fns().showBanner('This browser cannot record MP4 or WebM video.', true); return; }

    // Why refuse while the core's fps probe runs instead of aborting it: an abort before it has 3 frame
    // deltas leaves the rate on the 30 fps default for good (a 25 fps clip then exported 60 of
    // its 50 frames), and a finishing probe seeks A back to 0 mid-export. abortFpsProbe is a
    // core global (not in KL.fns), hence the typeof guard.
    if (typeof abortFpsProbe === 'function') {
      fns().showBanner('Still detecting the frame rate. Try again in a moment.', true);
      return;
    }
    const A = KL.video;
    A.pause();
    vb.pause();
    syncRangeSelects();
    let f0 = rangeFrame($('mediaFrom').value, 'start');
    let f1 = rangeFrame($('mediaTo').value, 'end');
    if (f0 > f1) [f0, f1] = [f1, f0];
    const fps = fns().getVideoFps();
    const slow = exportSpeed;
    const streamFps = fps * slow;               // frames per recorded second, e.g. 25 fps at 0.25x -> 6.25
    const periodMs = 1000 / streamFps;          // P: how long each frame stays on screen in the file

    const job = exportJob = { cancelled: false, newClip: false };
    const savedTime = A.currentTime;
    const savedSel = KL.selectedId;
    KL.selectedId = null; // no selection rings in the file

    // Crop: A's video box clipped to its part of the stage (zoom can push the box past the edges).
    const box = fns().getVideoBox();
    const sw = KL.stage.clientWidth * (1 - (KL.view.reserveRight || 0)), sh = KL.stage.clientHeight;
    const cx0 = Math.max(0, box.x), cy0 = Math.max(0, box.y);
    const cx1 = Math.min(sw, box.x + box.w), cy1 = Math.min(sh, box.y + box.h);
    const dpr = window.devicePixelRatio || 1;
    const rec = document.createElement('canvas');
    // Why even sizes: H.264 encoders reject odd frame dimensions.
    rec.width = Math.max(2, Math.floor((cx1 - cx0) * dpr / 2) * 2);
    rec.height = Math.max(2, Math.floor((cy1 - cy0) * dpr / 2) * 2);
    const rctx = rec.getContext('2d');
    const stream = rec.captureStream(streamFps);
    const track = stream.getVideoTracks()[0];
    const chunks = [];
    let recorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: EXPORT_BITRATE });
    } catch (err) {
      exportJob = null;
      KL.selectedId = savedSel;
      fns().showBanner('Could not start the video recorder.', true);
      return;
    }
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise(r => { recorder.onstop = r; });

    /** Seek A (and B when overlaid) to frame n and wait for both to present. */
    const prepare = async (n) => {
      await seekAndWait(A, () => fns().seekToFrame(n));
      if (compareActive() && mode === 'overlay' && linked) {
        const { t } = bTarget();
        if (Math.abs(vb.currentTime - t) > 1e-4) await seekAndWait(vb, () => { vb.currentTime = t; });
      }
    };
    /** Render the stage and copy the crop into the recording canvas. */
    const paint = () => {
      KL.selectedId = null;
      fns().renderFrame();
      rctx.drawImage(KL.canvas, Math.round(cx0 * dpr), Math.round(cy0 * dpr), rec.width, rec.height, 0, 0, rec.width, rec.height);
      if (track && typeof track.requestFrame === 'function') track.requestFrame();
    };

    const total = f1 - f0 + 1;
    let ok = false;
    try {
      await prepare(f0);
      recorder.start();
      paint(); // after start, so the first frame is not captured before the recorder listens
      // Recording clock (ms) = wall time minus time spent paused. Frame k is painted at recording
      // time recStart + k * P. Why schedule on this clock: timer lateness and pause/resume overhead
      // then shorten the next frame instead of adding up (measured: +8% duration without it).
      let pausedMs = 0;
      const recNow = () => performance.now() - pausedMs;
      const recStart = recNow();
      for (let n = f0 + 1; n <= f1 + 1 && !job.cancelled; n++) {
        setExportText(`Exporting ${Math.round((n - f0) / total * 100)}% · Cancel`);
        const last = n > f1;
        const ready = last ? Promise.resolve() : prepare(n);
        let isReady = false;
        ready.then(() => { isReady = true; });
        await sleep(recStart + (n - f0) * periodMs - recNow());
        if (!isReady) {
          // Late: freeze recording time until the next frame is decoded.
          const p0 = performance.now();
          if (recorder.state === 'recording') recorder.pause();
          await ready;
          if (recorder.state === 'paused') recorder.resume();
          pausedMs += performance.now() - p0;
        }
        if (last || job.cancelled) break;
        paint();
      }
      ok = !job.cancelled;
    } catch (err) {
      console.error('KineLab media export failed:', err);
    }
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
    track && track.stop();

    // Restore the frame and selection the user had.
    exportJob = null;
    // Why skip on a new clip: the saved time and selection belong to the clip that was replaced.
    if (!job.newClip) {
      KL.selectedId = savedSel;
      await seekAndWait(A, () => { A.currentTime = savedTime; });
    }
    syncB(true);
    fns().syncInspectorUI();
    fns().renderFrame();
    setExportText('Export video');

    if (!ok) { fns().showBanner(job.cancelled ? 'Video export cancelled.' : 'Video export failed.', true); return; }
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type: mime.split(';')[0] });
    // Name like the PNG export: <clip>_F<from>-F<to>[_<phase>-<phase>]_<speed>x
    const nameOf = (val) => { const bm = KL.bookmarks.find(b => b.id === val); return bm && bm.name ? bm.name.replace(/[^\w.-]+/g, '_') : null; };
    const p0 = nameOf($('mediaFrom').value), p1 = nameOf($('mediaTo').value);
    const phase = p0 || p1 ? `_${p0 || 'start'}-${p1 || 'end'}` : '';
    fns().downloadBlob(blob, `${fns().exportBaseName()}_F${f0}-F${f1}${phase}_${slow}x.${ext}`);
    fns().showBanner(`Exported ${total} frame(s) at ${slow}x (${ext.toUpperCase()}).`, false);
  }

  // ---- Session --------------------------------------------------------------------------------
  KL.session.media = {
    undoable: false,
    save() {
      if (mode === 'off' && offset === 0 && opacity === DEFAULT_OPACITY) return null;
      return { mode, opacity, offset };
    },
    load(json) {
      const j = json && typeof json === 'object' ? json : {};
      mode = MODES.includes(j.mode) ? j.mode : 'off';
      opacity = Number.isFinite(j.opacity) ? Math.max(0, Math.min(1, j.opacity)) : DEFAULT_OPACITY;
      offset = Number.isFinite(j.offset) ? Math.max(-MAX_OFFSET_S, Math.min(MAX_OFFSET_S, j.offset)) : 0;
      linked = true;
      applyView();
      syncB(true);
    }
  };

  KL.modules.media = { get offset() { return offset; }, get mode() { return mode; }, get hasClipB() { return bLoaded; } };

  syncRangeSelects();
  syncUI();
})();
