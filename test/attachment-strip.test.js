const test = require('node:test');
const assert = require('node:assert/strict');
const { recordToEntries, nextAttachments, displayOrder, isVisible, entryViewModel, openLightbox, closeLightbox, clearAttachments, shouldScanSession, backfillAttachments } = require('../lib/attachment-strip');

test('recordToEntries flattens a record\'s files into per-file entries carrying the shared toolUseId/caption', () => {
  const record = {
    toolUseId: 'toolu_1',
    caption: 'Two hero posters',
    files: [
      { path: '/x/one.jpeg', name: 'one.jpeg', ext: 'jpeg', kind: 'image' },
      { path: '/x/two.pdf', name: 'two.pdf', ext: 'pdf', kind: 'file' },
    ],
  };
  assert.deepEqual(recordToEntries(record, 1000), [
    { toolUseId: 'toolu_1', path: '/x/one.jpeg', name: 'one.jpeg', ext: 'jpeg', kind: 'image', caption: 'Two hero posters', addedAt: 1000 },
    { toolUseId: 'toolu_1', path: '/x/two.pdf', name: 'two.pdf', ext: 'pdf', kind: 'file', caption: 'Two hero posters', addedAt: 1000 },
  ]);
});

test('nextAttachments merges a SendUserFile PreToolUse event\'s files onto the existing list', () => {
  const existing = [{ toolUseId: 'a', path: '/x/old.png', name: 'old.png', ext: 'png', kind: 'image', caption: null, addedAt: 500 }];
  const event = {
    hook_event_name: 'PreToolUse',
    tool_name: 'SendUserFile',
    tool_use_id: 'toolu_2',
    tool_input: { files: ['/x/new.png'], caption: 'new one' },
  };
  const result = nextAttachments(existing, event, { now: 2000 });
  assert.deepEqual(result, [
    { toolUseId: 'a', path: '/x/old.png', name: 'old.png', ext: 'png', kind: 'image', caption: null, addedAt: 500 },
    { toolUseId: 'toolu_2', path: '/x/new.png', name: 'new.png', ext: 'png', kind: 'image', caption: 'new one', addedAt: 2000 },
  ]);
});

test('nextAttachments returns the same array reference for a non-SendUserFile event so callers can skip re-rendering', () => {
  const existing = [{ toolUseId: 'a', path: '/x/old.png', name: 'old.png', ext: 'png', kind: 'image', caption: null, addedAt: 500 }];
  const result = nextAttachments(existing, { hook_event_name: 'PostToolUse', tool_name: 'Read' });
  assert.equal(result, existing);
});

test('displayOrder reverses the list so the newest attachment renders first (left)', () => {
  const attachments = [{ path: '/1' }, { path: '/2' }, { path: '/3' }];
  assert.deepEqual(displayOrder(attachments), [{ path: '/3' }, { path: '/2' }, { path: '/1' }]);
  // does not mutate the input
  assert.deepEqual(attachments, [{ path: '/1' }, { path: '/2' }, { path: '/3' }]);
});

test('isVisible is true only when there is at least one attachment', () => {
  assert.equal(isVisible([]), false);
  assert.equal(isVisible(null), false);
  assert.equal(isVisible(undefined), false);
  assert.equal(isVisible([{ path: '/1' }]), true);
});

test('entryViewModel marks image entries for a thumbnail read and builds a "name — caption" hover title', () => {
  const entry = { path: '/x/hero.jpeg', name: 'hero.jpeg', ext: 'jpeg', kind: 'image', caption: 'The reworked mobile hero', addedAt: 1000 };
  assert.deepEqual(entryViewModel(entry), {
    path: '/x/hero.jpeg',
    name: 'hero.jpeg',
    kind: 'image',
    isImage: true,
    chipLabel: null,
    caption: 'The reworked mobile hero',
    title: 'hero.jpeg — The reworked mobile hero',
  });
});

test('entryViewModel builds an uppercase extension chip for non-image entries and falls back to the plain filename title with no caption', () => {
  const entry = { path: '/x/mockup.html', name: 'mockup.html', ext: 'html', kind: 'file', caption: null, addedAt: 1000 };
  const vm = entryViewModel(entry);
  assert.equal(vm.isImage, false);
  assert.equal(vm.chipLabel, 'HTML');
  assert.equal(vm.title, 'mockup.html');
});

test('openLightbox/closeLightbox produce the lightbox overlay state', () => {
  const entry = { path: '/x/hero.jpeg', name: 'hero.jpeg' };
  assert.deepEqual(openLightbox(entry), { open: true, entry: entry });
  assert.deepEqual(closeLightbox(), { open: false, entry: null });
});

test('clearAttachments returns an empty list without touching the source array', () => {
  const existing = [{ path: '/1' }];
  assert.deepEqual(clearAttachments(existing), []);
  assert.deepEqual(existing, [{ path: '/1' }]);
});

test('shouldScanSession is true for a Claude column with a session id not yet scanned', () => {
  assert.equal(shouldScanSession({ cmd: null, attachmentsScannedFor: null }, 'sess-1'), true);
});

test('shouldScanSession is false once already scanned for that exact session id', () => {
  assert.equal(shouldScanSession({ cmd: null, attachmentsScannedFor: 'sess-1' }, 'sess-1'), false);
});

test('shouldScanSession allows exactly one more scan when the session id changes (a /clear fork)', () => {
  assert.equal(shouldScanSession({ cmd: null, attachmentsScannedFor: 'sess-1' }, 'sess-2'), true);
});

test('shouldScanSession is false for codex/arbitrary-cmd columns, which have no Claude transcript', () => {
  assert.equal(shouldScanSession({ cmd: 'codex', attachmentsScannedFor: null }, 'sess-1'), false);
  assert.equal(shouldScanSession({ cmd: 'some-other-cmd', attachmentsScannedFor: null }, 'sess-1'), false);
});

test('shouldScanSession is false without a usable session id or column', () => {
  assert.equal(shouldScanSession({ cmd: null }, null), false);
  assert.equal(shouldScanSession({ cmd: null }, undefined), false);
  assert.equal(shouldScanSession(null, 'sess-1'), false);
});

test('backfillAttachments merges scanned transcript records in as OLDER than the existing (live) attachments', () => {
  const existing = [{ toolUseId: 'live1', path: '/x/live.png', name: 'live.png', ext: 'png', kind: 'image', caption: null, addedAt: 5000 }];
  const records = [
    { toolUseId: 'toolu_a', caption: 'old batch', files: [{ path: '/x/old1.png', name: 'old1.png', ext: 'png', kind: 'image' }] },
  ];
  const result = backfillAttachments(existing, records, { now: 1000 });
  assert.deepEqual(result, [
    { toolUseId: 'toolu_a', path: '/x/old1.png', name: 'old1.png', ext: 'png', kind: 'image', caption: 'old batch', addedAt: 1000 },
    { toolUseId: 'live1', path: '/x/live.png', name: 'live.png', ext: 'png', kind: 'image', caption: null, addedAt: 5000 },
  ]);
});

test('backfillAttachments is idempotent — scanning the same session twice adds nothing new', () => {
  const records = [
    { toolUseId: 'toolu_a', caption: null, files: [{ path: '/x/old1.png', name: 'old1.png', ext: 'png', kind: 'image' }] },
  ];
  const first = backfillAttachments([], records, { now: 1000 });
  const second = backfillAttachments(first, records, { now: 2000 });
  assert.deepEqual(second, first);
});

test('backfillAttachments returns the same existing reference when there are no records to backfill', () => {
  const existing = [{ path: '/1' }];
  assert.equal(backfillAttachments(existing, []), existing);
  assert.equal(backfillAttachments(existing, null), existing);
});
