/**
 * Pure UI-resolution helpers for the two unrelated "pause" concepts in
 * Automations: the GLOBAL scheduler pause (`globalEnabled` in
 * automations.json — when false, main.js never fires a scheduled tick for
 * ANY automation) and the PER-AUTOMATION `enabled` flag (the sidebar panel's
 * pause/resume-all, scoped to the active project). These used to share the
 * same ❚❚/▶ glyph vocabulary with no visual link between them, so a global
 * pause was invisible in the per-project card list. This module gives both
 * concepts an explicit, testable rendering.
 */

/**
 * Resolve the toolbar flyout's global-pause banner/toggle presentation.
 * A missing/undefined globalEnabled is treated as ENABLED (not paused) —
 * the persisted default is true, and only an explicit false means paused.
 * @param {{ globalEnabled?: boolean }} opts
 * @returns {{ paused: boolean, showBanner: boolean, bannerText: string, toggleGlyph: string, toggleTitle: string }}
 */
function resolveGlobalPauseUi(opts) {
  var globalEnabled = opts && opts.globalEnabled;
  var paused = globalEnabled === false;
  return {
    paused: paused,
    showBanner: paused,
    bannerText: paused ? 'Automations are paused — no scheduled runs will start.' : '',
    toggleGlyph: paused ? '▶' : '❚❚',
    toggleTitle: paused ? 'Resume scheduler' : 'Pause scheduler',
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { resolveGlobalPauseUi };
}
if (typeof window !== 'undefined') {
  window.AutomationsPauseUi = { resolveGlobalPauseUi };
}
