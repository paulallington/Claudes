/**
 * Pure view-model/state helpers for the per-column attachment strip: the
 * thumbnail row pinned under the column header showing files Claude has
 * handed the user via the SendUserFile tool. lib/user-file-attachments.js
 * parses the raw hook event / transcript line into records; this module
 * turns those records into the strip's list state and each entry's render
 * info. No DOM, no fs — renderer.js owns wiring, this module owns the logic.
 */

var UserFileAttachments = (typeof require !== 'undefined')
  ? require('./user-file-attachments')
  : (typeof window !== 'undefined' ? window.UserFileAttachments : null);

/**
 * Flatten a parsed SendUserFile record (parseSendUserFileEvent /
 * extractSendUserFileRecords) into per-file strip entries ready for
 * mergeAttachments. One record can carry several files from a single tool
 * call; each becomes its own entry, sharing the record's toolUseId/caption.
 * @param {{toolUseId?: string|null, caption?: string|null, files: Array}} record
 * @param {number} [now] - defaults to Date.now()
 * @returns {Array<{toolUseId: string|null, path: string, name: string, ext: string, kind: string, caption: string|null, addedAt: number}>}
 */
function recordToEntries(record, now) {
  if (!record || !Array.isArray(record.files) || !record.files.length) return [];
  var ts = typeof now === 'number' ? now : Date.now();
  return record.files.map(function (f) {
    return {
      toolUseId: record.toolUseId || null,
      path: f.path,
      name: f.name,
      ext: f.ext,
      kind: f.kind,
      caption: record.caption || null,
      addedAt: ts,
    };
  });
}

/**
 * Reduce a live hook event into the column's next attachment list. Returns
 * the SAME `existing` array reference when the event isn't a SendUserFile
 * PreToolUse event (so callers can cheaply skip a re-render), otherwise a
 * new merged array — `existing` is never mutated.
 * @param {Array} existing
 * @param {*} event - raw hook event, as delivered by onHookEvent
 * @param {{now?: number, max?: number}} [opts]
 * @returns {Array}
 */
function nextAttachments(existing, event, opts) {
  if (!UserFileAttachments || typeof UserFileAttachments.parseSendUserFileEvent !== 'function') return existing || [];
  var record = UserFileAttachments.parseSendUserFileEvent(event);
  if (!record || !record.files.length) return existing || [];
  var now = (opts && typeof opts.now === 'number') ? opts.now : undefined;
  var max = (opts && typeof opts.max === 'number') ? opts.max : undefined;
  var incoming = recordToEntries(record, now);
  return UserFileAttachments.mergeAttachments(existing, incoming, max);
}

/**
 * Newest-first display order — the strip renders left-to-right with the
 * most recent attachment on the left. Does not mutate the input.
 * @param {Array} attachments
 * @returns {Array}
 */
function displayOrder(attachments) {
  return (attachments || []).slice().reverse();
}

/**
 * Whether the strip should render at all. The strip is hidden entirely
 * (zero height, no border) rather than shown empty.
 * @param {Array} attachments
 * @returns {boolean}
 */
function isVisible(attachments) {
  return !!(attachments && attachments.length > 0);
}

/**
 * Per-entry render info: whether it's an image (needs a thumbnail read via
 * electronAPI.readAttachmentImage) or a generic file (renders as a compact
 * extension chip, no image read attempted), plus the hover title combining
 * the filename and the batch caption.
 * @param {{path: string, name: string, ext: string, kind: string, caption?: string|null}} entry
 * @returns {{path: string, name: string, kind: string, isImage: boolean, chipLabel: string|null, caption: string, title: string}}
 */
function entryViewModel(entry) {
  var name = (entry && entry.name) || '';
  var caption = (entry && entry.caption) || '';
  var isImage = !!(entry && entry.kind === 'image');
  var ext = (entry && entry.ext) || '';
  return {
    path: (entry && entry.path) || '',
    name: name,
    kind: (entry && entry.kind) || 'file',
    isImage: isImage,
    chipLabel: isImage ? null : (ext.toUpperCase() || 'FILE'),
    caption: caption,
    title: caption ? (name + ' — ' + caption) : name,
  };
}

/**
 * Lightbox overlay state for a clicked entry (full image, caption,
 * Open / Reveal-in-folder actions).
 * @param {Object} entry
 * @returns {{open: boolean, entry: Object}}
 */
function openLightbox(entry) {
  return { open: true, entry: entry || null };
}

/** @returns {{open: boolean, entry: null}} */
function closeLightbox() {
  return { open: false, entry: null };
}

/**
 * Dismiss control: clears the column's strip. State only — never touches
 * files on disk.
 * @returns {Array}
 */
function clearAttachments() {
  return [];
}

/**
 * Once-per-session guard for the transcript backfill scan: a full scan
 * costs ~700ms of main-process work, so it must fire at most once per
 * column per sessionId — never on focus, re-render, or repeated polls.
 * Returns true again if `sessionId` differs from the last id scanned (a
 * `/clear` fork), allowing exactly one more scan for the new id. Codex and
 * arbitrary-`cmd` columns carry no Claude transcript to scan.
 * @param {{cmd?: string|null, attachmentsScannedFor?: string|null}} colData
 * @param {string|null|undefined} sessionId
 * @returns {boolean}
 */
function shouldScanSession(colData, sessionId) {
  if (!colData || !sessionId) return false;
  if (colData.cmd) return false;
  return colData.attachmentsScannedFor !== sessionId;
}

/**
 * Turn a batch of scanned transcript records (oldest-first, from
 * scanSessionAttachments) into strip entries and merge them onto the
 * column's current attachment list. Backfilled entries are always OLDER
 * than anything already live, so they merge in as the base list with the
 * live attachments layered on top — never the other way around, or history
 * would jump to the front of the newest-first display order.
 * @param {Array} existingAttachments - the column's current (live) list
 * @param {Array} records - grouped records from scanSessionAttachments
 * @param {{now?: number, max?: number}} [opts]
 * @returns {Array}
 */
function backfillAttachments(existingAttachments, records, opts) {
  if (!Array.isArray(records) || !records.length) return existingAttachments || [];
  var now = (opts && typeof opts.now === 'number') ? opts.now : undefined;
  var max = (opts && typeof opts.max === 'number') ? opts.max : undefined;
  var backfilled = [];
  for (var i = 0; i < records.length; i++) {
    backfilled = backfilled.concat(recordToEntries(records[i], now));
  }
  if (!backfilled.length) return existingAttachments || [];
  if (!UserFileAttachments || typeof UserFileAttachments.mergeAttachments !== 'function') {
    return (existingAttachments || []).length ? existingAttachments : backfilled;
  }
  return UserFileAttachments.mergeAttachments(backfilled, existingAttachments, max);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { recordToEntries, nextAttachments, displayOrder, isVisible, entryViewModel, openLightbox, closeLightbox, clearAttachments, shouldScanSession, backfillAttachments };
}
if (typeof window !== 'undefined') {
  window.AttachmentStrip = { recordToEntries, nextAttachments, displayOrder, isVisible, entryViewModel, openLightbox, closeLightbox, clearAttachments, shouldScanSession, backfillAttachments };
}
