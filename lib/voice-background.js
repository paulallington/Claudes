// Mark hook events that belong to invisible background runs (headless,
// automation agents, managers) so the renderer can drop them before they
// drive/arm voice on a real column. Mutates+returns the event for convenience.
function tagBackgroundEvent(event, backgroundSessionIds) {
  if (event && event.session_id && backgroundSessionIds && typeof backgroundSessionIds.has === 'function'
      && backgroundSessionIds.has(event.session_id)) {
    event.__claudesBackground = true;
  }
  return event;
}
// Decide whether a hook event that resolved to a column (via cwd fallback)
// belongs to an invisible background run and should be dropped. Only drop when
// the event is background-tagged AND its session id does NOT match the column's
// own session — a sid match means the column genuinely owns this turn.
function shouldDropBackgroundEvent(event, sidMatchesColumn) {
  return !!(event && event.__claudesBackground && !sidMatchesColumn);
}

module.exports = { tagBackgroundEvent, shouldDropBackgroundEvent };

if (typeof window !== 'undefined') {
  window.VoiceBackground = { tagBackgroundEvent, shouldDropBackgroundEvent };
}
