/**
 * Turn Claude Code SendUserFile tool events into renderable attachment
 * records. The terminal only prints `[image] <path> (41.4KB)` for these, so
 * the app surfaces the real files (and captions) via two sources: the live
 * PreToolUse hook event, and the session transcript JSONL. Pure string
 * logic only — no `path` module, no fs, no Electron — so it works the same
 * on Windows backslash paths and POSIX forward-slash paths.
 */
(function () {
'use strict';

// Extensions rendered as an inline image preview; everything else is a
// generic file attachment.
var IMAGE_EXTS = Object.create(null);
['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].forEach(function (ext) { IMAGE_EXTS[ext] = 1; });

/**
 * Split a file path (Windows or POSIX) into its renderable parts.
 * @param {string} filePath
 * @returns {{ path: string, name: string, ext: string, kind: 'image'|'file' }}
 */
function classifyFile(filePath) {
  var p = typeof filePath === 'string' ? filePath : '';
  var segments = p.split(/[\\/]+/).filter(function (s) { return s.length > 0; });
  var name = segments.length ? segments[segments.length - 1] : '';
  var dot = name.lastIndexOf('.');
  var ext = (dot > 0 && dot < name.length - 1) ? name.slice(dot + 1).toLowerCase() : '';
  var kind = IMAGE_EXTS[ext] ? 'image' : 'file';
  return { path: p, name: name, ext: ext, kind: kind };
}

/**
 * Normalize a SendUserFile `tool_input.files` value into classified,
 * de-duplicated FileRecords. Tolerates a bare string, non-string members,
 * and an absent/empty value.
 * @param {*} files
 * @returns {Array<{ path: string, name: string, ext: string, kind: 'image'|'file' }>}
 */
function normalizeFiles(files) {
  var list = Array.isArray(files) ? files : (typeof files === 'string' ? [files] : []);
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var f = list[i];
    if (typeof f !== 'string' || !f || seen[f]) continue;
    seen[f] = true;
    out.push(classifyFile(f));
  }
  return out;
}

/**
 * Parse a live PreToolUse hook event into an attachment record, or null
 * when the event isn't a SendUserFile PreToolUse event. Some events use
 * `event` instead of `hook_event_name`.
 * @param {*} event
 * @returns {{ sessionId: string|null, cwd: string|null, toolUseId: string|null, caption: string|null, status: string|null, display: string|null, files: Array }|null}
 */
function parseSendUserFileEvent(event) {
  if (!event || typeof event !== 'object') return null;
  var eventName = event.hook_event_name || event.event;
  if (eventName !== 'PreToolUse' || event.tool_name !== 'SendUserFile') return null;
  var input = (event.tool_input && typeof event.tool_input === 'object') ? event.tool_input : {};
  return {
    sessionId: event.session_id || null,
    cwd: event.cwd || null,
    toolUseId: event.tool_use_id || null,
    caption: typeof input.caption === 'string' ? input.caption : null,
    status: typeof input.status === 'string' ? input.status : null,
    display: typeof input.display === 'string' ? input.display : null,
    files: normalizeFiles(input.files),
  };
}

/**
 * Extract every SendUserFile tool_use block from a session transcript JSONL
 * line into attachment records. Accepts a raw JSON string or an
 * already-parsed object. Non-assistant lines, malformed JSON, and assistant
 * messages with no SendUserFile block all yield []. The transcript carries
 * no `cwd`, so `cwd` is always null in the returned records.
 * @param {string|object} line
 * @returns {Array<{ sessionId: string|null, cwd: string|null, toolUseId: string|null, caption: string|null, status: string|null, display: string|null, files: Array }>}
 */
function extractSendUserFileRecords(line) {
  var entry;
  if (typeof line === 'string') {
    try { entry = JSON.parse(line); } catch (e) { return []; }
  } else if (line && typeof line === 'object') {
    entry = line;
  } else {
    return [];
  }
  if (!entry || entry.type !== 'assistant' || !entry.message) return [];
  var content = entry.message.content;
  if (!Array.isArray(content)) return [];
  var sessionId = entry.sessionId || null;
  var records = [];
  for (var i = 0; i < content.length; i++) {
    var block = content[i];
    if (!block || block.type !== 'tool_use' || block.name !== 'SendUserFile') continue;
    var input = (block.input && typeof block.input === 'object') ? block.input : {};
    records.push({
      sessionId: sessionId,
      cwd: null,
      toolUseId: block.id || null,
      caption: typeof input.caption === 'string' ? input.caption : null,
      status: typeof input.status === 'string' ? input.status : null,
      display: typeof input.display === 'string' ? input.display : null,
      files: normalizeFiles(input.files),
    });
  }
  return records;
}

var DEFAULT_MAX_ATTACHMENTS = 24;

/**
 * Dedupe key for an attachment entry: the file path alone. Two entries for
 * the same path are the same attachment regardless of which tool call or
 * which source (live hook vs. transcript backfill) produced them — those
 * two sources don't share a toolUseId contract (live entries take it from
 * `event.tool_use_id`, which may be absent; backfilled entries take it from
 * the transcript's `block.id`), so keying on toolUseId+path let the same
 * file render twice. `toolUseId` is kept on the entry object as metadata,
 * just not part of the key.
 * @param {{ path?: string }} entry
 * @returns {string}
 */
function attachmentKey(entry) {
  return (entry && entry.path) || '';
}

/**
 * Append `incoming` attachment entries to `existing`, dropping duplicates
 * (by attachmentKey, keeping the most recent occurrence) and capping the
 * result to the `max` most recent entries. Pure — does not mutate
 * `existing` or `incoming`.
 * @param {Array} existing
 * @param {Array} incoming
 * @param {number} [max] - defaults to 24
 * @returns {Array}
 */
function mergeAttachments(existing, incoming, max) {
  var cap = typeof max === 'number' && max > 0 ? max : DEFAULT_MAX_ATTACHMENTS;
  var combined = (existing || []).concat(incoming || []);
  var seen = Object.create(null);
  var deduped = [];
  for (var i = combined.length - 1; i >= 0; i--) {
    var key = attachmentKey(combined[i]);
    if (seen[key]) continue;
    seen[key] = true;
    deduped.unshift(combined[i]);
  }
  return deduped.length > cap ? deduped.slice(deduped.length - cap) : deduped;
}

var api = { classifyFile: classifyFile, parseSendUserFileEvent: parseSendUserFileEvent, extractSendUserFileRecords: extractSendUserFileRecords, mergeAttachments: mergeAttachments };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.UserFileAttachments = api;
}

})();
