const test = require('node:test');
const assert = require('node:assert/strict');
const { recordToEntries, nextAttachments, displayOrder, isVisible, entryViewModel, openLightbox, closeLightbox, clearAttachments } = require('../lib/attachment-strip');

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
