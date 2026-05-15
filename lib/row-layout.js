function computeProportionalRowRatios(heights) {
  if (!Array.isArray(heights) || heights.length === 0) {
    return [];
  }
  if (heights.length === 1) {
    return [1];
  }
  var sanitized = [];
  var total = 0;
  for (var i = 0; i < heights.length; i++) {
    var h = heights[i];
    if (typeof h !== 'number' || !isFinite(h) || h <= 0) {
      h = 1;
    }
    sanitized.push(h);
    total += h;
  }
  if (total <= 0) {
    total = heights.length;
  }
  var ratios = [];
  for (var j = 0; j < sanitized.length; j++) {
    ratios.push(sanitized[j] / total);
  }
  return ratios;
}

function computeResizeRedistribution(rowHeights) {
  var ratios = computeProportionalRowRatios(rowHeights);
  var ops = [];
  for (var i = 0; i < ratios.length; i++) {
    ops.push({ flex: ratios[i] + ' 1 0', height: '' });
  }
  return ops;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    computeProportionalRowRatios: computeProportionalRowRatios,
    computeResizeRedistribution: computeResizeRedistribution
  };
}
if (typeof window !== 'undefined') {
  window.RowLayout = {
    computeProportionalRowRatios: computeProportionalRowRatios,
    computeResizeRedistribution: computeResizeRedistribution
  };
}
