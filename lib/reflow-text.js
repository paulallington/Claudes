// Clean a raw terminal (xterm) text selection into flowing prose suitable for
// pasting into Slack/docs. The TUI hard-wraps every visual line and pads a
// uniform left margin; verbatim copy looks broken. This strips the margin and
// rejoins wrapped prose into paragraphs while leaving lists and indented blocks
// (likely code) on their own lines. Pure: no DOM, no Node APIs, no deps.

// Leading whitespace of a line (spaces/tabs), '' when none.
function leadingWhitespace(line) {
  var m = line.match(/^[ \t]*/);
  return m ? m[0] : '';
}

// The longest common prefix shared by two strings.
function commonPrefix(a, b) {
  var n = Math.min(a.length, b.length);
  var i = 0;
  while (i < n && a.charAt(i) === b.charAt(i)) {
    i++;
  }
  return a.slice(0, i);
}

// A line that should stay on its own line (not merged into the running
// paragraph): after dedent it either still begins with whitespace (deeper
// indentation — likely code/nested block) or starts with a list/bullet marker.
function isNonFlowable(line) {
  if (/^[ \t]/.test(line)) return true;
  if (/^[-*+•] /.test(line)) return true;
  if (/^\d+[.)] /.test(line)) return true;
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

  // Dedent: longest common leading-whitespace prefix across non-blank lines.
  var prefix = null;
  for (i = 0; i < lines.length; i++) {
    if (lines[i] === '') continue;
    var lead = leadingWhitespace(lines[i]);
    prefix = prefix === null ? lead : commonPrefix(prefix, lead);
    if (prefix === '') break;
  }
  if (prefix) {
    for (i = 0; i < lines.length; i++) {
      if (lines[i].slice(0, prefix.length) === prefix) {
        lines[i] = lines[i].slice(prefix.length);
      }
    }
  }

  // Reflow into paragraphs/standalone lines.
  var out = [];           // emitted blocks (paragraph strings or standalone lines)
  var para = [];          // words/segments of the current flowing paragraph
  function flush() {
    if (para.length) {
      out.push(para.join(' '));
      para = [];
    }
  }
  for (i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line === '') {
      flush();
      // Mark a paragraph break (collapse runs later via single blank join).
      if (out.length && out[out.length - 1] !== null) {
        out.push(null);
      }
      continue;
    }
    if (isNonFlowable(line)) {
      flush();
      out.push(line);
      continue;
    }
    para.push(line);
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
