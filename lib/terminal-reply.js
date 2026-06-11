/**
 * Extract the raw prose text of the LAST assistant reply block from a column's
 * rendered terminal buffer. This powers real-time voice: Claude Code interactive
 * columns often don't persist their reply to the transcript JSONL until much
 * later, but the reply IS on screen, so we read it straight off the xterm buffer.
 *
 * `lines` is an array of already-right-trimmed rendered line strings, e.g. from
 *   buffer.active.getLine(i).translateToString(true).
 *
 * Algorithm:
 *  - A block starts with a bullet line: /^[●•▪]\s+(\S.*)$/ (bullet at column 0).
 *  - Continuation lines are indented: /^\s{2,}(\S.*)$/ — appended to the current
 *    block's text, joined with a single space. A block ends at a blank line, the
 *    next bullet line, or any non-indented line.
 *  - A block is a TOOL block when its first-line content matches
 *    /^[A-Z][A-Za-z0-9_]*\(/ (e.g. Bash(...), Read(...)) OR begins with the
 *    tool-result marker ⎿. Otherwise it is PROSE.
 *  - Return the text of the LAST PROSE block (trimmed), or '' if none.
 *
 * @param {string[]} lines - rendered terminal line strings (right-trimmed)
 * @returns {string} the last prose reply text, or ''
 */
function extractLastTerminalReply(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return '';

  var BULLET = /^[●•▪]\s+(\S.*)$/; // ● • ▪ at column 0
  var INDENT = /^\s{2,}(\S.*)$/;
  // Bash( Read( etc. (PascalCase) plus MCP tools like mcp__server__tool(args).
  // Anchored with no space before '(' so prose isn't misclassified as a tool.
  var TOOL_HEAD = /^([A-Z][A-Za-z0-9_]*|mcp__\w+)\(/;
  var RESULT_MARK = '⎿'; // ⎿ tool-result marker

  var lastProse = '';
  var lastProseStartIdx = -1;
  var i = 0;
  while (i < lines.length) {
    var line = lines[i];
    var m = line != null ? String(line).match(BULLET) : null;
    if (!m) { i++; continue; }

    // Start of a block. m[1] is the first-line content after the bullet.
    var blockStart = i; // buffer index where this block begins
    var firstContent = m[1];
    var parts = [firstContent];
    i++;
    while (i < lines.length) {
      var contStr = lines[i] == null ? '' : String(lines[i]);
      if (contStr.trim() === '') {
        // Blank line: peek past the blank run. Continue the block only if the
        // next non-blank line is an indented continuation (paragraph break),
        // not a bullet. Footer (✻ … for Ns), the ❯ prompt, and ──── separators
        // all sit at column 0, so the block correctly ends before them.
        var k = i + 1;
        while (k < lines.length && (lines[k] == null || String(lines[k]).trim() === '')) k++;
        if (k < lines.length && INDENT.test(String(lines[k])) && !BULLET.test(String(lines[k]))) {
          i = k; // paragraph break — skip the blank run, keep collecting
          continue;
        }
        break; // blank precedes footer/prompt/separator/end
      }
      if (BULLET.test(contStr)) break; // next bullet ends the block
      var cm = contStr.match(INDENT);
      if (!cm) break; // non-indented line ends the block
      parts.push(cm[1]);
      i++;
    }

    var isTool = TOOL_HEAD.test(firstContent) || firstContent.indexOf(RESULT_MARK) === 0;
    if (!isTool) {
      lastProse = parts.join(' ').replace(/\s+/g, ' ').trim();
      lastProseStartIdx = blockStart;
    }
  }

  // The 🔊 summary line is rendered at column 0 (not a bullet, often after a
  // horizontal rule), so the bullet-block parser above can miss it. Recover it:
  // find the LAST line carrying the 🔊 marker, collect it + indented
  // continuations, and append (unless the prose already contains a 🔊) so
  // splitReplySummary can extract the summary and FULL mode keeps the body.
  //
  // CRUCIAL: only recover a 🔊 that belongs to the CURRENT reply — i.e. at or
  // after where the last prose block started (lastProseStartIdx). A 🔊 sitting
  // ABOVE the current reply's prose block belongs to an OLDER reply higher in
  // scrollback; appending it would speak a stale summary instead of this reply.
  if (lastProse && lastProseStartIdx >= 0 && lastProse.indexOf(SPEAKER) === -1) {
    var speakerLineIdx = -1;
    for (var s = lines.length - 1; s >= lastProseStartIdx; s--) {
      if (lines[s] != null && String(lines[s]).indexOf(SPEAKER) !== -1) { speakerLineIdx = s; break; }
    }
    if (speakerLineIdx >= 0) {
      var sParts = [String(lines[speakerLineIdx]).trim()];
      for (var t = speakerLineIdx + 1; t < lines.length; t++) {
        var tl = lines[t] == null ? '' : String(lines[t]);
        if (tl.trim() === '') break;
        var tm = tl.match(INDENT);
        if (!tm) break;
        sParts.push(tm[1]);
      }
      var speakerText = sParts.join(' ').replace(/\s+/g, ' ').trim();
      lastProse = lastProse + ' ' + speakerText;
    }
  }

  return lastProse;
}

// Unicode speaker-with-three-sound-waves emoji (U+1F50A) — marks the 🔊 summary
// line that, per reply, opts the reply into "speak only this line" behavior.
var SPEAKER = '\u{1F50A}';

/**
 * Split a space-joined terminal reply (as produced by extractLastTerminalReply)
 * into its spoken-aloud parts. The 🔊 summary line is always last, so the LAST
 * occurrence of the speaker emoji marks the boundary.
 *
 *  - hasSummary: whether a 🔊 marker was found at all.
 *  - body: everything BEFORE the 🔊 (or the whole string when absent), trimmed.
 *  - summary: the text AFTER the 🔊, with a leading variation-selector/space the
 *    emoji cell may leave stripped, trimmed. '' when no 🔊 is present.
 *
 * @param {string} rawJoined - the space-joined raw reply
 * @returns {{ body: string, summary: string, hasSummary: boolean }}
 */
function splitReplySummary(rawJoined) {
  var s = typeof rawJoined === 'string' ? rawJoined : '';
  var idx = s.lastIndexOf(SPEAKER);
  var hasSummary = idx >= 0;
  var body = (hasSummary ? s.slice(0, idx) : s).trim();
  var summary = hasSummary
    ? s.slice(idx + SPEAKER.length).replace(/^[️\s]+/, '').trim()
    : '';
  return { body: body, summary: summary, hasSummary: hasSummary };
}

/**
 * Return the FIRST sentence of `text`: everything up to and including the first
 * sentence-ending mark (`.`, `!`, or `?`) that is followed by whitespace or the
 * end of the string. When no such boundary exists, the whole trimmed text is
 * returned. Used as the concise fallback for the explicit Summary button when a
 * reply carries no 🔊 line.
 *
 * @param {string} text
 * @returns {string} the first sentence, or the whole trimmed text, or ''
 */
function firstSentence(text) {
  var s = (typeof text === 'string' ? text : '').trim();
  if (!s) return '';
  var m = s.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return m ? m[0].trim() : s;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractLastTerminalReply, splitReplySummary, firstSentence };
}
if (typeof window !== 'undefined') {
  window.TerminalReply = { extractLastTerminalReply, splitReplySummary, firstSentence };
}
