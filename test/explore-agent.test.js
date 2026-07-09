const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { buildExploreAgentFile, EXPLORE_AGENT_REL, exploreAgentRelPath } = require('../lib/explore-agent');

test('buildExploreAgentFile returns frontmatter starting with --- and name: Explore', () => {
  const out = buildExploreAgentFile();
  assert.equal(typeof out, 'string');
  assert.ok(out.startsWith('---\n'));
  assert.ok(out.includes('name: Explore'));
});

test('default output pins model: haiku', () => {
  assert.ok(buildExploreAgentFile().includes('model: haiku'));
});

test('model: sonnet is used and haiku is absent', () => {
  const out = buildExploreAgentFile({ model: 'sonnet' });
  assert.ok(out.includes('model: sonnet'));
  assert.ok(!out.includes('model: haiku'));
});

test('tools line is exactly Glob, Grep, Read with no write, shell, or network tools', () => {
  const out = buildExploreAgentFile();
  const toolsLine = out.split('\n').find((line) => line.startsWith('tools:'));
  assert.equal(toolsLine, 'tools: Glob, Grep, Read');
  assert.ok(!out.includes('Write'));
  assert.ok(!out.includes('Edit'));
  assert.ok(!out.includes('Agent'));
  // Security regression guard: the weaker Haiku model must not get shell access.
  assert.ok(!/\bBash\b/.test(out));
});

test('body follows the closing frontmatter and mentions locating code / summary', () => {
  const out = buildExploreAgentFile();
  const parts = out.split('---');
  // parts: ['', frontmatter, body...]
  const body = parts.slice(2).join('---').trim();
  assert.ok(body.length > 0);
  assert.ok(/locate code|locating code/i.test(out));
  assert.ok(/summary/i.test(out));
  assert.ok(/file:line/i.test(out));
});

test('invalid model throws TypeError', () => {
  assert.throws(() => buildExploreAgentFile({ model: 'evil\ninjected: true' }), TypeError);
});

test('EXPLORE_AGENT_REL and exploreAgentRelPath match path.join', () => {
  const expected = path.join('.claude', 'agents', 'Explore.md');
  assert.equal(EXPLORE_AGENT_REL, expected);
  assert.equal(exploreAgentRelPath(), expected);
});
