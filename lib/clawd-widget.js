// Clawd widget — floating animated crab.
//
// One widget per window. Each column owns its own animation, driven by the
// renderer from the real session JSONL (tool_use / thinking / text / user
// turns). Switching focused column cross-fades the widget to that column's
// current animation.
//
// SVGs live in assets/clawd/. Sourced from marciogranzotto/clawd-tank (MIT).
// To pull upstream changes see docs/CLAWD_UPSTREAM.md.

(function () {
  'use strict';

  const ASSETS = './assets/clawd/';

  // Animation registry. Keys mirror clawd-tank's animation names where
  // possible so the state machine port stays straightforward.
  const ANIMATIONS = [
    { id: 'idle',         file: 'clawd-idle-living.svg',         label: 'Idle' },
    { id: 'typing',       file: 'clawd-working-typing.svg',      label: 'Typing (Edit/Write)' },
    { id: 'debugger',     file: 'clawd-working-debugger.svg',    label: 'Debugger (Read/Grep)' },
    { id: 'building',     file: 'clawd-working-building.svg',    label: 'Building (Bash)' },
    { id: 'wizard',       file: 'clawd-working-wizard.svg',      label: 'Wizard (WebSearch)' },
    { id: 'conducting',   file: 'clawd-working-conducting.svg',  label: 'Conducting (Agent)' },
    { id: 'beacon',       file: 'clawd-working-beacon.svg',      label: 'Beacon (MCP/LSP)' },
    { id: 'thinking',     file: 'clawd-working-thinking.svg',    label: 'Thinking' },
    { id: 'confused',     file: 'clawd-working-confused.svg',    label: 'Confused' },
    { id: 'sweeping',     file: 'clawd-working-sweeping.svg',    label: 'Sweeping (compact)' },
    { id: 'happy',        file: 'clawd-happy.svg',               label: 'Happy' },
    { id: 'eureka',       file: 'clawd-eureka.svg',              label: 'Eureka' },
    { id: 'notification', file: 'clawd-notification.svg',        label: 'Notification' },
    { id: 'grooving',     file: 'clawd-grooving.svg',            label: 'Grooving' },
    { id: 'sleeping',     file: 'clawd-sleeping.svg',            label: 'Sleeping' },
    { id: 'wake',         file: 'clawd-wake.svg',                label: 'Wake' },
    { id: 'dizzy',        file: 'clawd-dizzy.svg',               label: 'Dizzy' },
    { id: 'going-away',   file: 'clawd-going-away.svg',          label: 'Going away' },
    { id: 'crab-walking', file: 'clawd-crab-walking.svg',        label: 'Walking' },
    { id: 'overheated',   file: 'clawd-working-overheated.svg',  label: 'Overheated' },
    { id: 'carrying',     file: 'clawd-working-carrying.svg',    label: 'Carrying' },
    { id: 'pushing',      file: 'clawd-working-pushing.svg',     label: 'Pushing' },
    { id: 'juggling',     file: 'clawd-working-juggling.svg',    label: 'Juggling' },
    { id: 'builder',      file: 'clawd-working-builder.svg',     label: 'Builder' },
    { id: 'hat-mishap',   file: 'clawd-hat-mishap.svg',          label: 'Hat mishap' },
    { id: 'low-battery',  file: 'clawd-idle-low-battery.svg',    label: 'Low battery' },
    { id: 'disconnected', file: 'clawd-disconnected.svg',        label: 'Disconnected' },
  ];

  const ANIM_BY_ID = ANIMATIONS.reduce((m, a) => { m[a.id] = a; return m; }, {});

  const LS_ENABLED = 'clawd.enabled';
  const LS_POS = 'clawd.pos';
  const LS_SIZE = 'clawd.size';
  const LS_DEBUG = 'clawd.debug';
  const LS_DEBUG_POS = 'clawd.debug.pos';
  const SIZE_DEFAULT = 180;
  const SIZE_MIN = 60;
  const SIZE_MAX = 480;
  const DEBUG_BUFFER = 80;

  let widgetEl = null;
  let imgEl = null;
  let bubbleEl = null;
  let debugEl = null;
  let debugLogEl = null;
  let debugNowEl = null;
  let currentAnimId = null;
  let currentSizePx = SIZE_DEFAULT;
  let bubbleTimer = null;
  const debugRing = [];   // newest last
  let debugEnabled = false;

  // Per-column animation assignments, driven by the renderer from session
  // JSONL activity. Defaults to 'idle' until the real state is known.
  const colAnim = new Map();      // columnId -> committed animId
  const colCommitAt = new Map();  // columnId -> ts of last committed change
  const colPending = new Map();   // columnId -> { animId, timer }
  const colSleepTimer = new Map(); // columnId -> Timeout (idle → sleeping)
  let focusedColId = null;

  // After this long parked on plain 'idle', flip the column to 'sleeping' so
  // long-quiet columns don't look frozen mid-yawn.
  const IDLE_TO_SLEEP_MS = 10 * 60 * 1000;

  // Per-animation category — used to decide whether a state change is a
  // meaningful transition (different category → snap immediately) or a same-
  // category tool flicker (Read → Edit → Read → respect the hold to keep
  // the widget from bouncing).
  const ANIM_CATEGORY = {
    idle: 'idle', sleeping: 'idle', disconnected: 'idle', 'going-away': 'idle',
    thinking: 'thinking',
    typing: 'work', debugger: 'work', building: 'work', wizard: 'work',
    conducting: 'work', beacon: 'work', sweeping: 'work', overheated: 'work',
    carrying: 'work', pushing: 'work', juggling: 'work', builder: 'work',
    confused: 'attention', 'low-battery': 'attention', 'hat-mishap': 'attention',
    dizzy: 'moment', happy: 'moment', eureka: 'moment',
    notification: 'moment', wake: 'moment', grooving: 'moment',
    'crab-walking': 'work',
  };
  function animCategory(id) { return ANIM_CATEGORY[id] || 'work'; }

  // Same-category transitions stay on screen this long to absorb rapid
  // tool-call flicker (e.g. Read → Edit → Read). Cross-category transitions
  // (e.g. thinking → working, working → idle) skip the hold so the widget
  // responds the instant a real state change happens.
  const MIN_ANIM_HOLD_MS = 1000;

  // When parked on the same primary animation for a while, rotate through
  // visual variants so long Bash sequences don't feel frozen. Kept tight:
  // only the building pool rotates (Bash is by far the most-parked state),
  // and only between visually-related siblings so the widget never looks
  // like it's resting/struggling while Claude is actively working.
  //
  // Variants previously included `overheated`, `pushing`, `juggling`,
  // `carrying`, `crab-walking` — those read as "Clawd is tired / fell over"
  // when glanced at and made the widget feel disconnected from real state.
  const VARIANT_INITIAL_MS = 8000;
  const VARIANT_INTERVAL_MS = 12000;
  const VARIANT_POOLS = {
    building: ['building', 'builder'],
    // All other primaries stay on a single animation — predictable beats
    // varied here.
  };
  let variantTimer = null;
  let variantPrimary = null;
  let variantIdx = 0;

  function loadBool(key, dflt) {
    try {
      const v = window.localStorage.getItem(key);
      if (v === null) return dflt;
      return v === '1';
    } catch (_) { return dflt; }
  }
  function saveBool(key, val) {
    try { window.localStorage.setItem(key, val ? '1' : '0'); } catch (_) {}
  }
  function loadInt(key, dflt) {
    try {
      const v = window.localStorage.getItem(key);
      if (v === null) return dflt;
      const n = parseInt(v, 10);
      return isNaN(n) ? dflt : n;
    } catch (_) { return dflt; }
  }
  function saveInt(key, val) {
    try { window.localStorage.setItem(key, String(val)); } catch (_) {}
  }
  function loadPos() {
    try {
      const raw = window.localStorage.getItem(LS_POS);
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (typeof p.right === 'number' && typeof p.bottom === 'number') return p;
    } catch (_) {}
    return null;
  }
  function savePos(p) {
    try { window.localStorage.setItem(LS_POS, JSON.stringify(p)); } catch (_) {}
  }

  function applySize(px) {
    if (!widgetEl) return;
    const clamped = Math.max(SIZE_MIN, Math.min(SIZE_MAX, px | 0));
    currentSizePx = clamped;
    widgetEl.style.setProperty('--clawd-size', clamped + 'px');
  }

  function stopVariantRotation() {
    if (variantTimer) { clearTimeout(variantTimer); variantTimer = null; }
    variantPrimary = null;
    variantIdx = 0;
  }

  // Kick off (or restart) variant rotation for the given primary animation.
  // First tick is delayed by VARIANT_INITIAL_MS to let quick tool calls
  // settle without ever showing a variant.
  function startVariantRotation(primary) {
    stopVariantRotation();
    const pool = VARIANT_POOLS[primary];
    if (!pool || pool.length < 2) return;
    variantPrimary = primary;
    variantIdx = 0;
    const tick = () => {
      if (!variantPrimary) return;
      variantIdx = (variantIdx + 1) % pool.length;
      // Use setAnimation directly so this doesn't mess with column state or
      // trigger debug-log noise — the column's committed animation stays the
      // primary; only the visible image rotates.
      setAnimation(pool[variantIdx]);
      variantTimer = setTimeout(tick, VARIANT_INTERVAL_MS);
    };
    variantTimer = setTimeout(tick, VARIANT_INITIAL_MS);
  }

  function setAnimation(id) {
    const anim = ANIM_BY_ID[id] || ANIM_BY_ID.idle;
    if (!anim || !imgEl) return;
    if (currentAnimId === anim.id) return;
    currentAnimId = anim.id;
    imgEl.classList.add('fading');
    setTimeout(() => {
      imgEl.src = ASSETS + anim.file;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        imgEl.classList.remove('fading');
      }));
    }, 80);
  }

  function showBubble(text, durationMs = 1800) {
    if (!bubbleEl) return;
    bubbleEl.textContent = text;
    bubbleEl.classList.remove('hidden');
    if (bubbleTimer) clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubbleEl.classList.add('hidden'), durationMs);
  }

  function ensureColAnim(colId) {
    if (colId === null || colId === undefined) return null;
    if (!colAnim.has(colId)) colAnim.set(colId, 'idle');
    return colAnim.get(colId);
  }

  function setFocusedColumn(colId) {
    focusedColId = colId;
    if (widgetEl && widgetEl.classList.contains('hidden')) {
      stopVariantRotation();
      return;
    }
    const animId = ensureColAnim(colId) || 'idle';
    setAnimation(animId);
    startVariantRotation(animId);
    if (debugEnabled) renderDebugNow();
  }

  function clearSleepTimer(colId) {
    const t = colSleepTimer.get(colId);
    if (t) { clearTimeout(t); colSleepTimer.delete(colId); }
  }

  function armSleepTimer(colId) {
    clearSleepTimer(colId);
    const timer = setTimeout(() => {
      colSleepTimer.delete(colId);
      if (colAnim.get(colId) === 'idle') commitColumnAnimation(colId, 'sleeping');
    }, IDLE_TO_SLEEP_MS);
    colSleepTimer.set(colId, timer);
  }

  function commitColumnAnimation(colId, animId) {
    colAnim.set(colId, animId);
    colCommitAt.set(colId, Date.now());
    if (colId === focusedColId) {
      setAnimation(animId);
      startVariantRotation(animId);
    }
    clearSleepTimer(colId);
    if (animId === 'idle') armSleepTimer(colId);
    pushDebug('set', { col: colId, anim: animId });
    renderDebugNow();
  }

  function setColumnAnimation(colId, animId) {
    if (colId === null || colId === undefined) return;
    if (!ANIM_BY_ID[animId]) {
      pushDebug('set', { col: colId, anim: animId, skipped: 'unknown-anim' });
      return;
    }

    const current = colAnim.get(colId);
    if (current === animId) {
      // Already on this animation — cancel any pending change that would
      // have flipped away from it.
      const p = colPending.get(colId);
      if (p) { clearTimeout(p.timer); colPending.delete(colId); }
      pushDebug('set', { col: colId, anim: animId, skipped: 'same' });
      return;
    }

    const lastAt = colCommitAt.get(colId) || 0;
    const elapsed = Date.now() - lastAt;
    const sameCategory = animCategory(current) === animCategory(animId);

    // Cross-category transitions bypass the hold — those are real state
    // changes the user wants to see immediately. Same-category transitions
    // respect it to suppress tool-call flicker.
    if (!sameCategory || elapsed >= MIN_ANIM_HOLD_MS) {
      const p = colPending.get(colId);
      if (p) { clearTimeout(p.timer); colPending.delete(colId); }
      commitColumnAnimation(colId, animId);
      return;
    }

    // Inside the hold window — queue this as the column's pending state.
    // If another change arrives before the timer fires, we just update the
    // target so only the latest one actually commits.
    const prev = colPending.get(colId);
    if (prev) {
      prev.animId = animId;
      pushDebug('set', { col: colId, anim: animId, skipped: 'pending-replaced' });
      return;
    }
    const delay = MIN_ANIM_HOLD_MS - elapsed;
    const pending = { animId: animId, timer: null };
    pending.timer = setTimeout(() => {
      const p = colPending.get(colId);
      if (!p) return;
      colPending.delete(colId);
      commitColumnAnimation(colId, p.animId);
    }, delay);
    colPending.set(colId, pending);
    pushDebug('set', { col: colId, anim: animId, skipped: 'held-' + delay + 'ms' });
  }

  function forgetColumn(colId) {
    colAnim.delete(colId);
    colCommitAt.delete(colId);
    const p = colPending.get(colId);
    if (p) { clearTimeout(p.timer); colPending.delete(colId); }
    clearSleepTimer(colId);
  }

  function fmtTs(ts) {
    const d = new Date(ts);
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  // source: 'hook' | 'jsonl' | 'set' — entry payload is small object that
  // describes either the inbound event or the resolved animation commit.
  function pushDebug(source, payload) {
    const entry = { ts: Date.now(), source, payload };
    debugRing.push(entry);
    if (debugRing.length > DEBUG_BUFFER) debugRing.shift();
    if (debugEnabled) renderDebugLog();
  }

  function renderDebugNow() {
    if (!debugNowEl) return;
    const animId = focusedColId != null ? colAnim.get(focusedColId) : null;
    const cat = animId ? animCategory(animId) : '—';
    const anim = animId ? (ANIM_BY_ID[animId] && ANIM_BY_ID[animId].label) : null;
    const pending = focusedColId != null ? colPending.get(focusedColId) : null;
    const lastAt = focusedColId != null ? colCommitAt.get(focusedColId) : null;
    const ageMs = lastAt ? (Date.now() - lastAt) : null;
    const ageStr = ageMs == null ? '' : (ageMs < 1000 ? ageMs + 'ms' : Math.round(ageMs / 1000) + 's');
    const lines = [];
    lines.push('col: ' + (focusedColId == null ? '(none)' : String(focusedColId)));
    lines.push('now: ' + (anim || animId || '—') + ' [' + cat + ']' + (ageStr ? ' · ' + ageStr : ''));
    if (pending) lines.push('pending → ' + pending.animId);
    debugNowEl.textContent = lines.join('  ·  ');
  }

  function fmtEntry(e) {
    const p = e.payload || {};
    if (e.source === 'hook') {
      return '[hook] ' + (p.event || '?') + (p.tool ? ' ' + p.tool : '')
        + (p.matcher ? ' (' + p.matcher + ')' : '')
        + ' col=' + (p.col == null ? '?' : p.col)
        + (p.anim ? ' → ' + p.anim : '')
        + (p.skipped ? ' [skipped: ' + p.skipped + ']' : '');
    }
    if (e.source === 'jsonl') {
      return '[jsonl] ' + (p.kind || '?') + (p.tool ? ' ' + p.tool : '')
        + ' col=' + (p.col == null ? '?' : p.col)
        + (p.anim ? ' → ' + p.anim : '');
    }
    if (e.source === 'set') {
      return '[anim] col=' + (p.col == null ? '?' : p.col) + ' → ' + p.anim
        + (p.skipped ? ' (' + p.skipped + ')' : '');
    }
    return e.source + ' ' + JSON.stringify(p);
  }

  function renderDebugLog() {
    if (!debugLogEl) return;
    // Append-only for the latest entry; rebuild rarely.
    const want = debugRing.length;
    const have = debugLogEl.childElementCount;
    if (want < have) {
      // Buffer trimmed or cleared — rebuild.
      debugLogEl.innerHTML = '';
      for (const e of debugRing) appendDebugRow(e);
    } else {
      for (let i = have; i < want; i++) appendDebugRow(debugRing[i]);
    }
    debugLogEl.scrollTop = debugLogEl.scrollHeight;
  }

  function appendDebugRow(e) {
    if (!debugLogEl) return;
    const row = document.createElement('div');
    row.className = 'row';
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = fmtTs(e.ts);
    const body = document.createElement('span');
    body.className = 'src-' + e.source;
    body.textContent = fmtEntry(e);
    if (e.payload && e.payload.skipped) body.classList.add('skip');
    if (e.payload && e.payload.anim && e.source !== 'set') {
      const tail = document.createElement('span');
      tail.className = 'anim';
      tail.textContent = '';
      row.appendChild(tail); // placeholder, body already includes the arrow
    }
    row.appendChild(ts);
    row.appendChild(body);
    debugLogEl.appendChild(row);
  }

  function applyDebugVisibility(enabled) {
    debugEnabled = !!enabled;
    if (!debugEl) return;
    debugEl.classList.toggle('hidden', !debugEnabled);
    debugEl.setAttribute('aria-hidden', String(!debugEnabled));
    if (debugEnabled) {
      renderDebugLog();
      renderDebugNow();
    }
  }

  function applyVisibility(enabled) {
    if (!widgetEl) return;
    widgetEl.classList.toggle('hidden', !enabled);
    widgetEl.setAttribute('aria-hidden', String(!enabled));
    if (enabled) {
      // When (re)shown, sync to the currently focused column's animation
      // — falls back to idle if none has been claimed yet.
      const animId = focusedColId != null ? ensureColAnim(focusedColId) : 'idle';
      const resolved = animId || 'idle';
      setAnimation(resolved);
      startVariantRotation(resolved);
    } else {
      stopVariantRotation();
    }
  }

  function applyPosition() {
    if (!widgetEl) return;
    const p = loadPos();
    if (p) {
      const cp = window.ClawdPosition && window.ClawdPosition.clampPosition;
      const clamped = cp ? cp(p, { innerWidth: window.innerWidth, innerHeight: window.innerHeight }, { width: currentSizePx, height: currentSizePx }) : p;
      widgetEl.style.right = clamped.right + 'px';
      widgetEl.style.bottom = clamped.bottom + 'px';
    }
  }

  // Re-clamp when the window shrinks so a widget parked near an edge on a
  // wider layout stays reachable.
  window.addEventListener('resize', applyPosition);

  function loadDebugPos() {
    try {
      const raw = window.localStorage.getItem(LS_DEBUG_POS);
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (typeof p.right === 'number' && typeof p.bottom === 'number') return p;
    } catch (_) {}
    return null;
  }
  function saveDebugPos(p) {
    try { window.localStorage.setItem(LS_DEBUG_POS, JSON.stringify(p)); } catch (_) {}
  }

  function applyDebugPosition() {
    if (!debugEl) return;
    const p = loadDebugPos();
    if (p) {
      debugEl.style.right = p.right + 'px';
      debugEl.style.bottom = p.bottom + 'px';
    }
  }

  // Drag the debug panel by its header. Buttons inside the header keep
  // working — we only start a drag when the press lands on the header
  // itself or the title, not on an interactive child.
  function makeDebugDraggable() {
    if (!debugEl) return;
    const header = debugEl.querySelector('.clawd-debug-header');
    if (!header) return;
    header.style.cursor = 'move';
    let dragging = false;
    let startX = 0, startY = 0, startR = 0, startB = 0;

    header.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const t = e.target;
      if (t && t.closest && t.closest('.clawd-debug-btn')) return;
      dragging = true;
      debugEl.classList.add('dragging');
      const rect = debugEl.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startR = window.innerWidth - rect.right;
      startB = window.innerHeight - rect.bottom;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const right = Math.max(0, Math.min(window.innerWidth - 40, startR - dx));
      const bottom = Math.max(0, Math.min(window.innerHeight - 40, startB - dy));
      debugEl.style.right = right + 'px';
      debugEl.style.bottom = bottom + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      debugEl.classList.remove('dragging');
      const rect = debugEl.getBoundingClientRect();
      saveDebugPos({
        right: Math.round(window.innerWidth - rect.right),
        bottom: Math.round(window.innerHeight - rect.bottom),
      });
    });
  }

  function makeDraggable() {
    let dragging = false;
    let moved = false;
    let startX = 0, startY = 0, startR = 0, startB = 0;

    widgetEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      moved = false;
      widgetEl.classList.add('dragging');
      const rect = widgetEl.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startR = window.innerWidth - rect.right;
      startB = window.innerHeight - rect.bottom;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      const cp = window.ClawdPosition && window.ClawdPosition.clampPosition;
      let right, bottom;
      if (cp) {
        const clamped = cp(
          { right: startR - dx, bottom: startB - dy },
          { innerWidth: window.innerWidth, innerHeight: window.innerHeight },
          { width: currentSizePx, height: currentSizePx }
        );
        right = clamped.right;
        bottom = clamped.bottom;
      } else {
        right = Math.max(0, Math.min(window.innerWidth - 40, startR - dx));
        bottom = Math.max(0, Math.min(window.innerHeight - 40, startB - dy));
      }
      widgetEl.style.right = right + 'px';
      widgetEl.style.bottom = bottom + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      widgetEl.classList.remove('dragging');
      const rect = widgetEl.getBoundingClientRect();
      savePos({
        right: Math.round(window.innerWidth - rect.right),
        bottom: Math.round(window.innerHeight - rect.bottom),
      });
      // Suppress the synthetic click that follows a drag.
      if (moved) widgetEl.dataset.suppressClick = '1';
    });
  }

  function attachInteractions() {
    // Left-click peeks at the current state. Animation itself is fully
    // driven by the focused column's real session activity.
    widgetEl.addEventListener('click', () => {
      if (widgetEl.dataset.suppressClick === '1') {
        delete widgetEl.dataset.suppressClick;
        return;
      }
      const anim = ANIM_BY_ID[currentAnimId];
      if (anim) showBubble(anim.label);
    });
    // Swallow the native context menu so right-click on the widget doesn't
    // pop the (mostly empty) Electron menu.
    widgetEl.addEventListener('contextmenu', (e) => { e.preventDefault(); });
  }

  function init() {
    widgetEl = document.getElementById('clawd-widget');
    imgEl = document.getElementById('clawd-widget-img');
    bubbleEl = document.getElementById('clawd-widget-bubble');
    debugEl = document.getElementById('clawd-debug');
    debugLogEl = document.getElementById('clawd-debug-log');
    debugNowEl = document.getElementById('clawd-debug-now');
    if (!widgetEl || !imgEl) return;

    applySize(loadInt(LS_SIZE, SIZE_DEFAULT));
    applyPosition();
    makeDraggable();
    attachInteractions();
    applyDebugPosition();
    makeDebugDraggable();
    applyVisibility(loadBool(LS_ENABLED, true)); // default ON
    applyDebugVisibility(loadBool(LS_DEBUG, false));

    const clearBtn = document.getElementById('clawd-debug-clear');
    if (clearBtn) clearBtn.addEventListener('click', () => {
      debugRing.length = 0;
      renderDebugLog();
    });
    const closeBtn = document.getElementById('clawd-debug-close');
    if (closeBtn) closeBtn.addEventListener('click', () => {
      saveBool(LS_DEBUG, false);
      applyDebugVisibility(false);
      // Mirror back into the Settings checkbox if it's mounted.
      const cb = document.getElementById('setting-clawd-debug');
      if (cb) cb.checked = false;
    });

    window.Clawd = {
      // Visual API used by renderer
      setFocusedColumn,
      setColumnAnimation,
      forgetColumn,
      setAnimation,
      showBubble,
      // Debug API used by renderer to log inbound events (hook + JSONL).
      logHookEvent: (info) => { pushDebug('hook', info); },
      logJsonlEvent: (info) => { pushDebug('jsonl', info); },
      // Settings API used by the Settings → Clawd pane
      enable: () => { saveBool(LS_ENABLED, true); applyVisibility(true); },
      disable: () => { saveBool(LS_ENABLED, false); applyVisibility(false); },
      isEnabled: () => loadBool(LS_ENABLED, true),
      setSize: (px) => { applySize(px); saveInt(LS_SIZE, px); },
      getSize: () => loadInt(LS_SIZE, SIZE_DEFAULT),
      enableDebug: () => { saveBool(LS_DEBUG, true); applyDebugVisibility(true); },
      disableDebug: () => { saveBool(LS_DEBUG, false); applyDebugVisibility(false); },
      isDebugEnabled: () => loadBool(LS_DEBUG, false),
      SIZE_MIN, SIZE_MAX, SIZE_DEFAULT,
      animations: () => ANIMATIONS.slice(),
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
