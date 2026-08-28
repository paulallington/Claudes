const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyFile, parseSendUserFileEvent, extractSendUserFileRecords, mergeAttachments } = require('../lib/user-file-attachments');

test('classifyFile splits a Windows path into name/ext/kind', () => {
  assert.deepEqual(
    classifyFile('C:\\Users\\paul\\Git\\The Code Zone\\scratchpad\\hero-poster-home.jpeg'),
    { path: 'C:\\Users\\paul\\Git\\The Code Zone\\scratchpad\\hero-poster-home.jpeg', name: 'hero-poster-home.jpeg', ext: 'jpeg', kind: 'image' }
  );
});

test('parseSendUserFileEvent parses a live PreToolUse hook event', () => {
  const event = {
    hook_event_name: 'PreToolUse',
    tool_name: 'SendUserFile',
    session_id: '87afb11c-057d-46e2-bff6-608f27e4451b',
    cwd: 'C:\\Users\\paul\\Git\\The Code Zone',
    tool_use_id: 'toolu_01TCEo78SGbh5b25ASvWxmHd',
    tool_input: {
      files: [
        'C:\\Users\\paul\\Git\\The Code Zone\\scratchpad\\hero-poster-home.jpeg',
        'C:\\Users\\paul\\Git\\The Code Zone\\scratchpad\\hero-poster-codingclubs.jpeg',
      ],
      caption: "The reworked mobile hero: one poster panel in the page's outfit colour.",
      status: 'normal',
      display: 'attach',
    },
  };
  assert.deepEqual(parseSendUserFileEvent(event), {
    sessionId: '87afb11c-057d-46e2-bff6-608f27e4451b',
    cwd: 'C:\\Users\\paul\\Git\\The Code Zone',
    toolUseId: 'toolu_01TCEo78SGbh5b25ASvWxmHd',
    caption: "The reworked mobile hero: one poster panel in the page's outfit colour.",
    status: 'normal',
    display: 'attach',
    files: [
      { path: 'C:\\Users\\paul\\Git\\The Code Zone\\scratchpad\\hero-poster-home.jpeg', name: 'hero-poster-home.jpeg', ext: 'jpeg', kind: 'image' },
      { path: 'C:\\Users\\paul\\Git\\The Code Zone\\scratchpad\\hero-poster-codingclubs.jpeg', name: 'hero-poster-codingclubs.jpeg', ext: 'jpeg', kind: 'image' },
    ],
  });
});

test('extractSendUserFileRecords parses a SendUserFile tool_use block from a transcript line', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_01TCEo78SGbh5b25ASvWxmHd',
          name: 'SendUserFile',
          input: {
            files: ['C:\\Users\\paul\\Git\\The Code Zone\\hero-poster-home.jpeg'],
            caption: 'caption text',
            status: 'normal',
          },
        },
      ],
    },
    sessionId: '87afb11c-057d-46e2-bff6-608f27e4451b',
    timestamp: '2026-08-28T07:32:42.711Z',
  });
  assert.deepEqual(extractSendUserFileRecords(line), [
    {
      sessionId: '87afb11c-057d-46e2-bff6-608f27e4451b',
      cwd: null,
      toolUseId: 'toolu_01TCEo78SGbh5b25ASvWxmHd',
      caption: 'caption text',
      status: 'normal',
      display: null,
      files: [
        { path: 'C:\\Users\\paul\\Git\\The Code Zone\\hero-poster-home.jpeg', name: 'hero-poster-home.jpeg', ext: 'jpeg', kind: 'image' },
      ],
    },
  ]);
});

test('mergeAttachments appends incoming to existing without duplicating a repeated toolUseId+path', () => {
  const existing = [{ toolUseId: 'a', path: '/x/one.png' }];
  const incoming = [{ toolUseId: 'a', path: '/x/one.png' }, { toolUseId: 'b', path: '/x/two.png' }];
  assert.deepEqual(mergeAttachments(existing, incoming), [
    { toolUseId: 'a', path: '/x/one.png' },
    { toolUseId: 'b', path: '/x/two.png' },
  ]);
});

test('classifyFile handles POSIX paths, non-image extensions, and no extension', () => {
  assert.deepEqual(classifyFile('/home/paul/report.pdf'), { path: '/home/paul/report.pdf', name: 'report.pdf', ext: 'pdf', kind: 'file' });
  assert.deepEqual(classifyFile('/home/paul/README'), { path: '/home/paul/README', name: 'README', ext: '', kind: 'file' });
  assert.deepEqual(classifyFile('/home/paul/.gitignore'), { path: '/home/paul/.gitignore', name: '.gitignore', ext: '', kind: 'file' });
});

test('classifyFile recognizes every documented image extension case-insensitively', () => {
  ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].forEach((ext) => {
    assert.equal(classifyFile(`/x/pic.${ext.toUpperCase()}`).kind, 'image');
  });
});

test('parseSendUserFileEvent returns null for a non-PreToolUse or non-SendUserFile event', () => {
  assert.equal(parseSendUserFileEvent(null), null);
  assert.equal(parseSendUserFileEvent({}), null);
  assert.equal(parseSendUserFileEvent({ hook_event_name: 'PostToolUse', tool_name: 'SendUserFile' }), null);
  assert.equal(parseSendUserFileEvent({ hook_event_name: 'PreToolUse', tool_name: 'Read' }), null);
});

test('parseSendUserFileEvent accepts the `event` field as an alias for `hook_event_name`', () => {
  const result = parseSendUserFileEvent({ event: 'PreToolUse', tool_name: 'SendUserFile' });
  assert.notEqual(result, null);
  assert.deepEqual(result.files, []);
});

test('parseSendUserFileEvent tolerates a missing tool_input and defaults optional fields to null', () => {
  const result = parseSendUserFileEvent({ hook_event_name: 'PreToolUse', tool_name: 'SendUserFile' });
  assert.deepEqual(result, {
    sessionId: null,
    cwd: null,
    toolUseId: null,
    caption: null,
    status: null,
    display: null,
    files: [],
  });
});

test('parseSendUserFileEvent normalizes a bare string files value and dedupes repeated paths', () => {
  const result = parseSendUserFileEvent({
    hook_event_name: 'PreToolUse',
    tool_name: 'SendUserFile',
    tool_input: { files: '/x/one.png' },
  });
  assert.deepEqual(result.files, [{ path: '/x/one.png', name: 'one.png', ext: 'png', kind: 'image' }]);

  const deduped = parseSendUserFileEvent({
    hook_event_name: 'PreToolUse',
    tool_name: 'SendUserFile',
    tool_input: { files: ['/x/one.png', 42, null, '/x/one.png', '/x/two.pdf'] },
  });
  assert.deepEqual(deduped.files, [
    { path: '/x/one.png', name: 'one.png', ext: 'png', kind: 'image' },
    { path: '/x/two.pdf', name: 'two.pdf', ext: 'pdf', kind: 'file' },
  ]);
});

test('extractSendUserFileRecords returns [] for non-assistant lines, malformed JSON, and tool_result/non-SendUserFile blocks', () => {
  assert.deepEqual(extractSendUserFileRecords('not json'), []);
  assert.deepEqual(extractSendUserFileRecords(JSON.stringify({ type: 'user', message: { content: [] } })), []);
  assert.deepEqual(extractSendUserFileRecords(JSON.stringify({ type: 'attachment' })), []);
  assert.deepEqual(
    extractSendUserFileRecords(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_result', tool_use_id: 'x' }, { type: 'tool_use', name: 'Read', id: 'y', input: {} }] },
    })),
    []
  );
});

test('extractSendUserFileRecords accepts an already-parsed object and yields one record per SendUserFile block', () => {
  const entry = {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'SendUserFile', input: { files: ['/a.png'] } },
        { type: 'text', text: 'here you go' },
        { type: 'tool_use', id: 'toolu_2', name: 'SendUserFile', input: { files: ['/b.pdf'], display: 'attach' } },
      ],
    },
    sessionId: 'sid-1',
  };
  const records = extractSendUserFileRecords(entry);
  assert.equal(records.length, 2);
  assert.equal(records[0].toolUseId, 'toolu_1');
  assert.equal(records[1].toolUseId, 'toolu_2');
  assert.equal(records[1].display, 'attach');
});

test('mergeAttachments dedupes by path alone when toolUseId is absent', () => {
  const existing = [{ path: '/x/one.png' }];
  const incoming = [{ path: '/x/one.png' }, { path: '/x/two.png' }];
  assert.deepEqual(mergeAttachments(existing, incoming), [{ path: '/x/one.png' }, { path: '/x/two.png' }]);
});

test('mergeAttachments caps to the max most recent entries, dropping from the front', () => {
  const existing = [{ path: '/1' }, { path: '/2' }, { path: '/3' }];
  const incoming = [{ path: '/4' }];
  assert.deepEqual(mergeAttachments(existing, incoming, 2), [{ path: '/3' }, { path: '/4' }]);
});

test('mergeAttachments defaults max to 24', () => {
  const existing = Array.from({ length: 24 }, (_, i) => ({ path: `/${i}` }));
  const incoming = [{ path: '/new' }];
  const result = mergeAttachments(existing, incoming);
  assert.equal(result.length, 24);
  assert.equal(result[0].path, '/1');
  assert.equal(result[23].path, '/new');
});

test('mergeAttachments does not mutate existing', () => {
  const existing = [{ path: '/1' }];
  const existingCopy = existing.slice();
  mergeAttachments(existing, [{ path: '/2' }]);
  assert.deepEqual(existing, existingCopy);
});

test('mergeAttachments dedupes the same path across a null-toolUseId live entry and a toolUseId-bearing transcript entry', () => {
  // Live hook entries may carry no toolUseId at all, while a later transcript
  // backfill for the identical file carries one — same attachment, must
  // collapse to a single thumbnail regardless of which source produced it.
  const existing = [{ path: '/a.png', toolUseId: null }];
  const incoming = [{ path: '/a.png', toolUseId: 't1' }];
  const result = mergeAttachments(existing, incoming);
  assert.equal(result.length, 1);
  assert.deepEqual(result, [{ path: '/a.png', toolUseId: 't1' }]);
});

test('mergeAttachments floats a re-sent path to the newest position', () => {
  const existing = [{ path: '/a.png', toolUseId: 't1' }, { path: '/b.png', toolUseId: 't2' }];
  const incoming = [{ path: '/a.png', toolUseId: 't3' }];
  assert.deepEqual(mergeAttachments(existing, incoming), [
    { path: '/b.png', toolUseId: 't2' },
    { path: '/a.png', toolUseId: 't3' },
  ]);
});

test('mergeAttachments and classifyFile do not fall prey to prototype pollution via a __proto__ path', () => {
  const result = mergeAttachments([{ path: '__proto__' }], [{ path: '__proto__' }]);
  assert.deepEqual(result, [{ path: '__proto__' }]);
  assert.deepEqual(classifyFile('/x/a.constructor').kind, 'file');
});
