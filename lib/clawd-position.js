function clampPosition(pos, viewport, size) {
  var w = (size && size.width) || 0;
  var h = (size && size.height) || 0;
  var maxRight = Math.max(0, viewport.innerWidth - w);
  var maxBottom = Math.max(0, viewport.innerHeight - h);
  return {
    right: Math.max(0, Math.min(maxRight, pos.right)),
    bottom: Math.max(0, Math.min(maxBottom, pos.bottom))
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    clampPosition: clampPosition
  };
}
if (typeof window !== 'undefined') {
  window.ClawdPosition = {
    clampPosition: clampPosition
  };
}
