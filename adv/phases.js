/** adv/phases.js - bookmark-based phase tools: jump height from flight time, notes per bookmark, A-B loop */
(() => {
  const KL = window.KL;
  const fns = KL.fns;

  // ---- Constants ---------------------------------------------------------------------------
  const G = 9.81;              // m/s^2, standard gravity used by the flight-time jump method
  const NOTE_MAX = 2000;       // Characters per bookmark note (spec cap; keeps session files small)
  const NOTES_MAX_COUNT = 500; // Cap on notes read from a session file; far above any real bookmark count
  const ID_RE = /^[\w-]{1,64}$/; // Same id rule the core uses for bookmarks and markups

  // ---- State -------------------------------------------------------------------------------
  // sel holds the user's explicit choices (bookmark ids, or null = none chosen); the selection in
  // effect is pick(key), which falls back to the name default.
  // Why keep defaults out of sel: sel is undoable session state, so writing a default into it
  // from the 'change' handler recorded a phantom undo step that undo could never revert.
  let sel = { takeoff: null, landing: null, loopStart: null, loopEnd: null };
  // Why a null prototype: '__proto__' is a valid bookmark id, and on a plain object assigning
  // notes['__proto__'] would silently drop the note instead of storing it.
  let notes = Object.create(null); // { [bookmarkId]: text }
  let looping = false;
  let loopRaf = 0;
  let noteBmId = undefined; // bookmark whose note the textarea is bound to (null = disabled)

  // ---- UI ----------------------------------------------------------------------------------
  const section = document.createElement('div');
  section.dataset.advSection = 'phases';
  const muted = 'color:var(--text-muted); font-size:11px; line-height:1.4';
  section.innerHTML = `
    <div class="section-label">Phases</div>
    <div style="display:flex; flex-direction:column; gap:8px">
      <div style="${muted}">Take-off and landing bookmarks</div>
      <div class="modal-actions">
        <select id="phTakeoffSel" class="text-input" title="Take-off bookmark (last ground contact)"></select>
        <select id="phLandingSel" class="text-input" title="Landing bookmark (first ground contact)"></select>
      </div>
      <div class="inspector-card">
        <div class="readout-header">
          <div id="phJumpValue" class="readout-value">--</div>
          <span id="phJumpBadge" class="readout-badge">Jump height</span>
        </div>
        <div id="phJumpDetail" style="${muted}">Pick a take-off and a landing bookmark.</div>
      </div>
      <div style="${muted}">Flight-time method: assumes the same body posture at take-off and landing. Slowed-down clips need the real fps set.</div>
      <textarea id="phNoteInput" class="text-input" style="height:70px; resize:vertical; padding:8px 11px; line-height:1.4; font-family:inherit" maxlength="${NOTE_MAX}" disabled placeholder="Step to a bookmarked frame to add notes"></textarea>
      <div style="${muted}">Loop between bookmarks</div>
      <div class="modal-actions">
        <select id="phLoopStartSel" class="text-input" title="Loop start bookmark"></select>
        <select id="phLoopEndSel" class="text-input" title="Loop end bookmark"></select>
      </div>
      <button type="button" id="phLoopBtn" class="action-btn" title="Play between the two bookmarks repeatedly (L)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/></svg>
        <span id="phLoopBtnText">Loop</span>
      </button>
    </div>`;
  KL.panel.appendChild(section);

  const $ = id => document.getElementById(id);
  const selects = { takeoff: $('phTakeoffSel'), landing: $('phLandingSel'), loopStart: $('phLoopStartSel'), loopEnd: $('phLoopEndSel') };
  const placeholders = { takeoff: 'Take-off…', landing: 'Landing…', loopStart: 'Loop from…', loopEnd: 'Loop to…' };
  const noteInput = $('phNoteInput');

  const bmById = id => (id ? KL.bookmarks.find(b => b.id === id) || null : null);
  const bmName = bm => (bm.name || 'Unnamed');

  /**
   * Default take-off / landing: first bookmark whose name mentions take-off / landing.
   * Why "take" or "off": coaches write "Take-off", "Takeoff", "Toe off".
   */
  function defaultFor(key) {
    const bms = KL.bookmarks;
    if (key === 'takeoff') { const b = bms.find(x => /take|off/i.test(x.name || '')); return b ? b.id : null; }
    if (key === 'landing') { const b = bms.find(x => /land/i.test(x.name || '')); return b ? b.id : null; }
    return null;
  }

  /** Bookmark id in effect for a select: the user's choice, else the name default, else null. */
  function pick(key) {
    return bmById(sel[key]) ? sel[key] : defaultFor(key);
  }

  /** Drop selections whose bookmark is gone (falling back to the name default) and rebuild the selects. */
  function syncSelects() {
    for (const key of Object.keys(sel)) {
      // Why this cannot add an undo step: save() already omits ids of deleted bookmarks.
      if (sel[key] && !bmById(sel[key])) sel[key] = null;
      const el = selects[key];
      const html = `<option value="">${placeholders[key]}</option>` + KL.bookmarks.map(b =>
        `<option value="${fns.escapeHtml(b.id)}">F${fns.bookmarkFrame(b)} · ${fns.escapeHtml(bmName(b))}</option>`).join('');
      // Why frame first: narrow selects clip the end of the text, and the frame tells phases apart.
      // Why compare first: rebuilding an open <select> while the user is choosing closes it.
      if (el.dataset.phKey !== html) { el.innerHTML = html; el.dataset.phKey = html; }
      el.value = pick(key) || '';
    }
    if (looping && (!pick('loopStart') || !pick('loopEnd'))) stopLoop();
  }

  for (const [key, el] of Object.entries(selects)) {
    el.addEventListener('change', () => {
      sel[key] = el.value || null;
      if ((key === 'loopStart' || key === 'loopEnd') && looping) startLoop(); // restart on the new range
      refreshJump();
    });
  }

  // ---- (1) Jump height from flight time ----------------------------------------------------

  /**
   * Flight time and jump height between the selected bookmarks.
   * t [s] = landing.time - takeoff.time (bookmark times are frame timestamps n / fps).
   * h [m] = g * t^2 / 8: the body rises for t/2 and h = 1/2 * g * (t/2)^2.
   * @returns {{ok: true, t: number, frames: number, hCm: number, takeoff, landing} | {ok: false, msg: string}}
   */
  function computeJump() {
    const takeoff = bmById(pick('takeoff')), landing = bmById(pick('landing'));
    if (!takeoff || !landing) return { ok: false, msg: 'Pick a take-off and a landing bookmark.' };
    if (takeoff.id === landing.id) return { ok: false, msg: 'Take-off and landing must be different bookmarks.' };
    const t = landing.time - takeoff.time;
    if (!(t > 0)) return { ok: false, msg: 'Landing is before take-off: flight time must be positive.' };
    const frames = fns.bookmarkFrame(landing) - fns.bookmarkFrame(takeoff);
    const hCm = G * t * t / 8 * 100; // m -> cm
    return { ok: true, t, frames, hCm, takeoff, landing };
  }

  function refreshJump() {
    const r = computeJump();
    const value = $('phJumpValue'), detail = $('phJumpDetail');
    if (!r.ok) {
      value.textContent = '--';
      detail.textContent = r.msg;
      // Why red only for a wrong order: an empty pick is not an error, just unfinished.
      detail.style.color = /before|different/.test(r.msg) ? 'var(--ios-red)' : 'var(--text-muted)';
      return;
    }
    value.textContent = `${r.hCm.toFixed(1)} cm`;
    detail.textContent = `Flight ${(r.t * 1000).toFixed(0)} ms · ${r.frames} frame${r.frames === 1 ? '' : 's'} at ${fns.getVideoFps()} fps`;
    detail.style.color = 'var(--text-muted)';
  }

  // ---- (2) Notes per bookmark --------------------------------------------------------------

  /** Bind the textarea to the active bookmark's note (or disable it off-bookmark). */
  function syncNoteInput(force) {
    // Why stay bound while focused: the user is typing, and playback or a loop can move off the
    // bookmark meanwhile; rebinding then would move the caret and send keystrokes to another note.
    if (!force && document.activeElement === noteInput) return;
    const bm = fns.activeBookmark();
    const id = bm ? bm.id : null;
    if (!force && id === noteBmId) return;
    noteBmId = id;
    noteInput.disabled = !bm;
    noteInput.placeholder = bm ? `Notes for ${bmName(bm)}` : 'Step to a bookmarked frame to add notes';
    noteInput.value = bm ? (notes[bm.id] || '') : '';
  }

  noteInput.addEventListener('input', () => {
    // Why the bound id, not activeBookmark(): the frame may have changed since typing began.
    if (!noteBmId || !bmById(noteBmId)) return;
    const text = noteInput.value.slice(0, NOTE_MAX);
    if (text) notes[noteBmId] = text; else delete notes[noteBmId];
  });

  /** Remove notes whose bookmark was deleted. */
  function pruneNotes() {
    const ids = new Set(KL.bookmarks.map(b => b.id));
    for (const id of Object.keys(notes)) if (!ids.has(id)) delete notes[id];
  }

  // ---- (3) Loop between two bookmarks ------------------------------------------------------

  function updateLoopBtn() {
    $('phLoopBtn').classList.toggle('active-toggle', looping);
    $('phLoopBtnText').textContent = looping ? 'Looping' : 'Loop';
  }

  /** Seek to the loop start and play at the current playback rate. */
  function startLoop() {
    const a = bmById(pick('loopStart')), b = bmById(pick('loopEnd'));
    // Why stopLoop on every refusal: a range edited mid-loop to end <= start would otherwise keep
    // the watcher running and seek back to the start on every animation frame.
    const refuse = msg => { stopLoop(); fns.showBanner(msg, true); };
    if (!KL.hasVideo) { refuse('Open a video first.'); return; }
    if (!a || !b) { refuse('Pick a loop start and end bookmark.'); return; }
    const startF = fns.bookmarkFrame(a), endF = fns.bookmarkFrame(b);
    if (endF <= startF) { refuse('The loop end bookmark must come after the start.'); return; }
    // Why: a running fps probe would pause and rewind to frame 0 when it finishes (core global).
    if (typeof abortFpsProbe === 'function') abortFpsProbe();
    looping = true;
    updateLoopBtn();
    restartFromStart();
    cancelAnimationFrame(loopRaf);
    loopRaf = requestAnimationFrame(watchLoop);
  }

  /** Seek to the loop start frame and play; stops the loop if the start bookmark is gone. */
  function restartFromStart() {
    const a = bmById(pick('loopStart'));
    if (!a) { stopLoop(); return; }
    fns.seekToFrame(fns.bookmarkFrame(a));
    const p = KL.video.play();
    if (p && p.catch) p.catch(() => stopLoop());
    fns.updatePlayIcon();
  }

  /**
   * Per animation frame: once playback passes the end of the end bookmark's frame, jump back.
   * Why (endF + 1) / fps: frame endF is on screen from endF/fps until (endF+1)/fps, so the end
   * frame is shown for its full duration before the loop restarts.
   */
  function watchLoop() {
    if (!looping) return;
    const b = bmById(pick('loopEnd'));
    if (!b) { stopLoop(); return; }
    const fps = fns.getVideoFps();
    const v = KL.video;
    const endTime = (fns.bookmarkFrame(b) + 1) / fps;
    if (!v.paused && !v.seeking && v.currentTime >= endTime) restartFromStart();
    loopRaf = requestAnimationFrame(watchLoop);
  }

  function stopLoop() {
    if (!looping) return;
    looping = false;
    cancelAnimationFrame(loopRaf);
    updateLoopBtn();
  }

  function toggleLoop() { if (looping) { stopLoop(); KL.video.pause(); fns.updatePlayIcon(); } else startLoop(); }
  $('phLoopBtn').addEventListener('click', toggleLoop);

  // Why the pause event: Space, ±1F steps, scrubbing and bookmark jumps all pause the video
  // first, so one listener stops the loop for every user transport action.
  KL.video.addEventListener('pause', () => {
    if (!looping) return;
    // Why: an end bookmark on the last frame lets the clip run out, which pauses; keep looping.
    if (KL.video.ended) { restartFromStart(); return; }
    stopLoop();
  });

  window.addEventListener('keydown', e => {
    if (!KL.advanced || KL.isTextEntry(document.activeElement)) return;
    // Why ignore auto-repeat: holding L would otherwise flicker the loop on and off.
    if (e.code === 'KeyL' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat) { e.preventDefault(); toggleLoop(); }
  });

  // ---- Wiring ------------------------------------------------------------------------------

  function refreshAll() {
    syncSelects();
    refreshJump();
    syncNoteInput(false);
  }

  // Why 'change': bookmarks are added, renamed and deleted by the core with no dedicated event,
  // but every such edit changes the polled snapshot.
  KL.on('change', () => { pruneNotes(); refreshAll(); });
  KL.on('frame', () => syncNoteInput(false));
  KL.video.addEventListener('timeupdate', () => syncNoteInput(false)); // playback passes bookmarks without seeks
  noteInput.addEventListener('blur', () => syncNoteInput(true));
  KL.on('advanced', ({ on }) => { if (!on) stopLoop(); refreshAll(); });
  KL.on('reset', () => {
    stopLoop();
    sel = { takeoff: null, landing: null, loopStart: null, loopEnd: null };
    notes = Object.create(null);
    refreshAll();
    syncNoteInput(true);
  });

  // Jump height and notes in the measurements CSV (10 core columns).
  KL.on('csv', ({ rows }) => {
    const r = computeJump();
    // Why only in Advanced: the name defaults would otherwise add a jump row to a Basic-mode
    // export the user never asked for. Notes are user-typed data, so they are always exported.
    if (r.ok && KL.advanced) {
      rows.push([`${bmName(r.takeoff)} → ${bmName(r.landing)}`, fns.bookmarkFrame(r.takeoff), r.takeoff.time.toFixed(3), '',
        'Jump height', 'jump', r.hCm.toFixed(1), 'cm', '',
        `flight ${(r.t * 1000).toFixed(0)} ms (${r.frames} frames); take-off: ${bmName(r.takeoff)}; landing: ${bmName(r.landing)}`]);
    }
    for (const bm of KL.bookmarks) {
      if (notes[bm.id]) rows.push([bmName(bm), fns.bookmarkFrame(bm), bm.time.toFixed(3), '', 'Note', 'note', '', '', '', notes[bm.id]]);
    }
  });

  // ---- Session -----------------------------------------------------------------------------
  KL.session.phases = {
    undoable: true,
    /** Selections and notes; notes of deleted bookmarks are never written. */
    save() {
      const ids = new Set(KL.bookmarks.map(b => b.id));
      const kept = Object.create(null); // Why: same __proto__-safe map as notes
      for (const [id, text] of Object.entries(notes)) if (ids.has(id) && text) kept[id] = text;
      const s = {};
      for (const k of Object.keys(sel)) if (sel[k] && ids.has(sel[k])) s[k] = sel[k];
      if (!Object.keys(kept).length && !Object.keys(s).length) return null;
      return { sel: s, notes: kept };
    },
    /** Untrusted input: ids must match a loaded bookmark, notes are strings capped at NOTE_MAX. */
    load(json, ctx) {
      const ids = ctx && ctx.bookmarkIds instanceof Set ? ctx.bookmarkIds : new Set();
      stopLoop();
      sel = { takeoff: null, landing: null, loopStart: null, loopEnd: null };
      notes = Object.create(null);
      if (json && typeof json === 'object') {
        const s = json.sel && typeof json.sel === 'object' ? json.sel : {};
        for (const k of Object.keys(sel)) {
          const v = s[k];
          if (typeof v === 'string' && ID_RE.test(v) && ids.has(v)) sel[k] = v;
        }
        const n = json.notes && typeof json.notes === 'object' && !Array.isArray(json.notes) ? json.notes : {};
        for (const [id, text] of Object.entries(n).slice(0, NOTES_MAX_COUNT)) {
          if (ID_RE.test(id) && ids.has(id) && typeof text === 'string' && text) notes[id] = text.slice(0, NOTE_MAX);
        }
      }
      // The core has already installed the loaded bookmark list when it calls load.
      refreshAll();
      syncNoteInput(true);
    }
  };

  KL.modules.phases = { computeJump, isLooping: () => looping, getNote: id => notes[id] || '' };

  refreshAll();
})();
