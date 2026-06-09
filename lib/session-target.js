/**
 * Pure helpers for deciding whether a Claude session is a usable bind target
 * for a column, and whether a cwd-resolved hook should rebind a column's
 * sessionId.
 *
 * A column must never be (re)bound to a 0-byte session file — that's a stray
 * pinned-but-empty session that voice extraction reads as silence. The only
 * legitimate 0-byte session is a column's OWN freshly --session-id-pinned file
 * before its first message; that's handled by the caller (current-session
 * lookup) and is NOT routed through isUsableSessionTarget.
 */

/**
 * @param {{ size?: number }|null|undefined} session
 * @returns {boolean} true only when the session has on-disk content.
 */
function isUsableSessionTarget(session) {
  return !!(session && session.size > 0);
}

/**
 * Decide whether an incoming hook event should rebind a column's sessionId.
 * Only safe on a UserPromptSubmit fork (the /clear case starts a new id) that
 * resolved to the column via either the UNAMBIGUOUS cwd path (single column for
 * the project) or the dominant-recent-INPUT path (ambiguous cwd disambiguated
 * by recent typing). The sid path already matches, the ambiguous/null cases
 * must not mutate, and a target id already held by a sibling must never be
 * stolen.
 *
 * @param {{ via?: string, isUserPromptSubmit?: boolean, eventSessionId?: string|null, colSessionId?: string|null, claimedBySibling?: boolean }} args
 * @returns {boolean}
 */
function shouldBindHookSession(args) {
  if (!args) return false;
  const { via, isUserPromptSubmit, eventSessionId, colSessionId, claimedBySibling } = args;
  return (via === 'cwd' || via === 'input')
    && !!isUserPromptSubmit
    && !!eventSessionId
    && eventSessionId !== colSessionId
    && !claimedBySibling;
}

/**
 * Pick the dominant-recent-input column for an ambiguous-cwd UserPromptSubmit
 * fork. candidates: [{ colId, lastInputAt }]. Returns colId or null (never
 * guess on a tie or when the most-recent input is stale).
 *
 * @param {Array<{ colId: string, lastInputAt?: number }>|null|undefined} candidates
 * @param {number} now
 * @param {{ gapMs?: number, windowMs?: number }} [opts]
 * @returns {string|null}
 */
function resolveInputColumn(candidates, now, opts) {
  opts = opts || {};
  var gapMs = opts.gapMs == null ? 1500 : opts.gapMs;
  var windowMs = opts.windowMs == null ? 5000 : opts.windowMs;
  var ranked = (candidates || []).slice().sort(function (a, b) { return (b.lastInputAt || 0) - (a.lastInputAt || 0); });
  var top = ranked[0], second = ranked[1];
  if (!top || !top.lastInputAt) return null;
  if (now - top.lastInputAt >= windowMs) return null;
  if (second && (top.lastInputAt - (second.lastInputAt || 0)) <= gapMs) return null;
  return top.colId;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isUsableSessionTarget, shouldBindHookSession, resolveInputColumn };
}
if (typeof window !== 'undefined') {
  window.SessionTarget = { isUsableSessionTarget, shouldBindHookSession, resolveInputColumn };
}
