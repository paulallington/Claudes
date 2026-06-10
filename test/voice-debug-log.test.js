const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { appendWithRotation } = require('../lib/voice-debug-log');

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'voice-debug-log-'));
}

test('appends lines in order', () => {
  const dir = freshDir();
  try {
    const file = path.join(dir, 'debug.log');
    appendWithRotation(file, 'first', 0);
    appendWithRotation(file, 'second', 0);
    assert.equal(fs.readFileSync(file, 'utf8'), 'first\nsecond\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rotates to .1 once the file exceeds maxBytes and restarts live file', () => {
  const dir = freshDir();
  try {
    const file = path.join(dir, 'debug.log');
    const maxBytes = 20;
    // Write enough lines to exceed maxBytes; the next append after exceeding rotates.
    appendWithRotation(file, 'aaaaaaaaaa', maxBytes); // 11 bytes
    appendWithRotation(file, 'bbbbbbbbbb', maxBytes); // 22 bytes -> now >= maxBytes
    appendWithRotation(file, 'cccccccccc', maxBytes); // rotation triggers, live file restarts
    const rotated = fs.readFileSync(file + '.1', 'utf8');
    const live = fs.readFileSync(file, 'utf8');
    assert.equal(rotated, 'aaaaaaaaaa\nbbbbbbbbbb\n');
    assert.equal(live, 'cccccccccc\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('second rotation overwrites .1 (only one backup kept)', () => {
  const dir = freshDir();
  try {
    const file = path.join(dir, 'debug.log');
    const maxBytes = 5;
    appendWithRotation(file, 'one', maxBytes);   // 4 bytes < 5
    appendWithRotation(file, 'two', maxBytes);   // 8 bytes >= 5 next time
    appendWithRotation(file, 'three', maxBytes); // rotation -> .1 = one\ntwo\n; live = three\n (6 bytes)
    assert.equal(fs.readFileSync(file + '.1', 'utf8'), 'one\ntwo\n');
    appendWithRotation(file, 'four', maxBytes);  // live >= 5 -> rotation -> .1 overwritten = three\n
    assert.equal(fs.readFileSync(file + '.1', 'utf8'), 'three\n');
    assert.equal(fs.readFileSync(file, 'utf8'), 'four\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('never throws on an unwritable path and returns undefined', () => {
  const bogus = path.join(os.tmpdir(), 'voice-debug-log-nope-' + Date.now(), 'deep', 'debug.log');
  let result;
  assert.doesNotThrow(() => { result = appendWithRotation(bogus, 'line', 100); });
  assert.equal(result, undefined);
});
