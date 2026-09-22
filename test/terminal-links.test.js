const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('OSC 8 and bare web links use the scheme-checked external browser bridge', async () => {
  const opened = [];
  let openExternal;
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const handlerStart = main.indexOf('const SAFE_EXTERNAL_SCHEMES =');
  const handlerEnd = main.indexOf("ipcMain.handle('shell:showItemInFolder'", handlerStart);
  assert.ok(handlerStart !== -1 && handlerEnd > handlerStart);
  vm.runInNewContext(main.slice(handlerStart, handlerEnd), {
    URL,
    console: { warn() {} },
    ipcMain: {
      handle(channel, handler) {
        assert.equal(channel, 'shell:openExternal');
        openExternal = uri => handler({}, uri);
      }
    },
    shell: { openExternal: uri => { opened.push(uri); return Promise.resolve(); } }
  });

  let terminalOptions;
  let activateBareLink;
  const pending = [];
  const bridgeCalls = [];
  const window = {
    electronAPI: {
      openExternal(uri) {
        bridgeCalls.push(uri);
        const result = openExternal(uri);
        pending.push(result);
        return result;
      }
    },
    open() { assert.fail('terminal links must not use window.open'); },
    confirm() { assert.fail('terminal links must not use the default xterm prompt'); }
  };
  const renderer = fs.readFileSync(path.join(__dirname, '../renderer.js'), 'utf8');
  const terminalStart = renderer.indexOf('var terminal = new Terminal({');
  const terminalEnd = renderer.indexOf('terminal.open(termWrapper);', terminalStart);
  assert.ok(terminalStart !== -1 && terminalEnd > terminalStart);
  vm.runInNewContext(renderer.slice(terminalStart, terminalEnd), {
    window,
    themeForThisCol: {},
    termSettings: {},
    fontSize: 14,
    Terminal: function (options) {
      terminalOptions = options;
      this.loadAddon = function () {};
    },
    FitAddon: { FitAddon: function () {} },
    WebLinksAddon: { WebLinksAddon: function (activate) { activateBareLink = activate; } }
  });

  assert.equal(typeof terminalOptions.linkHandler?.activate, 'function',
    'OSC 8 links need an explicit handler to bypass xterm window.open');
  assert.notEqual(terminalOptions.linkHandler.allowNonHttpProtocols, true,
    'preserve xterm HTTP(S)-only OSC 8 links');
  const urls = ['http://127.0.0.1:8768/', 'https://example.com/docs?q=codex#links'];
  for (const uri of urls) {
    terminalOptions.linkHandler.activate({}, uri);
    activateBareLink({}, uri);
  }
  await Promise.all(pending);
  assert.deepEqual(bridgeCalls, urls.flatMap(uri => [uri, uri]));
  assert.deepEqual(opened, bridgeCalls);

  // Main remains the authority even when a compromised renderer bypasses xterm.
  for (const uri of ['file:///C:/Windows/notepad.exe', 'javascript:alert(1)', 'vscode://file/C:/test', 'not a URL']) {
    await assert.rejects(openExternal(uri), /refused:/);
  }
  assert.deepEqual(opened, bridgeCalls);

  delete window.electronAPI;
  assert.doesNotThrow(() => terminalOptions.linkHandler.activate({}, urls[0]));
  assert.deepEqual(opened, bridgeCalls);
});
