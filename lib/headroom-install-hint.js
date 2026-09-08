'use strict';

(function () {
  // Python minor version pinned for the Headroom install — one place to
  // bump. uv and pipx spell the flag differently (`--python 3.13` vs
  // `--python python3.13`), so both command strings are built from this.
  var PYTHON_MINOR_VERSION = '3.13';

  // Preserves today's hard-coded pipx command as the fallback when neither
  // uv nor pipx is detected, so behaviour never regresses for those users.
  var FALLBACK_INSTALL_COMMAND = 'pipx install --python python' + PYTHON_MINOR_VERSION + ' "headroom-ai[all]"';

  /**
   * Pick the correct Headroom install command for the machine it's running
   * on. uv wins when both are present (faster, more common modern setup) —
   * following the pipx instructions on a uv machine would produce a SECOND
   * install, and pipx's and uv's shims both claim ~/.local/bin/headroom, so
   * whichever wrote last silently wins and the two versions drift.
   *
   * @param {{ hasUv?: any, hasPipx?: any }} [opts]
   * @returns {{ installer: 'uv'|'pipx'|null, command: string }}
   */
  function chooseInstallCommand(opts) {
    opts = opts || {};
    if (opts.hasUv) {
      return {
        installer: 'uv',
        command: 'uv tool install --python ' + PYTHON_MINOR_VERSION + ' "headroom-ai[all]"',
      };
    }
    if (opts.hasPipx) {
      return { installer: 'pipx', command: FALLBACK_INSTALL_COMMAND };
    }
    return { installer: null, command: FALLBACK_INSTALL_COMMAND };
  }

  var api = {
    chooseInstallCommand: chooseInstallCommand,
    FALLBACK_INSTALL_COMMAND: FALLBACK_INSTALL_COMMAND,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.HeadroomInstallHint = api;
  }
})();
