const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { diagLogDir } = require('../lib/diag-log-dir');

test('macOS: ~/Library/Logs/Claudes', () => {
  const d = diagLogDir({ platform: 'darwin', env: {}, homedir: '/Users/paul' });
  assert.equal(d, path.join('/Users/paul', 'Library', 'Logs', 'Claudes'));
});

test('Windows: uses %LOCALAPPDATA%\\Claudes\\Logs', () => {
  const d = diagLogDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\paul\\AppData\\Local' }, homedir: 'C:\\Users\\paul' });
  assert.equal(d, path.join('C:\\Users\\paul\\AppData\\Local', 'Claudes', 'Logs'));
});

test('Windows: falls back to ~/AppData/Local when LOCALAPPDATA is unset', () => {
  const d = diagLogDir({ platform: 'win32', env: {}, homedir: 'C:\\Users\\paul' });
  assert.equal(d, path.join('C:\\Users\\paul', 'AppData', 'Local', 'Claudes', 'Logs'));
});

test('Linux: honours $XDG_STATE_HOME', () => {
  const d = diagLogDir({ platform: 'linux', env: { XDG_STATE_HOME: '/home/paul/.state' }, homedir: '/home/paul' });
  assert.equal(d, path.join('/home/paul/.state', 'Claudes', 'logs'));
});

test('Linux: falls back to ~/.local/state when XDG_STATE_HOME is unset', () => {
  const d = diagLogDir({ platform: 'linux', env: {}, homedir: '/home/paul' });
  assert.equal(d, path.join('/home/paul', '.local', 'state', 'Claudes', 'logs'));
});

test('missing env object does not throw', () => {
  const d = diagLogDir({ platform: 'win32', homedir: 'C:\\Users\\paul' });
  assert.equal(d, path.join('C:\\Users\\paul', 'AppData', 'Local', 'Claudes', 'Logs'));
});
