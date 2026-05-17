// Clawd widget — bottom-right floating animated crab.
// Visual-only first pass. State is hardcoded; right-click cycles through
// animations so we can audition them in the real app shell.
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
  const LS_LAST_ANIM = 'clawd.lastAnim';

  let widgetEl = null;
  let imgEl = null;
  let bubbleEl = null;
  let toggleEl = null;
  let currentAnimId = null;
  let bubbleTimer = null;

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

  function setAnimation(id) {
    const anim = ANIM_BY_ID[id] || ANIM_BY_ID.idle;
    if (!anim || !imgEl) return;
    if (currentAnimId === anim.id) return;
    currentAnimId = anim.id;
    try { window.localStorage.setItem(LS_LAST_ANIM, anim.id); } catch (_) {}
    // Cross-fade: opacity → 0, swap src, opacity → 1.
    imgEl.classList.add('fading');
    setTimeout(() => {
      imgEl.src = ASSETS + anim.file;
      // Force re-decode then fade in
      requestAnimationFrame(() => requestAnimationFrame(() => {
        imgEl.classList.remove('fading');
      }));
    }, 200);
  }

  function showBubble(text, durationMs = 1800) {
    if (!bubbleEl) return;
    bubbleEl.textContent = text;
    bubbleEl.classList.remove('hidden');
    if (bubbleTimer) clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubbleEl.classList.add('hidden'), durationMs);
  }

  function applyVisibility(enabled) {
    if (!widgetEl) return;
    widgetEl.classList.toggle('hidden', !enabled);
    widgetEl.setAttribute('aria-hidden', String(!enabled));
    if (enabled && !currentAnimId) {
      const last = (() => {
        try { return window.localStorage.getItem(LS_LAST_ANIM); } catch (_) { return null; }
      })();
      setAnimation(last && ANIM_BY_ID[last] ? last : 'idle');
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
    let startX = 0, startY = 0, startR = 0, startB = 0;

    widgetEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
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
    });
  }

  function cycleAnimation(dir) {
    const idx = ANIMATIONS.findIndex((a) => a.id === currentAnimId);
    const next = (idx + (dir > 0 ? 1 : -1) + ANIMATIONS.length) % ANIMATIONS.length;
    const anim = ANIMATIONS[next];
    setAnimation(anim.id);
    showBubble(anim.label);
  }

  function attachInteractions() {
    // Left-click → show bubble with current state
    widgetEl.addEventListener('click', (e) => {
      // Suppress click that fires after a drag — if widget moved meaningfully
      // we won't have a perfect signal here, so just show the bubble briefly.
      const anim = ANIM_BY_ID[currentAnimId];
      if (anim) showBubble(anim.label);
    });
    // Right-click → cycle through animations (visual preview)
    widgetEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      cycleAnimation(e.shiftKey ? -1 : 1);
    });
    // Double-click → reset to idle
    widgetEl.addEventListener('dblclick', () => {
      setAnimation('idle');
      showBubble('Idle');
    });
  }

  function attachToggle() {
    if (!toggleEl) return;
    const enabled = loadBool(LS_ENABLED, false);
    toggleEl.checked = enabled;
    applyVisibility(enabled);
    toggleEl.addEventListener('change', () => {
      const on = !!toggleEl.checked;
      saveBool(LS_ENABLED, on);
      applyVisibility(on);
    });
  }

  function init() {
    widgetEl = document.getElementById('clawd-widget');
    imgEl = document.getElementById('clawd-widget-img');
    bubbleEl = document.getElementById('clawd-widget-bubble');
    toggleEl = document.getElementById('clawd-toggle');
    if (!widgetEl || !imgEl) return;

    applyPosition();
    makeDraggable();
    attachInteractions();
    attachToggle();

    // Expose a tiny API for later state-machine wiring.
    window.Clawd = {
      setAnimation,
      showBubble,
      animations: () => ANIMATIONS.slice(),
      enable: () => { if (toggleEl) { toggleEl.checked = true; toggleEl.dispatchEvent(new Event('change')); } },
      disable: () => { if (toggleEl) { toggleEl.checked = false; toggleEl.dispatchEvent(new Event('change')); } },
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
