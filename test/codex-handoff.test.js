'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  extractTurns,
  extractActivity,
  contentText,
  tailWithinBudget,
  buildHandoffDoc,
  buildHandoffPrompt,
  handoffFileName
} = require('../lib/codex-handoff');

// A transcript line, as Claude Code writes them.
function rec(o) { return JSON.stringify(o); }
const userTurn = (text, extra) => rec(Object.assign(
  { type: 'user', message: { content: text }, timestamp: '2026-07-25T10:00:00Z', cwd: 'D:/r', gitBranch: 'main' }, extra || {}));
const asstText = (text, extra) => rec(Object.assign(
  { type: 'assistant', message: { content: [{ type: 'text', text: text }] } }, extra || {}));
const asstTool = (name, input) => rec(
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: name, input: input }] } });

test('extractTurns: keeps user strings and assistant text blocks', () => {
  const turns = extractTurns([userTurn('do the thing'), asstText('done')].join('\n'));
  assert.deepStrictEqual(turns.map((t) => [t.role, t.text]), [['user', 'do the thing'], ['assistant', 'done']]);
  assert.strictEqual(turns[0].branch, 'main');
});

test('extractTurns: drops sidechain, meta, and thinking-only turns', () => {
  // sidechain = a subagent's conversation; including it interleaves narratives
  const jsonl = [
    userTurn('real'),
    userTurn('subagent chatter', { isSidechain: true }),
    userTurn('bookkeeping', { isMeta: true }),
    rec({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'reasoning' }] } }),
    rec({ type: 'file-history-snapshot' })
  ].join('\n');
  assert.deepStrictEqual(extractTurns(jsonl).map((t) => t.text), ['real']);
});

test('extractTurns: survives a partial trailing line (file is appended live)', () => {
  const jsonl = userTurn('ok') + '\n{"type":"assistant","message":{"cont';
  assert.strictEqual(extractTurns(jsonl).length, 1);
});

test('extractTurns: strips harness noise wrappers', () => {
  const t = extractTurns(userTurn('<system-reminder>ignore me</system-reminder>keep me'));
  assert.strictEqual(t[0].text, 'keep me');
});

test('extractActivity: captures tool name + target, never the payload', () => {
  // this is the whole point: in an agentic session most turns carry no prose,
  // so a prose-only handoff conveys almost nothing
  const jsonl = [
    asstTool('Edit', { file_path: 'lib/x.js', old_string: 'SECRET PAYLOAD', new_string: 'y' }),
    asstTool('Bash', { command: 'npm test', description: 'run tests' })
  ].join('\n');
  const acts = extractActivity(jsonl);
  assert.deepStrictEqual(acts, [
    { name: 'Edit', target: 'lib/x.js' },
    { name: 'Bash', target: 'npm test' }   // command wins over description
  ]);
  assert.ok(!JSON.stringify(acts).includes('SECRET PAYLOAD'));
});

test('extractActivity: ignores subagent tool calls and caps to most recent', () => {
  const many = [];
  for (let i = 0; i < 50; i++) many.push(asstTool('Read', { file_path: 'f' + i }));
  const acts = extractActivity(many.join('\n'), 5);
  assert.strictEqual(acts.length, 5);
  assert.strictEqual(acts[4].target, 'f49');   // kept the newest
});

test('tailWithinBudget: keeps the most RECENT turns, not the first', () => {
  const turns = [{ text: 'a'.repeat(100) }, { text: 'b'.repeat(100) }, { text: 'c'.repeat(100) }];
  const r = tailWithinBudget(turns, 260);
  assert.strictEqual(r.turns.length, 2);
  assert.ok(r.turns[1].text.startsWith('c'));   // conclusion survives, intro dropped
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.droppedTurns, 1);
});

test('tailWithinBudget: always keeps at least one turn, even if oversized', () => {
  const r = tailWithinBudget([{ text: 'x'.repeat(5000) }], 10);
  assert.strictEqual(r.turns.length, 1);
});

test('buildHandoffDoc: renders turns, activity, and a truncation warning', () => {
  const doc = buildHandoffDoc({
    turns: [{ role: 'user', text: 'first' }, { role: 'assistant', text: 'second' }],
    activity: [{ name: 'Edit', target: 'lib/x.js' }],
    title: 'Claude #2', cwd: 'D:/r', branch: 'main', maxChars: 40
  });
  assert.ok(doc.includes('# Handoff from a Claude session'));
  assert.ok(doc.includes('Claude #2'));
  assert.ok(doc.includes('`main`'));
  assert.ok(doc.includes('What the session actually did'));
  assert.ok(doc.includes('`Edit`'));
  assert.ok(doc.includes('Earlier conversation omitted'));
});

test('buildHandoffDoc: says so plainly when nothing was recoverable', () => {
  // a freshly spawned column has written almost nothing to disk yet
  const doc = buildHandoffDoc({ turns: [] });
  assert.ok(doc.includes('No conversation was recoverable'));
});

test('buildHandoffPrompt: short, points at the file, empty for empty input', () => {
  const p = buildHandoffPrompt('.claudes/h.md');
  assert.ok(p.startsWith('Read .claudes/h.md first.'));
  assert.ok(p.length < 500);            // the doc carries the payload, not this
  assert.strictEqual(buildHandoffPrompt(''), '');
});

test('handoffFileName: filesystem-safe and unique per timestamp', () => {
  assert.strictEqual(handoffFileName('2026-07-25T12:34:56.789Z'), 'handoff-2026-07-25T12-34-56-789.md');
  assert.ok(!/[:]/.test(handoffFileName(new Date())));
});

test('contentText: handles string, block array, and junk without throwing', () => {
  assert.strictEqual(contentText('hi'), 'hi');
  assert.strictEqual(contentText([{ type: 'text', text: 'a' }, { type: 'thinking' }]), 'a');
  assert.strictEqual(contentText(null), '');
  assert.strictEqual(contentText(42), '');
});
