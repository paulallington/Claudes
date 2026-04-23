const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeConnectionString,
  redactHost,
} = require('../lib/sharing-connection-string');

test('normalizeConnectionString: trims whitespace', () => {
  assert.equal(
    normalizeConnectionString('  mongodb://user:pw@host:27017/  '),
    'mongodb://user:pw@host:27017/'
  );
});

test('normalizeConnectionString: accepts mongodb:// scheme', () => {
  const cs = 'mongodb://user:pw@host:27017/';
  assert.equal(normalizeConnectionString(cs), cs);
});

test('normalizeConnectionString: accepts mongodb+srv:// scheme', () => {
  const cs = 'mongodb+srv://user:pw@cluster.mongo.cosmos.azure.com/';
  assert.equal(normalizeConnectionString(cs), cs);
});

test('normalizeConnectionString: rejects empty', () => {
  assert.throws(() => normalizeConnectionString(''), /empty/i);
  assert.throws(() => normalizeConnectionString('   '), /empty/i);
});

test('normalizeConnectionString: rejects non-string', () => {
  assert.throws(() => normalizeConnectionString(null), /string/i);
  assert.throws(() => normalizeConnectionString(undefined), /string/i);
  assert.throws(() => normalizeConnectionString(123), /string/i);
});

test('normalizeConnectionString: rejects unsupported scheme', () => {
  assert.throws(
    () => normalizeConnectionString('https://host/'),
    /mongodb:\/\/ or mongodb\+srv:\/\//
  );
});

test('redactHost: extracts host from mongodb://', () => {
  assert.equal(
    redactHost('mongodb://user:pw@host.example.com:27017/mydb'),
    'host.example.com:27017'
  );
});

test('redactHost: extracts host from mongodb+srv://', () => {
  assert.equal(
    redactHost('mongodb+srv://user:pw@cluster.mongo.cosmos.azure.com/mydb'),
    'cluster.mongo.cosmos.azure.com'
  );
});

test('redactHost: handles no credentials', () => {
  assert.equal(redactHost('mongodb://host.example.com:27017/'), 'host.example.com:27017');
});

test('redactHost: handles multiple hosts', () => {
  assert.equal(
    redactHost('mongodb://u:p@h1:27017,h2:27017/db'),
    'h1:27017,h2:27017'
  );
});

test('redactHost: returns "(invalid)" on unparseable input', () => {
  assert.equal(redactHost('not a url'), '(invalid)');
  assert.equal(redactHost(''), '(invalid)');
});
