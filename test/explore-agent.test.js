const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { buildExploreAgentFile } = require('../lib/explore-agent');

test('buildExploreAgentFile returns frontmatter starting with --- and name: Explore', () => {
  const out = buildExploreAgentFile();
  assert.equal(typeof out, 'string');
  assert.ok(out.startsWith('---\n'));
  assert.ok(out.includes('name: Explore'));
});
