'use strict';

(function () {
  /**
   * Clamp a popup menu's intended (x, y) position so it never spills off
   * the viewport edge. Mirrors the inline guard used by the terminal
   * right-click context menu (renderer.js:4715-4722) as a reusable, pure
   * helper for other menus (column overflow menu, session picker, …).
   *
   * @param {number} x - intended left position
   * @param {number} y - intended top position
   * @param {number} width - menu width (post-append getBoundingClientRect)
   * @param {number} height - menu height (post-append getBoundingClientRect)
   * @param {number} viewportW - window.innerWidth
   * @param {number} viewportH - window.innerHeight
   * @param {number} [margin] - gap to leave from the clamped edge, default 4
   * @returns {{ left: number, top: number }}
   */
  function clampMenuPosition(x, y, width, height, viewportW, viewportH, margin) {
    if (margin === undefined) margin = 4;
    var left = x;
    var top = y;
    if (x + width > viewportW) left = Math.max(0, viewportW - width - margin);
    if (y + height > viewportH) top = Math.max(0, viewportH - height - margin);
    return { left: left, top: top };
  }

  var api = { clampMenuPosition: clampMenuPosition };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.MenuPosition = api;
  }
})();
