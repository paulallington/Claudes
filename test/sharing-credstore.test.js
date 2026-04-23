'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCredStore } = require('../lib/sharing-credstore');

function makeFakeSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from('enc:' + plain, 'utf8'),
    decryptString: (buf) => {
      const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : buf;
      if (!s.startsWith('enc:')) throw new Error('not encrypted');
      return s.slice(4);
    },
  };
}

function makeFakeFs() {
  const files = new Map();
  return {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error('ENOENT');
      return files.get(p);
    },
    writeFileSync: (p, data) => {
      files.set(p, Buffer.isBuffer(data) ? data : Buffer.from(data));
    },
    unlinkSync: (p) => {
      files.delete(p);
    },
    mkdirSync: () => {},
    _files: files,
  };
}

test('createCredStore: write then read round-trips', () => {
  const store = createCredStore({
    safeStorage: makeFakeSafeStorage(),
    fs: makeFakeFs(),
    filePath: '/fake/shared-creds.enc',
  });
  store.write({ connectionString: 'mongodb://host/', dbName: 'Claudes' });
  const out = store.read();
  assert.deepEqual(out, { connectionString: 'mongodb://host/', dbName: 'Claudes' });
});

test('createCredStore: read returns null when file absent', () => {
  const store = createCredStore({
    safeStorage: makeFakeSafeStorage(),
    fs: makeFakeFs(),
    filePath: '/fake/shared-creds.enc',
  });
  assert.equal(store.read(), null);
});

test('createCredStore: clear removes the file', () => {
  const fakeFs = makeFakeFs();
  const store = createCredStore({
    safeStorage: makeFakeSafeStorage(),
    fs: fakeFs,
    filePath: '/fake/shared-creds.enc',
  });
  store.write({ connectionString: 'mongodb://host/', dbName: 'Claudes' });
  assert.equal(store.read() !== null, true);
  store.clear();
  assert.equal(store.read(), null);
  assert.equal(fakeFs._files.has('/fake/shared-creds.enc'), false);
});

test('createCredStore: clear is a no-op when file absent', () => {
  const store = createCredStore({
    safeStorage: makeFakeSafeStorage(),
    fs: makeFakeFs(),
    filePath: '/fake/shared-creds.enc',
  });
  store.clear();
  // Should not throw.
  assert.equal(store.read(), null);
});

test('createCredStore: write rejects when safeStorage unavailable', () => {
  const store = createCredStore({
    safeStorage: makeFakeSafeStorage({ available: false }),
    fs: makeFakeFs(),
    filePath: '/fake/shared-creds.enc',
  });
  assert.throws(
    () => store.write({ connectionString: 'mongodb://host/', dbName: 'Claudes' }),
    /encryption is not available/i
  );
});

test('createCredStore: read returns null on corrupted file', () => {
  const fakeFs = makeFakeFs();
  fakeFs.writeFileSync('/fake/shared-creds.enc', Buffer.from('garbage-not-encrypted'));
  const store = createCredStore({
    safeStorage: makeFakeSafeStorage(),
    fs: fakeFs,
    filePath: '/fake/shared-creds.enc',
  });
  assert.equal(store.read(), null);
});

test('createCredStore: isAvailable reflects safeStorage', () => {
  const ok = createCredStore({
    safeStorage: makeFakeSafeStorage({ available: true }),
    fs: makeFakeFs(),
    filePath: '/fake/shared-creds.enc',
  });
  const no = createCredStore({
    safeStorage: makeFakeSafeStorage({ available: false }),
    fs: makeFakeFs(),
    filePath: '/fake/shared-creds.enc',
  });
  assert.equal(ok.isAvailable(), true);
  assert.equal(no.isAvailable(), false);
});
