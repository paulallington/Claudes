function clampPosition(pos, viewport) {
  var maxRight = Math.max(0, viewport.innerWidth - 40);
  var maxBottom = Math.max(0, viewport.innerHeight - 40);
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
