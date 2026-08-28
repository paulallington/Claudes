const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { checkAttachmentPath, isAllowedImageExt, mediaTypeFor } = require('../lib/attachment-file-guard');

test('checkAttachmentPath accepts a path inside an allowed root with an allowed extension', () => {
  const roots = ['C:\\Users\\paul\\.claudes'];
  const candidate = 'C:\\Users\\paul\\.claudes\\hero.png';
  const result = checkAttachmentPath(candidate, roots, 'win32', {
    realpath: (p) => p,
    stat: () => ({ isFile: () => true, size: 1000 }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.path, path.resolve(candidate));
});

test('checkAttachmentPath refuses a UNC path', () => {
  const result = checkAttachmentPath('\\\\server\\share\\hero.png', ['C:\\Users\\paul\\.claudes'], 'win32', {
    realpath: (p) => p,
    stat: () => ({ isFile: () => true, size: 1000 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'UNC path');
});

test('checkAttachmentPath refuses a path outside every allowed root', () => {
  const result = checkAttachmentPath('C:\\Windows\\evil.png', ['C:\\Users\\paul\\.claudes'], 'win32', {
    realpath: (p) => p,
    stat: () => ({ isFile: () => true, size: 1000 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'outside allowed roots');
});

test('checkAttachmentPath refuses a symlink that realpath-resolves outside every allowed root', () => {
  const roots = ['C:\\Users\\paul\\.claudes'];
  const candidate = 'C:\\Users\\paul\\.claudes\\link.png';
  const result = checkAttachmentPath(candidate, roots, 'win32', {
    realpath: () => 'C:\\Windows\\secret.png',
    stat: () => ({ isFile: () => true, size: 1000 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'outside allowed roots');
});

test('checkAttachmentPath and isAllowedImageExt refuse a disallowed extension (e.g. svg)', () => {
  const roots = ['C:\\Users\\paul\\.claudes'];
  const candidate = 'C:\\Users\\paul\\.claudes\\hero.svg';
  assert.equal(isAllowedImageExt(candidate), false);
  const result = checkAttachmentPath(candidate, roots, 'win32', {
    realpath: (p) => p,
    stat: () => ({ isFile: () => true, size: 1000 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'unsupported extension');
});

test('isAllowedImageExt and mediaTypeFor are case-insensitive', () => {
  assert.equal(isAllowedImageExt('C:\\shot.JPG'), true);
  assert.equal(mediaTypeFor('C:\\shot.JPG'), 'image/jpeg');
  assert.equal(mediaTypeFor('C:\\shot.PNG'), 'image/png');
});

test('checkAttachmentPath containment is case-insensitive on win32', () => {
  const roots = ['C:\\Users\\paul\\.claudes'];
  const candidate = 'c:\\users\\paul\\.claudes\\HERO.png';
  const result = checkAttachmentPath(candidate, roots, 'win32', {
    realpath: (p) => p,
    stat: () => ({ isFile: () => true, size: 1000 }),
  });
  assert.equal(result.ok, true);
});

test('checkAttachmentPath refuses a directory (stat.isFile() false)', () => {
  const roots = ['C:\\Users\\paul\\.claudes'];
  const candidate = 'C:\\Users\\paul\\.claudes\\notafile.png';
  const result = checkAttachmentPath(candidate, roots, 'win32', {
    realpath: (p) => p,
    stat: () => ({ isFile: () => false, size: 0 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not a file');
});

test('checkAttachmentPath refuses a file over the 8MB size cap', () => {
  const roots = ['C:\\Users\\paul\\.claudes'];
  const candidate = 'C:\\Users\\paul\\.claudes\\huge.png';
  const result = checkAttachmentPath(candidate, roots, 'win32', {
    realpath: (p) => p,
    stat: () => ({ isFile: () => true, size: 8 * 1024 * 1024 + 1 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'too large');
});

test('checkAttachmentPath never leaks the resolved path in a refusal error', () => {
  const result = checkAttachmentPath('C:\\Windows\\secret.png', ['C:\\Users\\paul\\.claudes'], 'win32', {
    realpath: (p) => p,
    stat: () => ({ isFile: () => true, size: 1000 }),
  });
  assert.equal(result.ok, false);
  assert.equal(/secret|Windows/i.test(result.error), false);
});

test('checkAttachmentPath refuses a sibling directory with the root as a name prefix (win32)', () => {
  const roots = ['C:\\tmp\\claude'];
  const candidate = 'C:\\tmp\\claude-evil\\x.png';
  const result = checkAttachmentPath(candidate, roots, 'win32', {
    realpath: (p) => p,
    stat: () => ({ isFile: () => true, size: 1000 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'outside allowed roots');
});

test('checkAttachmentPath refuses a sibling directory with the root as a name prefix (posix)', () => {
  const roots = ['/tmp/claude'];
  const candidate = '/tmp/claude-evil/x.png';
  const result = checkAttachmentPath(candidate, roots, 'linux', {
    realpath: (p) => p,
    stat: () => ({ isFile: () => true, size: 1000 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'outside allowed roots');
});

test('checkAttachmentPath accepts a path inside an allowed root on posix', () => {
  const roots = ['/tmp/claude'];
  const candidate = '/tmp/claude/hero.png';
  const result = checkAttachmentPath(candidate, roots, 'linux', {
    realpath: (p) => p,
    stat: () => ({ isFile: () => true, size: 1000 }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.path, path.posix.resolve(candidate));
});

test('checkAttachmentPath refuses a symlink whose realpath resolves to a disallowed extension, even though containment passes', () => {
  const roots = ['C:\\tmp\\claude', 'C:\\Users\\paul\\.claude'];
  const candidate = 'C:\\tmp\\claude\\x.png';
  const result = checkAttachmentPath(candidate, roots, 'win32', {
    realpath: () => 'C:\\Users\\paul\\.claude\\.credentials.json',
    stat: () => ({ isFile: () => true, size: 1000 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'unsupported extension');
});

