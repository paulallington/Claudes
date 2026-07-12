'use strict';

var test = require('node:test');
var assert = require('node:assert');
var clampMenuPosition = require('../lib/menu-position.js').clampMenuPosition;

test('fits in viewport: returns unchanged x/y', function () {
  var pos = clampMenuPosition(10, 20, 190, 100, 1000, 800);
  assert.deepStrictEqual(pos, { left: 10, top: 20 });
});

test('overflow-right clamps left', function () {
  var pos = clampMenuPosition(900, 20, 190, 100, 1000, 800);
  assert.strictEqual(pos.left, 1000 - 190 - 4);
  assert.strictEqual(pos.top, 20);
});

test('overflow-bottom clamps top', function () {
  var pos = clampMenuPosition(10, 750, 190, 100, 1000, 800);
  assert.strictEqual(pos.left, 10);
  assert.strictEqual(pos.top, 800 - 100 - 4);
});

test('overflow both clamps left and top', function () {
  var pos = clampMenuPosition(900, 750, 190, 100, 1000, 800);
  assert.strictEqual(pos.left, 1000 - 190 - 4);
  assert.strictEqual(pos.top, 800 - 100 - 4);
});

test('clamp result never negative even when menu is wider/taller than viewport', function () {
  var pos = clampMenuPosition(50, 50, 2000, 2000, 1000, 800);
  assert.strictEqual(pos.left, 0);
  assert.strictEqual(pos.top, 0);
});

test('default margin is 4 when omitted', function () {
  var pos = clampMenuPosition(900, 20, 190, 100, 1000, 800);
  assert.strictEqual(pos.left, 1000 - 190 - 4);
});

test('default margin is 4 when explicitly undefined', function () {
  var pos = clampMenuPosition(900, 20, 190, 100, 1000, 800, undefined);
  assert.strictEqual(pos.left, 1000 - 190 - 4);
});

test('custom margin is honored', function () {
  var pos = clampMenuPosition(900, 20, 190, 100, 1000, 800, 10);
  assert.strictEqual(pos.left, 1000 - 190 - 10);
});
