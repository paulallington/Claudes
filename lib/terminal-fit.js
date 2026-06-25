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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { correctRows: correctRows };
}
if (typeof window !== 'undefined') {
  window.TerminalFit = { correctRows: correctRows };
}
