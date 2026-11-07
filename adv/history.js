/** adv/history.js - undo/redo history, per-clip autosave and "copy markups forward" (Advanced mode) */
(() => {
  // ==== Constants ==================================================================
  // Why 200: a frame-by-frame session (draw, nudge, bookmark, copy forward over 30+ frames)
  // runs to a few hundred edits; 200 covers a working session while bounding memory.
  const MAX_STEPS = 200;
  // Why a character budget too: tracking data can make one snapshot ~1 MB, and 200 of those
  // would hold ~400 MB (JS strings are UTF-16). 40 M chars ~ 80 MB is the most we keep.
  const MAX_HISTORY_CHARS = 40e6;
  const AUTOSAVE_DEBOUNCE_MS = 1000; // Why 1 s: saves soon after an edit, not on every 250 ms commit during a burst
  // Why 20 clips: localStorage holds ~5 MB per origin; 20 recent clips is plenty for a coach's
  // week and leaves room so one big clip does not starve the rest. Oldest is evicted first.
  const MAX_AUTOSAVE_CLIPS = 20;
  // Why 5,242,880 chars (5 Mi): the usual per-origin localStorage quota, counted over keys plus
  // values; measured 5,242,308 free chars in Chromium on an empty origin.
  const STORAGE_QUOTA_CHARS = 5 * 1024 * 1024;
  const STORE_PREFIX = 'kinelab.autosave.v1:';    // one key per clip
  const STORE_INDEX = 'kinelab.autosave.v1.index'; // [{ k, t }] clip key + saved-at ms, for eviction
  const STEP_CHOICES = [1, 2, 5, 10];               // copy-forward step sizes in frames
  const ID_RE = /^[\w-]{1,64}$/;
  const MAX_ITEMS = 5000;     // cap on restored markups (sanity bound for corrupted storage)
  const MAX_BOOKMARKS = 1000; // cap on restored bookmarks

  // ==== State ======================================================================
  let undoStack = [];   // snapshot strings, oldest first; last one is the state before the latest change
  let redoStack = [];
  let clipKey = null;   // autosave key of the open clip, null in demo mode
  let pendingSave = null; // { key, snap } waiting for the debounce timer
  let saveTimer = null;
  let offer = null;     // autosave entry offered for restore on this clip, or null
  let lastSavedAt = null;
  let saveError = false;
  let copyStep = 1;
  let idCounter = 0;
  let replaying = false; // true while restoreAndNotify emits its own 'change'

  const section = document.createElement('div');
  section.setAttribute('data-adv-section', 'history');
  section.style.cssText = 'display:flex; flex-direction:column; gap:8px';
  KL.panel.appendChild(section);

  // ==== Undo / redo ==================================================================

  /** Total characters held by both stacks (for the memory budget). */
  function historyChars() {
    let n = 0;
    for (const s of undoStack) n += s.length;
    for (const s of redoStack) n += s.length;
    return n;
  }

  /** Drop the oldest undo steps until both caps hold. */
  function trimHistory() {
    while (undoStack.length > MAX_STEPS) undoStack.shift();
    while (undoStack.length > 1 && historyChars() > MAX_HISTORY_CHARS) undoStack.shift();
  }

  /**
   * KL.restore a snapshot and tell other modules, without recording it as a new step.
   * Why emit 'change' by hand: KL.restore resets the commit baseline, so the poll never emits
   * for it, yet modules that rebuild bookmark lists on 'change' (media From/To, phases) would
   * otherwise keep showing bookmarks an undo just removed. `replaying` makes our own listener
   * skip it so the stacks are not touched.
   * @param {string} snap KL.snapshot() string
   * @returns {string} the snapshot after the restore
   */
  function restoreAndNotify(snap) {
    const prev = KL.snapshot();
    KL.restore(snap);
    const next = KL.snapshot();
    if (next !== prev) {
      replaying = true;
      KL.emit('change', { prev, next }); // KL.emit catches listener errors, so the flag always clears
      replaying = false;
    }
    return next;
  }

  function applySnapshot(snap) {
    scheduleAutosave(restoreAndNotify(snap));
  }

  /**
   * Step back one change. Returns true when Advanced mode handled the request.
   * @returns {boolean}
   */
  function undo() {
    if (!KL.advanced) return false;
    if (KL.dragging) return true;
    KL.commit(); // Why: an edit made in the last poll interval must be on the stack first
    if (!undoStack.length) return true;
    const target = undoStack.pop();
    redoStack.push(KL.snapshot());
    applySnapshot(target);
    renderSection();
    return true;
  }

  /** Re-apply the last undone change. */
  function redo() {
    if (!KL.advanced || KL.dragging) return;
    KL.commit();
    if (!redoStack.length) return;
    const target = redoStack.pop();
    undoStack.push(KL.snapshot());
    trimHistory();
    applySnapshot(target);
    renderSection();
  }

  KL.undoOverride = undo;

  KL.on('change', ({ prev, next }) => {
    if (replaying) return; // our own undo/redo/restore notification (see restoreAndNotify)
    undoStack.push(prev);
    redoStack = [];
    trimHistory();
    scheduleAutosave(next);
    renderSection();
  });

  KL.on('reset', () => {
    flushAutosave(); // the previous clip's last edit must reach storage before its key goes
    undoStack = [];
    redoStack = [];
    clipKey = null;
    offer = null;
    lastSavedAt = null;
    saveError = false;
    renderSection();
  });

  // ==== Autosave =====================================================================
  // Storage layout: STORE_PREFIX + clipKey -> { v, savedAt, name, snap, fpsOverride, markups, bookmarks }
  // and STORE_INDEX -> [{ k, t }] so eviction never has to parse every (possibly large) entry.

  function storeGet(k) {
    try { return localStorage.getItem(k); } catch (err) { return null; } // private mode / blocked storage
  }
  function storeRemove(k) {
    try { localStorage.removeItem(k); } catch (err) { /* blocked storage */ }
  }
  /** @returns {boolean} false when the write failed (quota, private mode) */
  function storeSet(k, v) {
    try { localStorage.setItem(k, v); return true; } catch (err) { return false; }
  }

  function readIndex() {
    try {
      const idx = JSON.parse(storeGet(STORE_INDEX) || '[]');
      return Array.isArray(idx) ? idx.filter(e => e && typeof e.k === 'string' && Number.isFinite(e.t)) : [];
    } catch (err) { return []; }
  }
  function writeIndex(idx) { storeSet(STORE_INDEX, JSON.stringify(idx)); }

  /**
   * Autosave key for a clip. Why name + duration + size: there is no file hash without reading
   * the whole file, and these three together tell re-opened clips apart in practice.
   */
  function keyFor(info) {
    const dur = Number.isFinite(info.duration) ? info.duration.toFixed(3) : '0';
    return `${String(info.name || '').slice(0, 200)}|${dur}|${info.width}x${info.height}`;
  }

  /** Current fps override (core script variable), or null. */
  function currentFpsOverride() {
    return typeof fpsOverride !== 'undefined' && Number.isFinite(fpsOverride) ? fpsOverride : null;
  }

  /** Number of markups and bookmarks in a snapshot string. */
  function countsOf(snap) {
    try {
      const s = JSON.parse(snap);
      // Why Array.isArray: stored data is untrusted and these counts go into button HTML; a
      // forged { length: '<img ...>' } must not reach it, so only real array lengths count.
      return {
        markups: Array.isArray(s.annotations) ? s.annotations.length : 0,
        bookmarks: Array.isArray(s.bookmarks) ? s.bookmarks.length : 0,
        extras: s.extras && typeof s.extras === 'object' ? s.extras : {}
      };
    } catch (err) { return { markups: 0, bookmarks: 0, extras: {} }; }
  }

  function scheduleAutosave(snap) {
    // Why advanced only: Basic mode must behave exactly as before, storage writes included.
    // Why never in demo mode: there is no clip to key the save to.
    if (!KL.advanced || !clipKey || !KL.hasVideo) return;
    pendingSave = { key: clipKey, snap };
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushAutosave, AUTOSAVE_DEBOUNCE_MS);
  }

  /** Write the pending autosave now (debounce fired, clip changing, or page closing). */
  function flushAutosave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!pendingSave) return;
    const { key, snap } = pendingSave;
    pendingSave = null;
    const c = countsOf(snap);
    const hasExtras = Object.values(c.extras).some(v => v != null);
    const fullIdx = readIndex();
    const prevRow = fullIdx.find(e => e.k === key) || null;
    let idx = fullIdx.filter(e => e.k !== key);
    if (!c.markups && !c.bookmarks && !hasExtras) {
      // Why keep it while offered: the fresh clip starts empty, and that must not wipe the
      // stored work the user has not yet chosen to restore or forget.
      if (offer) return;
      // Why delete rather than store an empty state: "Restore autosave (0 markups)" would be noise.
      storeRemove(STORE_PREFIX + key);
      writeIndex(idx);
      lastSavedAt = null;
      renderSection();
      return;
    }
    const now = Date.now();
    const entry = JSON.stringify({ v: 1, savedAt: now, name: key.split('|')[0], snap, fpsOverride: currentFpsOverride(), markups: c.markups, bookmarks: c.bookmarks });
    idx.push({ k: key, t: now });
    idx.sort((a, b) => a.t - b.t);
    while (idx.length > MAX_AUTOSAVE_CLIPS) storeRemove(STORE_PREFIX + idx.shift().k);
    let ok = storeSet(STORE_PREFIX + key, entry);
    // Why evict and retry: a full quota is usually other clips' old saves; this clip's latest
    // work matters more. Stop when only this clip is left, and never for an entry that cannot
    // fit even alone: that would wipe every other clip's autosave and still fail.
    const fitsAlone = entry.length + STORE_PREFIX.length + key.length < STORAGE_QUOTA_CHARS;
    while (!ok && fitsAlone && idx.length > 1) {
      storeRemove(STORE_PREFIX + idx.shift().k);
      ok = storeSet(STORE_PREFIX + key, entry);
    }
    if (!ok) {
      // Why keep an older entry's index row: a failed setItem leaves the previous value in
      // place, and without its row it could never be evicted.
      idx = idx.filter(e => e.k !== key);
      if (prevRow && storeGet(STORE_PREFIX + key) != null) { idx.push(prevRow); idx.sort((a, b) => a.t - b.t); }
    }
    writeIndex(idx);
    saveError = !ok;
    if (ok) lastSavedAt = now;
    renderSection();
  }

  /** Read and minimally check the stored entry for a clip key. */
  function readEntry(key) {
    try {
      const e = JSON.parse(storeGet(STORE_PREFIX + key) || 'null');
      if (!e || e.v !== 1 || typeof e.snap !== 'string' || !Number.isFinite(e.savedAt)) return null;
      const c = countsOf(e.snap); // integer counts only (see countsOf)
      return { savedAt: e.savedAt, snap: e.snap, fpsOverride: e.fpsOverride, markups: c.markups, bookmarks: c.bookmarks };
    } catch (err) { return null; }
  }

  /**
   * Validate a stored snapshot like a session file. Why: storage can be corrupted or written by
   * an older build, and labels/ids end up in sidebar HTML. Module extras are validated by each
   * module's own load(). Returns a clean snapshot string or null.
   */
  function cleanSnapshot(snap) {
    let s;
    try { s = JSON.parse(snap); } catch (err) { return null; }
    if (!s || !Array.isArray(s.annotations) || !Array.isArray(s.bookmarks)) return null;
    const dur = KL.video.duration || Infinity;
    const bms = s.bookmarks.slice(0, MAX_BOOKMARKS)
      .filter(b => b && ID_RE.test(String(b.id)) && Number.isFinite(b.time) && b.time >= 0 && b.time <= dur)
      .map(b => ({ id: String(b.id), name: String(b.name || '').slice(0, 60), time: b.time }))
      .sort((a, b) => a.time - b.time);
    const ids = new Set(bms.map(b => b.id));
    let seenScale = false;
    const anns = s.annotations.slice(0, MAX_ITEMS)
      .map(a => (typeof cleanAnnotation === 'function' ? cleanAnnotation(a, ids) : null))
      .filter(a => a && (a.type !== 'scale' || (!seenScale && (seenScale = true))));
    const extras = s.extras && typeof s.extras === 'object' ? s.extras : {};
    return JSON.stringify({ annotations: anns, bookmarks: bms, extras });
  }

  /** Restore the offered autosave as one undoable step. */
  function restoreAutosave() {
    if (!offer || !KL.hasVideo) return;
    const clean = cleanSnapshot(offer.snap);
    if (!clean) {
      // Why drop it: a damaged entry can never restore, so offering it again only misleads.
      offer = null;
      forgetAutosave();
      showBannerSafe('The autosave for this clip is damaged and was not restored.', true);
      return;
    }
    KL.commit();
    const before = KL.snapshot();
    // Why fps first: bookmarks are stored as times; their frame numbers depend on the rate.
    const o = Number(offer.fpsOverride);
    if (typeof applyFpsChange === 'function') applyFpsChange(() => { fpsOverride = o >= 1 && o <= 1000 ? o : null; });
    const after = restoreAndNotify(clean);
    // Why push by hand: restoreAndNotify's 'change' is skipped by our own listener.
    if (after !== before) { undoStack.push(before); redoStack = []; trimHistory(); }
    const c = countsOf(clean);
    offer = null;
    scheduleAutosave(after);
    showBannerSafe(`Restored autosave: ${c.markups} markup(s), ${c.bookmarks} bookmark(s).`, false);
    renderSection();
  }

  /** Delete this clip's stored autosave and drop the offer. */
  function forgetAutosave() {
    if (!clipKey) return;
    clearTimeout(saveTimer);
    pendingSave = null;
    storeRemove(STORE_PREFIX + clipKey);
    writeIndex(readIndex().filter(e => e.k !== clipKey));
    offer = null;
    lastSavedAt = null;
    renderSection();
  }

  function showBannerSafe(msg, isError) { KL.fns.showBanner(msg, isError); }

  /** "12 s ago", "5 min ago", "3 h ago", "2 days ago". */
  function relativeTime(t) {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 5) return 'just now'; // Why 5 s: "0 s ago" reads like a glitch
    if (s < 60) return `${s} s ago`;
    // Why floor: round turned 3570 s into "60 min ago" and 90 s into "2 min ago".
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    const d = Math.floor(s / 86400);
    return `${d} day${d === 1 ? '' : 's'} ago`;
  }

  KL.on('videoload', (info) => {
    clipKey = keyFor(info);
    // Why keep the offer in memory: once the user edits, the new work autosaves over the stored
    // entry, but the old one must stay restorable for this visit until they choose.
    offer = readEntry(clipKey);
    if (offer && KL.advanced) {
      showBannerSafe(`An autosave exists for this clip (${offer.markups} markups, ${offer.bookmarks} bookmarks). Restore it from History & autosave.`, false);
    }
    renderSection();
  });

  // Why: the last edit is still in the debounce window when the tab closes.
  window.addEventListener('pagehide', () => {
    if (KL.advanced && clipKey && KL.hasVideo) { KL.commit(); flushAutosave(); }
  });

  // ==== Copy markups forward =========================================================

  /** A fresh id no markup or bookmark uses yet. */
  function uniqueId(prefix) {
    const used = new Set([...KL.annotations.map(a => a.id), ...KL.bookmarks.map(b => b.id)]);
    let id;
    do { id = `${prefix}_${Date.now().toString(36)}_${(idCounter++).toString(36)}`; } while (used.has(id));
    return id;
  }

  /**
   * Copy the current phase's markups to the frame `copyStep` ahead and jump there.
   * Source: the active bookmark's markups; off a bookmark, the global markups (not the scale),
   * which are first bookmarked on this frame with the core Bookmark rule so the originals stay
   * on their own frame instead of showing on top of the copies.
   */
  function copyForward() {
    if (!KL.hasVideo) { showBannerSafe('Open a video first.', true); return; }
    if (KL.dragging) return;
    if (typeof abortFpsProbe === 'function') { abortFpsProbe(); KL.video.pause(); KL.fns.updatePlayIcon(); }
    let src = KL.fns.activeBookmark();
    if (!src) {
      const globals = KL.annotations.filter(a => a.bookmarkId == null && a.type !== 'scale');
      if (!globals.length) { showBannerSafe('Nothing to copy: draw markups on this frame first.', true); return; }
      bookmarkCurrentFrame(); // core: creates the bookmark and moves the globals into it
      src = KL.fns.activeBookmark();
      if (!src) return;
    }
    const items = KL.annotations.filter(a => a.bookmarkId === src.id);
    if (!items.length) { showBannerSafe(`Nothing to copy: "${src.name || 'this bookmark'}" has no markups.`, true); return; }

    const fps = KL.fns.getVideoFps();
    const from = KL.fns.bookmarkFrame(src);
    const last = KL.fns.totalFrames() - 1;
    const to = Math.min(last, from + copyStep);
    if (to <= from) { showBannerSafe('Already on the last frame; nothing ahead to copy to.', true); return; }

    let target = KL.bookmarks.find(b => KL.fns.bookmarkFrame(b) === to);
    if (!target) {
      // Name "<base> +N" where N is frames from the base phase: "Loading +1" -> "Loading +2".
      const m = /^(.*?)\s\+(\d+)$/.exec(src.name || '');
      const base = m ? m[1] : (src.name || `Frame ${from}`);
      const offset = (m ? Number(m[2]) : 0) + (to - from);
      // Why n / fps: a bookmark stores its frame's own start time (core convention).
      target = { id: uniqueId('bm'), name: `${base} +${offset}`.slice(0, 60), time: to / fps };
      KL.bookmarks.push(target);
      KL.bookmarks.sort((a, b) => a.time - b.time);
    }
    // Why: keep the user's selection on the matching copy, so they can nudge it straight away.
    const prevSel = KL.selectedId;
    let selCopy = null;
    for (const a of items) {
      const copy = JSON.parse(JSON.stringify(a)); // deep copy: points are nested objects
      copy.id = uniqueId('cp');
      copy.bookmarkId = target.id;
      KL.annotations.push(copy);
      if (a.id === prevSel) selCopy = copy.id;
    }
    if (!selCopy) selCopy = KL.annotations[KL.annotations.length - 1].id;
    KL.fns.jumpToBookmark(target.id);
    KL.selectedId = selCopy;
    KL.fns.syncBookmarkUI(true);
    KL.fns.updateScrubberUI();
    KL.fns.syncInspectorUI();
    KL.fns.renderFrame();
    KL.commit(); // one undo step for the whole copy
    showBannerSafe(`Copied ${items.length} markup(s) to frame ${to} ("${target.name}"). Drag the points to fit.`, false);
  }

  // ==== Sidebar section, keyboard, session ===========================================

  const ICON = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const UNDO_ICON = ICON('<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>');
  const REDO_ICON = ICON('<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>');
  const COPY_ICON = ICON('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>');
  // Why these inline styles: the restore label is long and action-btn is nowrap/40 px; it must wrap.
  const WRAP_BTN = 'width:100%; height:auto; min-height:40px; padding:8px 13px; white-space:normal; line-height:1.35';

  function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

  function setEnabled(btn, on) {
    btn.disabled = !on;
    btn.style.opacity = on ? '' : '0.4'; // Why 0.4: clearly inactive but still legible
  }

  /** Re-render the History & autosave section from current state. */
  function renderSection() {
    const esc = KL.fns.escapeHtml;
    let autosaveVal;
    if (!clipKey) autosaveVal = 'Off (no video)';
    else if (saveError) autosaveVal = 'Storage full';
    else if (lastSavedAt) autosaveVal = `Saved ${relativeTime(lastSavedAt)}`;
    else autosaveVal = 'On';
    const offerHtml = offer ? `
      <button type="button" class="action-btn primary" data-h="restore" style="${WRAP_BTN}">Restore autosave (${plural(offer.markups, 'markup')}, ${plural(offer.bookmarks, 'bookmark')}, saved ${esc(relativeTime(offer.savedAt))})</button>` : '';
    const forgetHtml = clipKey && (offer || lastSavedAt) ? `
      <button type="button" class="action-btn danger" data-h="forget" style="width:100%">Forget autosave</button>` : '';
    section.innerHTML = `
      <div class="section-label">History &amp; autosave</div>
      <div class="modal-actions">
        <button type="button" class="action-btn" data-h="undo" title="Undo (Cmd/Ctrl+Z)">${UNDO_ICON}<span>Undo</span></button>
        <button type="button" class="action-btn" data-h="redo" title="Redo (Shift+Cmd/Ctrl+Z or Ctrl+Y)">${REDO_ICON}<span>Redo</span></button>
      </div>
      <div class="measure-list">
        <div class="measure-item" style="cursor:default">
          <div class="measure-left"><span class="measure-dot" style="background:var(--ios-blue)"></span><span class="measure-name">History</span></div>
          <div class="measure-right"><span class="measure-val">${undoStack.length} undo · ${redoStack.length} redo</span></div>
        </div>
        <div class="measure-item" style="cursor:default">
          <div class="measure-left"><span class="measure-dot" style="background:${saveError ? 'var(--ios-red)' : 'var(--ios-green)'}"></span><span class="measure-name">Autosave</span></div>
          <div class="measure-right"><span class="measure-val">${esc(autosaveVal)}</span></div>
        </div>
      </div>${offerHtml}${forgetHtml}
      <div class="unit-pills" title="Frames ahead to copy to">
        ${STEP_CHOICES.map(n => `<button type="button" class="unit-btn ${n === copyStep ? 'active' : ''}" data-step="${n}" style="flex:1" title="Copy ${n} frame${n === 1 ? '' : 's'} ahead">${n}</button>`).join('')}
      </div>
      <button type="button" class="action-btn" data-h="copy" style="width:100%" title="Copy this phase's markups forward (C)">${COPY_ICON}<span>${copyStep === 1 ? 'Copy to next frame' : `Copy to frame +${copyStep}`}</span></button>`;
    setEnabled(section.querySelector('[data-h="undo"]'), undoStack.length > 0);
    setEnabled(section.querySelector('[data-h="redo"]'), redoStack.length > 0);
  }

  section.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || btn.disabled) return;
    const h = btn.dataset.h;
    if (h === 'undo') undo();
    else if (h === 'redo') redo();
    else if (h === 'restore') restoreAutosave();
    else if (h === 'forget') forgetAutosave();
    else if (h === 'copy') copyForward();
    else if (btn.dataset.step) { copyStep = Number(btn.dataset.step); renderSection(); }
  });

  window.addEventListener('keydown', (e) => {
    if (!KL.advanced || KL.isTextEntry(document.activeElement)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey && e.code === 'KeyZ') {
      e.preventDefault();
      if (e.shiftKey) redo();
      // Why via the core undoLast: it first drops a half-placed angle point, then calls undoOverride.
      else if (typeof undoLast === 'function') undoLast();
      else undo();
    } else if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.code === 'KeyY') {
      e.preventDefault();
      redo();
    } else if (!mod && !e.altKey && !e.shiftKey && !e.repeat && e.code === 'KeyC') {
      // Why ignore auto-repeat: holding C would stamp a new bookmark on every repeat (~30/s).
      e.preventDefault();
      copyForward();
    }
  });

  // Why refresh on mode switch: autosave is Advanced-only, and relative times go stale while hidden.
  KL.on('advanced', ({ on }) => {
    if (on && clipKey && KL.hasVideo) scheduleAutosave(KL.snapshot());
    renderSection();
  });

  // Why undoable false and no data: history and autosave are per-browser state, not analysis data.
  KL.session.history = { save: () => null, load: () => {}, undoable: false };

  // Exposed for other modules (e.g. to group their own edits) and for tests.
  KL.modules.history = {
    undo, redo, copyForward,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    clipKey: () => clipKey
  };

  // Why 30 s: keeps "saved N min ago" honest without re-rendering the section constantly.
  const RELATIVE_TIME_REFRESH_MS = 30000;
  setInterval(() => { if (KL.advanced && (lastSavedAt || offer)) renderSection(); }, RELATIVE_TIME_REFRESH_MS);

  renderSection();
})();
