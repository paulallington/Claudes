'use strict';

const path = require('path');

// Resolve the Claudes diagnostics log directory. Pure (platform/env/homedir are
// injected) so both the Electron main process and the standalone pty-server —
// which can't call Electron's app.getPath — compute the SAME directory.
// Mirrors the historical inline logic in main.js: `Logs` on Windows/macOS,
// lowercase `logs` under the XDG state dir on Linux.
function diagLogDir(opts) {
  const platform = opts.platform;
  const env = opts.env || {};
  const homedir = opts.homedir;

  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Logs', 'Claudes');
  }
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local');
    return path.join(base, 'Claudes', 'Logs');
  }
  const xdgState = env.XDG_STATE_HOME || path.join(homedir, '.local', 'state');
  return path.join(xdgState, 'Claudes', 'logs');
}

module.exports = { diagLogDir };
