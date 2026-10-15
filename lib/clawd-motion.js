// Decides when the Clawd widget's SVG should actually animate. The idle SVG
// alone (9 infinite CSS keyframes) measured about 12% of a core in the
// renderer and 15% in the GPU process, so the crab holds still whenever
// animating shows nothing useful.
var IDLE_ANIMS = { idle: true, sleeping: true, disconnected: true, 'going-away': true };

function shouldAnimate(opts) {
  if (!opts || !opts.docVisible || !opts.windowFocused) return false;
  return !IDLE_ANIMS[opts.animId];
}

// The SVG with every CSS animation frozen on its first keyframe. Loaded as a
// data: URL this costs nothing, unlike the live file.
function pausedSvg(svgText) {
  if (typeof svgText !== 'string') return null;
  var at = svgText.lastIndexOf('</svg>');
  if (at === -1) return null;
  return svgText.slice(0, at) +
    '<style>*{animation-play-state:paused!important}</style>' +
    svgText.slice(at);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { shouldAnimate: shouldAnimate, pausedSvg: pausedSvg };
}
if (typeof window !== 'undefined') {
  window.ClawdMotion = { shouldAnimate: shouldAnimate, pausedSvg: pausedSvg };
}
