const test = require('node:test');
const assert = require('node:assert/strict');
const { tagBackgroundEvent } = require('../lib/voice-background');

test('tags an event whose session_id is in the background set', () => {
  const ids = new Set(['bg-123']);
  const event = { session_id: 'bg-123', hook_event_name: 'Stop' };
  const out = tagBackgroundEvent(event, ids);
  assert.equal(out, event);
  assert.equal(event.__claudesBackground, true);
});

test('does not tag an event whose session_id is not in the set', () => {
  const ids = new Set(['bg-123']);
  const event = { session_id: 'interactive-999', hook_event_name: 'Stop' };
  tagBackgroundEvent(event, ids);
  assert.equal(Object.prototype.hasOwnProperty.call(event, '__claudesBackground'), false);
});

test('leaves an event with no session_id unchanged and does not throw', () => {
  const ids = new Set(['bg-123']);
  const event = { hook_event_name: 'Stop' };
  const out = tagBackgroundEvent(event, ids);
  assert.equal(out, event);
  assert.equal(Object.prototype.hasOwnProperty.call(event, '__claudesBackground'), false);
});

test('returns the input and does not throw for null event or null set', () => {
  assert.equal(tagBackgroundEvent(null, new Set(['x'])), null);
  const event = { session_id: 'bg-123' };
  assert.equal(tagBackgroundEvent(event, null), event);
  assert.equal(Object.prototype.hasOwnProperty.call(event, '__claudesBackground'), false);
});
