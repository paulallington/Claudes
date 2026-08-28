const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { checkAttachmentPath, checkAttachmentOpenPath, isAllowedImageExt, isAllowedOpenExt, mediaTypeFor, extOf } = require('../lib/attachment-file-guard');

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

// Note: these two sibling-prefix tests stay green even under a `path.sep`
// regression in isInsideRoot (e.g. `sepChar` hardcoded wrong) — `rNorm +
// wrongSep` still won't be found in 'C:\tmp\claude-evil\x.png' either way,
// so the refusal still happens for the wrong reason. The separator boundary
// is actually held by the POSITIVE tests below ('accepts a path inside an
// allowed root...', win32 and posix) — those fail if the separator is wrong.
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

test('checkAttachmentOpenPath refuses .bat / .exe / .ps1 candidates', () => {
  const roots = ['C:\\tmp\\claude'];
  const deps = { realpath: (p) => p, stat: () => ({ isFile: () => true, size: 1000 }) };
  for (const name of ['payload.bat', 'payload.exe', 'payload.ps1']) {
    const candidate = 'C:\\tmp\\claude\\' + name;
    assert.equal(isAllowedOpenExt(candidate), false, name);
    const result = checkAttachmentOpenPath(candidate, roots, 'win32', deps);
    assert.equal(result.ok, false, name);
    assert.equal(result.error, 'unsupported extension', name);
  }
});

test('checkAttachmentOpenPath refuses a symlink whose realpath resolves to .bat even though the candidate is .pdf', () => {
  const roots = ['C:\\tmp\\claude'];
  const candidate = 'C:\\tmp\\claude\\report.pdf';
  const result = checkAttachmentOpenPath(candidate, roots, 'win32', {
    realpath: () => 'C:\\tmp\\claude\\payload.bat',
    stat: () => ({ isFile: () => true, size: 1000 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'unsupported extension');
});

test('checkAttachmentOpenPath accepts .html and .png', () => {
  const roots = ['C:\\tmp\\claude'];
  const deps = { realpath: (p) => p, stat: () => ({ isFile: () => true, size: 1000 }) };
  for (const name of ['mockup.html', 'hero.png']) {
    const candidate = 'C:\\tmp\\claude\\' + name;
    assert.equal(isAllowedOpenExt(candidate), true, name);
    const result = checkAttachmentOpenPath(candidate, roots, 'win32', deps);
    assert.equal(result.ok, true, name);
    assert.equal(result.path, path.resolve(candidate));
  }
});

test('extOf resolves extensions using the requested target platform, not the host running the test', () => {
  // This machine's ambient `path` module is win32-flavoured (it treats
  // backslash as a separator even on POSIX-style inputs run here), so a
  // 'win32' target test can't expose the bug — it needs a non-'win32'
  // target to prove extOf isn't secretly using the host's module.
  // path.posix treats backslash as a literal filename character, not a
  // separator, so the "extension" is everything from the last real dot
  // to the end of the string, backslash included.
  assert.equal(extOf('folder.tar\\archive', 'linux'), '.tar\\archive');
  // On a win32 target the same backslash IS a separator, so this is a
  // clean, empty-extension file inside a dotted directory name.
  assert.equal(extOf('folder.tar\\archive', 'win32'), '');
});

test('checkAttachmentOpenPath refuses an NTFS alternate-data-stream suffix on win32 (payload.bat:evil.pdf)', () => {
  // path.win32.extname('payload.bat:evil.pdf') is '.pdf' and
  // fs.realpathSync.native preserves the ':evil.pdf' suffix, so without an
  // explicit colon check this candidate would pass the extension allowlist,
  // containment, AND the realpath re-check.
  const roots = ['C:\\tmp\\claude'];
  const candidate = 'C:\\tmp\\claude\\payload.bat:evil.pdf';
  const result = checkAttachmentOpenPath(candidate, roots, 'win32', {
    realpath: (p) => p,
    stat: () => ({ isFile: () => true, size: 1000 }),
  });
  assert.equal(result.ok, false);
});

test('checkAttachmentPath refuses an NTFS alternate-data-stream suffix on win32', () => {
  const roots = ['C:\\tmp\\claude'];
  const candidate = 'C:\\tmp\\claude\\hero.png:evil.png';
  const result = checkAttachmentPath(candidate, roots, 'win32', {
    realpath: (p) => p,
    stat: () => ({ isFile: () => true, size: 1000 }),
  });
  assert.equal(result.ok, false);
});

test('checkAttachmentOpenPath refuses a path outside every allowed root', () => {
  const result = checkAttachmentOpenPath('C:\\Windows\\evil.pdf', ['C:\\tmp\\claude'], 'win32', {
    realpath: (p) => p,
    stat: () => ({ isFile: () => true, size: 1000 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'outside allowed roots');
});

