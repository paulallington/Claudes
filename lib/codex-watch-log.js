// Parses codex-companion job logs into typed events.
//
// The plugin writes `[<ISO>] message` lines, with any following non-header
// lines forming that event's body (appendLogBlock). An event is therefore only
// complete once the NEXT header arrives, so the trailing event is held in
// `carry` and exposed separately via previewEvent() for live display.

var HEADER_RE = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s?([\s\S]*)$/;

function isHeader(line) {
  return HEADER_RE.test(line);
}

function buildEvent(lines) {
  if (!lines.length) return null;
  var m = HEADER_RE.exec(lines[0]);
  if (!m) return null;
  var body = lines.slice(1).join('\n').replace(/\s+$/, '');
  return classify({
    ts: m[1],
    message: m[2].trim(),
    body: body,
    type: 'status',
    ok: null,
    exitCode: null,
    truncated: false
  });
}

var RUNNING_RE = /^Running command:\s*([\s\S]*)$/;
var RESULT_RE = /^Command (completed|failed):\s*([\s\S]*?)\s*\(exit (-?\d+)\)$/;
var ASSISTANT_INLINE_RE = /^Assistant message captured:\s*([\s\S]*)$/;

function classify(evt) {
  var result = RESULT_RE.exec(evt.message);
  if (result) {
    evt.type = 'command-result';
    evt.ok = result[1] === 'completed';
    evt.exitCode = Number(result[3]);
    evt.message = result[2];
    evt.truncated = /\.\.\.$/.test(evt.message);
    return evt;
  }

  var running = RUNNING_RE.exec(evt.message);
  if (running) {
    evt.type = 'command';
    evt.message = running[1];
    evt.truncated = /\.\.\.$/.test(evt.message);
    return evt;
  }

  var inlineAssistant = ASSISTANT_INLINE_RE.exec(evt.message);
  if (inlineAssistant) {
    evt.type = 'assistant';
    evt.message = inlineAssistant[1];
    evt.truncated = /\.\.\.$/.test(evt.message);
    return evt;
  }

  if (evt.message === 'Assistant message') {
    evt.type = 'assistant';
    return evt;
  }

  return evt;
}

function parseLogChunk(carry, chunk) {
  var text = String(carry || '') + String(chunk || '');
  var lines = text.split('\n');

  // Group lines into events; each group starts at a header line.
  var groups = [];
  for (var i = 0; i < lines.length; i++) {
    if (isHeader(lines[i]) || !groups.length) groups.push([lines[i]]);
    else groups[groups.length - 1].push(lines[i]);
  }

  // The final group may still grow (more body, or an incomplete line), so it
  // is never emitted — it becomes the new carry.
  var trailing = groups.pop() || [];
  var events = [];
  for (var g = 0; g < groups.length; g++) {
    var evt = buildEvent(groups[g]);
    if (evt) events.push(evt);
  }

  return { events: events, carry: trailing.join('\n') };
}

function previewEvent(carry) {
  var text = String(carry || '');
  if (!text.trim()) return null;
  return buildEvent(text.split('\n'));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseLogChunk, previewEvent };
}
if (typeof window !== 'undefined') {
  window.CodexWatchLog = { parseLogChunk, previewEvent };
}
