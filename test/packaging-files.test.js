// test/packaging-files.test.js
//
// Guards a bug class the rest of the suite is blind to: electron-builder's
// `build.files` is an explicit ALLOWLIST, so a new root-level asset that main
// loads at runtime is silently dropped from app.asar unless it is listed.
// Everything still passes in dev (unpackaged loads straight from the repo) and
// the packaged app opens a blank window with "Not allowed to load local
// resource". That shipped once, in v1.9.60, for codex-watch.html/js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const FILES = (pkg.build && pkg.build.files) || [];

// True when `target` is shipped: either listed verbatim, or covered by a
// directory glob such as `lib/**/*`.
function isPackaged(target) {
  if (FILES.includes(target)) return true;
  return FILES.some((pattern) => {
    const star = pattern.indexOf('**');
    if (star === -1) return false;
    return target.startsWith(pattern.slice(0, star));
  });
}

// Every HTML file main hands to loadFile must exist on disk AND be packaged.
function loadFileTargets() {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const targets = new Set();
  const re = /loadFile\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(main)) !== null) targets.add(m[1]);
  return [...targets];
}

test('every loadFile target in main.js is listed in build.files', () => {
  const targets = loadFileTargets();
  assert.ok(targets.length > 0, 'expected to find at least one loadFile call in main.js');

  const missing = targets.filter((t) => !isPackaged(t));
  assert.deepStrictEqual(
    missing, [],
    'these files are loaded at runtime but excluded from app.asar, so the '
    + 'packaged app will open a blank window: ' + missing.join(', ')
  );
});

test('every loadFile target actually exists on disk', () => {
  const missing = loadFileTargets().filter((t) => !fs.existsSync(path.join(ROOT, t)));
  assert.deepStrictEqual(missing, [], 'loadFile targets missing from the repo: ' + missing.join(', '));
});

test('scripts referenced by packaged HTML pages are themselves packaged', () => {
  const pages = loadFileTargets().filter((t) => t.endsWith('.html'));
  const offenders = [];

  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const re = /<script\s+src="([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const src = m[1].replace(/^\.\//, '');
      // node_modules is shipped wholesale; skip absolute/remote sources.
      if (/^(https?:)?\/\//.test(src)) continue;
      if (!isPackaged(src)) offenders.push(page + ' -> ' + src);
    }
  }

  assert.deepStrictEqual(offenders, [], 'scripts loaded by a packaged page but not packaged: ' + offenders.join(', '));
});
