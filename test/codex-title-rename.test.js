'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');

function loadStartTitleEdit(columns) {
  const start = renderer.indexOf('function startTitleEdit');
  const end = renderer.indexOf('function createExitOverlay', start);
  assert.notEqual(start, -1, 'startTitleEdit should exist');
  assert.notEqual(end, -1, 'startTitleEdit boundary should exist');

  let renameOptions;
  const context = {
    allColumns: columns,
    startInlineRename: (_element, options) => { renameOptions = options; }
  };
  vm.runInNewContext(renderer.slice(start, end), context);
  return {
    start: context.startTitleEdit,
    getOptions: () => renameOptions
  };
}

test('empty column rename restores a command-aware default title', () => {
  const columns = new Map([
    [7, { cmd: 'codex' }],
    [8, { cmd: null }]
  ]);
  const titleEdit = loadStartTitleEdit(columns);

  titleEdit.start(7, {});
  assert.equal(titleEdit.getOptions().onEmpty(), 'Codex #7');

  titleEdit.start(8, {});
  assert.equal(titleEdit.getOptions().onEmpty(), 'Claude #8');
});
