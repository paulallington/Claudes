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
  const SIZE_DEFAULT = 180;
  const SIZE_MIN = 60;
  const SIZE_MAX = 480;

  let widgetEl = null;
  let imgEl = null;
  let bubbleEl = null;
  let currentAnimId = null;
  let bubbleTimer = null;

  // Per-column animation assignments, driven by the renderer from session
  // JSONL activity. Defaults to 'idle' until the real state is known.
  const colAnim = new Map(); // columnId -> animId
  let focusedColId = null;

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
    widgetEl.style.setProperty('--clawd-size', clamped + 'px');
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
    if (widgetEl && widgetEl.classList.contains('hidden')) return;
    const animId = ensureColAnim(colId) || 'idle';
    setAnimation(animId);
  }

  function setColumnAnimation(colId, animId) {
    if (colId === null || colId === undefined) return;
    if (!ANIM_BY_ID[animId]) return;
    colAnim.set(colId, animId);
    if (colId === focusedColId) setAnimation(animId);
  }

  function applyVisibility(enabled) {
    if (!widgetEl) return;
    widgetEl.classList.toggle('hidden', !enabled);
    widgetEl.setAttribute('aria-hidden', String(!enabled));
    if (enabled) {
      // When (re)shown, sync to the currently focused column's animation
      // — falls back to idle if none has been claimed yet.
      const animId = focusedColId != null ? ensureColAnim(focusedColId) : 'idle';
      setAnimation(animId || 'idle');
    }
  }

  function applyPosition() {
    if (!widgetEl) return;
    const p = loadPos();
    if (p) {
      widgetEl.style.right = p.right + 'px';
      widgetEl.style.bottom = p.bottom + 'px';
    }
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
      const right = Math.max(0, Math.min(window.innerWidth - 40, startR - dx));
      const bottom = Math.max(0, Math.min(window.innerHeight - 40, startB - dy));
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
    if (!widgetEl || !imgEl) return;

    applySize(loadInt(LS_SIZE, SIZE_DEFAULT));
    applyPosition();
    makeDraggable();
    attachInteractions();
    applyVisibility(loadBool(LS_ENABLED, true)); // default ON

    window.Clawd = {
      // Visual API used by renderer
      setFocusedColumn,
      setColumnAnimation,
      forgetColumn: (id) => { colAnim.delete(id); },
      setAnimation,
      showBubble,
      // Settings API used by the Settings → Clawd pane
      enable: () => { saveBool(LS_ENABLED, true); applyVisibility(true); },
      disable: () => { saveBool(LS_ENABLED, false); applyVisibility(false); },
      isEnabled: () => loadBool(LS_ENABLED, true),
      setSize: (px) => { applySize(px); saveInt(LS_SIZE, px); },
      getSize: () => loadInt(LS_SIZE, SIZE_DEFAULT),
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
