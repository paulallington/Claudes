// Clean a raw terminal (xterm) text selection into flowing prose suitable for
// pasting into Slack/docs. The TUI hard-wraps every visual line and pads a
// uniform left margin; verbatim copy looks broken. This strips the margin and
// rejoins wrapped prose into paragraphs while leaving lists and indented blocks
// (likely code) on their own lines. Pure: no DOM, no Node APIs, no deps.

// Width of a line's leading whitespace (spaces/tabs). A tab counts as width 1
// for simplicity — terminal selections are space-padded, so this is adequate.
function leadingWidth(line) {
  var m = line.match(/^[ \t]*/);
  return m ? m[0].length : 0;
}

// Does this trimmed line start with a list marker (unordered bullet or ordered
// number) followed by a space?
function startsListMarker(trimmed) {
  if (/^[-*+•] /.test(trimmed)) return true;
  if (/^\d+[.)] /.test(trimmed)) return true;
  return false;
}

function reflowSelection(text) {
  if (text == null) return '';
  if (typeof text !== 'string') return '';
  if (text.trim() === '') return '';

  // Split and right-trim every line.
  var rawLines = text.split('\n');
  var lines = [];
  var i;
  for (i = 0; i < rawLines.length; i++) {
    lines.push(rawLines[i].replace(/[ \t]+$/, ''));
  }

  // baseIndent: the minimum leading-whitespace width among all NON-blank lines.
  var baseIndent = null;
  for (i = 0; i < lines.length; i++) {
    if (lines[i] === '') continue;
    var w = leadingWidth(lines[i]);
    if (baseIndent === null || w < baseIndent) baseIndent = w;
  }
  if (baseIndent === null) baseIndent = 0;

  // Reflow into paragraphs/standalone lines.
  var out = [];           // emitted blocks (paragraph strings or standalone lines)
  var para = [];          // segments of the current flowing paragraph (trimmed)
  var inFence = false;    // inside a ``` fenced code block?
  function flush() {
    if (para.length) {
      out.push(para.join(' '));
      para = [];
    }
  }
  for (i = 0; i < lines.length; i++) {
    var line = lines[i];
    var trimmed = line.replace(/^[ \t]+/, '');
    // rel: this line's indent relative to baseIndent (residual indentation).
    var rel = leadingWidth(line) - baseIndent;

    if (line === '') {
      flush();
      // Mark a paragraph break (collapse runs later via single blank join).
      if (out.length && out[out.length - 1] !== null) {
        out.push(null);
      }
      continue;
    }

    // Track fenced code-block open/close state.
    var isFenceDelim = /^```/.test(trimmed);
    if (inFence) {
      // Everything inside a fence is structural; preserve indent vs baseIndent.
      flush();
      out.push(rel > 0 ? new Array(rel + 1).join(' ') + trimmed : trimmed);
      if (isFenceDelim) inFence = false;
      continue;
    }
    if (isFenceDelim) {
      flush();
      out.push(rel > 0 ? new Array(rel + 1).join(' ') + trimmed : trimmed);
      inFence = true;
      continue;
    }

    // Structural lines stay on their own line. Small residual indent (rel 1-3)
    // is treated as noise — TUI-wrapped prose — and flows.
    if (rel >= 4 || startsListMarker(trimmed)) {
      flush();
      out.push(rel > 0 ? new Array(rel + 1).join(' ') + trimmed : trimmed);
      continue;
    }

    // Flowable prose: use the trimmed text so residual small indents disappear.
    para.push(trimmed);
  }
  flush();

  // Build output: blocks joined by '\n', nulls (paragraph breaks) become blank
  // lines. Trim leading/trailing breaks.
  while (out.length && out[0] === null) out.shift();
  while (out.length && out[out.length - 1] === null) out.pop();

  var result = '';
  for (i = 0; i < out.length; i++) {
    if (out[i] === null) {
      result += '\n\n';
    } else {
      if (result !== '' && result.charAt(result.length - 1) !== '\n') {
        result += '\n';
      }
      result += out[i];
    }
  }
  return result;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { reflowSelection: reflowSelection };
}
if (typeof window !== 'undefined') {
  window.ReflowText = { reflowSelection: reflowSelection };
}
