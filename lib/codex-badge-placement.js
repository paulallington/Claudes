// Pure viewport placement for the body-level Codex badge details overlay.
// Loaded by Node tests through module.exports and by the renderer as a script.

'use strict';

(function () {
  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max));
  }

  function placeBadgeTooltip(anchorRect, tooltipRect, viewport, options) {
    options = options || {};
    var padding = Number.isFinite(options.padding) ? options.padding : 8;
    var gap = Number.isFinite(options.gap) ? options.gap : 6;
    var viewportWidth = Math.max(0, Number(viewport && viewport.width) || 0);
    var viewportHeight = Math.max(0, Number(viewport && viewport.height) || 0);
    var tooltipWidth = Math.max(0, Number(tooltipRect && tooltipRect.width) || 0);
    var tooltipHeight = Math.max(0, Number(tooltipRect && tooltipRect.height) || 0);
    var anchorLeft = Number(anchorRect && anchorRect.left) || 0;
    var anchorTop = Number(anchorRect && anchorRect.top) || 0;
    var anchorBottom = Number(anchorRect && anchorRect.bottom) || anchorTop;
    var anchorWidth = Math.max(0, Number(anchorRect && anchorRect.width) || 0);

    var left = clamp(
      anchorLeft + (anchorWidth - tooltipWidth) / 2,
      padding,
      viewportWidth - tooltipWidth - padding
    );
    var below = anchorBottom + gap;
    var above = anchorTop - tooltipHeight - gap;
    var top = below + tooltipHeight <= viewportHeight - padding ? below : above;
    top = clamp(top, padding, viewportHeight - tooltipHeight - padding);

    return { left: left, top: top };
  }

  function dismissOwnedBadgeTooltip(columnElement, owner, tooltipElement) {
    if (!columnElement || !owner || typeof columnElement.contains !== 'function' || !columnElement.contains(owner)) {
      return owner;
    }
    if (tooltipElement && tooltipElement.classList && typeof tooltipElement.classList.remove === 'function') {
      tooltipElement.classList.remove('codex-badge-tooltip-shown');
    }
    return null;
  }

  var api = {
    placeBadgeTooltip: placeBadgeTooltip,
    dismissOwnedBadgeTooltip: dismissOwnedBadgeTooltip
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.CodexBadgePlacement = api;
})();
