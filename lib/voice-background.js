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
module.exports = { tagBackgroundEvent };
