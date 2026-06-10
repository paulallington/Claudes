const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { atomicWriteJson, readJsonWithRecovery } = require('../lib/config-io');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'config-io-'));
}

test('atomicWriteJson round-trips and leaves no temp file', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'config.json');
    const obj = { projects: [{ name: 'a' }], activeProjectIndex: 0, nested: { x: [1, 2, 3] } };
    atomicWriteJson(file, obj);
    const back = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(back, obj);
    const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atomicWriteJson rolls the previous file aside to .bak', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'config.json');
    const v1 = { version: 1 };
    const v2 = { version: 2 };
    atomicWriteJson(file, v1);
    atomicWriteJson(file, v2);
    assert.ok(fs.existsSync(file + '.bak'));
    assert.deepEqual(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')), v1);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), v2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readJsonWithRecovery recovers from .bak when the real file is corrupt', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'config.json');
    const good = { projects: ['p1'] };
    atomicWriteJson(file, good); // first write (no .bak yet)
    atomicWriteJson(file, good); // second write rolls .bak into existence
    fs.writeFileSync(file, '{ broken', 'utf8');
    const res = readJsonWithRecovery(file);
    assert.deepEqual(res.data, good);
    assert.equal(res.recovered, true);
    const corrupt = fs.readdirSync(dir).filter((n) => n.includes('.corrupt-'));
    assert.equal(corrupt.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readJsonWithRecovery returns null and quarantines when corrupt with no .bak', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '{ broken', 'utf8');
    const res = readJsonWithRecovery(file);
    assert.deepEqual(res, { data: null, recovered: true });
    const corrupt = fs.readdirSync(dir).filter((n) => n.includes('.corrupt-'));
    assert.equal(corrupt.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readJsonWithRecovery on a missing file returns null without quarantining, and atomicWriteJson creates it with no .bak', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'config.json');
    const res = readJsonWithRecovery(file);
    assert.deepEqual(res, { data: null, recovered: true });
    const corrupt = fs.readdirSync(dir).filter((n) => n.includes('.corrupt-'));
    assert.equal(corrupt.length, 0);

    atomicWriteJson(file, { fresh: true });
    assert.ok(fs.existsSync(file));
    assert.ok(!fs.existsSync(file + '.bak'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
