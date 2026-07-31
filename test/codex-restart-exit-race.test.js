'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');

test('respawn never suppresses the replacement PTY exit as the old PTY exit', () => {
  assert.equal(
    renderer.includes('suppressNextExit'),
    false,
    'PTY server removes the killed generation before its delayed exit callback, so suppressing the next exit can only hide the replacement failure'
  );
});
