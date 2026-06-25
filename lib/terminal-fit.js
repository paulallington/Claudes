/**
 * Trim xterm's proposed row count to what the renderer can actually draw.
 *
 * FitAddon computes rows from the IDEAL (fractional) css cell height, but the
 * WebGL/canvas renderer draws each row at the device-pixel-rounded height
 * (dimensions.device.cell.height / devicePixelRatio), which can be slightly
 * taller. Over ~45 rows the accumulated difference overflows the wrapper's
 * bottom padding (overflow:hidden) and clips the last row — worse at fractional
 * Windows display scaling. This recomputes the max rows that fit using the
 * ACTUAL rendered row height and only ever trims (never grows) the proposal.
 *
 * @param {{ availableHeightCss: number, deviceCellHeightPx: number,
 *           devicePixelRatio: number, proposedRows: number }} opts
 * @returns {number} corrected row count, <= proposedRows, >= 1
 */
function correctRows(opts) {
  var availableHeightCss = opts && opts.availableHeightCss;
  var deviceCellHeightPx = opts && opts.deviceCellHeightPx;
  var devicePixelRatio = opts && opts.devicePixelRatio;
  var proposedRows = opts && opts.proposedRows;

  // Actual css height the renderer paints each row at.
  var renderedRowCss = deviceCellHeightPx / devicePixelRatio;

  // Best-effort safety: bail (return proposal untouched) on any junk input so
  // we never throw into the render path or hand back a nonsense row count.
  if (!isFinite(renderedRowCss) || renderedRowCss <= 0) return proposedRows;
  if (!isFinite(availableHeightCss) || availableHeightCss <= 0) return proposedRows;
  if (!isFinite(proposedRows) || proposedRows < 1) return proposedRows;

  var maxRows = Math.max(1, Math.floor(availableHeightCss / renderedRowCss));
  // Only ever trim — never grow beyond what FitAddon proposed.
  return Math.min(proposedRows, maxRows);
}

/**
 * True content height of a padded element. clientHeight includes padding but
 * not border/scrollbar; under box-sizing:border-box getComputedStyle(...).height
 * returns the border-box height (padding included), which FitAddon mis-reads as
 * available space — overcounting rows by the padding. Subtracting the vertical
 * padding from clientHeight yields the real content area regardless of box-sizing.
 * Best-effort: returns clientHeightPx unchanged on any junk input.
 *
 * @param {number} clientHeightPx element.clientHeight (padding included)
 * @param {number} paddingTopPx computed padding-top in px
 * @param {number} paddingBottomPx computed padding-bottom in px
 * @returns {number} content height (>= 0), or clientHeightPx unchanged on junk
 */
function contentHeightPx(clientHeightPx, paddingTopPx, paddingBottomPx) {
  // Fall back to the raw value when clientHeight is unusable.
  if (!isFinite(clientHeightPx) || clientHeightPx <= 0) return clientHeightPx;

  // Treat non-finite/negative padding as 0 so junk never inflates the result.
  var top = isFinite(paddingTopPx) && paddingTopPx > 0 ? paddingTopPx : 0;
  var bottom = isFinite(paddingBottomPx) && paddingBottomPx > 0 ? paddingBottomPx : 0;

  // Clamp to >= 0; padding should never exceed the box, but guard anyway.
  return Math.max(0, clientHeightPx - top - bottom);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { correctRows: correctRows, contentHeightPx: contentHeightPx };
}
if (typeof window !== 'undefined') {
  window.TerminalFit = { correctRows: correctRows, contentHeightPx: contentHeightPx };
}
