const test = require('node:test');
const assert = require('node:assert/strict');
const { extractLastTerminalReply, splitReplySummary, firstSentence } = require('../lib/terminal-reply');

// FIXTURE 1 — a plain-text reply (no tools). Lines are already right-trimmed,
// as if produced by xterm's translateToString(true).
const FIXTURE_1 = [
  '❯ In exactly three short sentences, describe the number four. Do not use any tools or read any',
  '  files.',
  '',
  '● Four is the natural number that comes after three and before five. It is the smallest composite',
  '  number, equal to two multiplied by two. People often group things in fours, like the four seasons',
  '  and the four cardinal directions.',
  '',
  '✻ Brewed for 9s',
  '',
  '────────────────',
  '❯',
];

const FIXTURE_1_EXPECTED =
  'Four is the natural number that comes after three and before five. ' +
  'It is the smallest composite number, equal to two multiplied by two. ' +
  'People often group things in fours, like the four seasons and the four cardinal directions.';

// FIXTURE 2 — a tool-using turn. The Bash(...) + ⎿ block must be skipped; only
// the trailing prose block is returned.
const FIXTURE_2 = [
  '❯ Use the Bash tool to run: git branch --show-current . Then tell me the current branch in one',
  '  short sentence.',
  '',
  '● Bash(git branch --show-current)',
  '  ⎿  main',
  '',
  '● The current branch is main.',
  '',
  '✻ Churned for 20s',
];

test('extractLastTerminalReply returns a plain-text reply joined with single spaces', () => {
  assert.equal(extractLastTerminalReply(FIXTURE_1), FIXTURE_1_EXPECTED);
});

test('extractLastTerminalReply skips tool blocks and returns the trailing prose', () => {
  assert.equal(extractLastTerminalReply(FIXTURE_2), 'The current branch is main.');
});

test('extractLastTerminalReply returns "" when there are no bullet blocks', () => {
  const lines = [
    '❯ just a prompt with no reply yet',
    '',
    '────────────────',
    '❯',
  ];
  assert.equal(extractLastTerminalReply(lines), '');
});

test('extractLastTerminalReply returns "" for a tool-only turn', () => {
  const lines = [
    '❯ run a command',
    '',
    '● Bash(git status)',
    '  ⎿  clean',
    '',
    '✻ Churned for 3s',
  ];
  assert.equal(extractLastTerminalReply(lines), '');
});

test('extractLastTerminalReply joins a multi-line wrapped prose reply with single spaces', () => {
  const lines = [
    '● This reply wraps across',
    '  several rendered lines',
    '  in the terminal buffer.',
    '',
  ];
  assert.equal(
    extractLastTerminalReply(lines),
    'This reply wraps across several rendered lines in the terminal buffer.'
  );
});

test('extractLastTerminalReply never returns the prompt echo, footer, or separators', () => {
  const out = extractLastTerminalReply(FIXTURE_1);
  assert.ok(!out.includes('❯'));
  assert.ok(!out.includes('✻'));
  assert.ok(!out.includes('Brewed for'));
  assert.ok(!out.includes('────'));
});

test('extractLastTerminalReply returns "" for empty / non-array input', () => {
  assert.equal(extractLastTerminalReply([]), '');
  assert.equal(extractLastTerminalReply(null), '');
  assert.equal(extractLastTerminalReply(undefined), '');
});

test('extractLastTerminalReply returns the LAST prose block when several exist', () => {
  const lines = [
    '● First prose block here.',
    '',
    '● Bash(echo hi)',
    '  ⎿  hi',
    '',
    '● Second and final prose block.',
    '',
  ];
  assert.equal(extractLastTerminalReply(lines), 'Second and final prose block.');
});

test('extractLastTerminalReply skips MCP tool blocks and returns trailing prose', () => {
  const lines = [
    '❯ create the issue',
    '',
    '● mcp__github__create_issue({"title":"Bug"})',
    '  ⎿  ok',
    '',
    '● Done, created the issue.',
    '',
    '✻ Churned for 4s',
  ];
  assert.equal(extractLastTerminalReply(lines), 'Done, created the issue.');
});

test('extractLastTerminalReply returns "" for an MCP-tool-only turn', () => {
  const lines = [
    '❯ create the issue',
    '',
    '● mcp__github__create_issue({"title":"Bug"})',
    '  ⎿  ok',
    '',
    '✻ Churned for 4s',
  ];
  assert.equal(extractLastTerminalReply(lines), '');
});

// FIXTURE 3 — a real multi-paragraph reply. Blank lines separate paragraphs
// within ONE bullet block; the block must continue across those blank lines as
// long as the next non-blank line is an indented continuation (not a bullet,
// not the footer/prompt/separator which all sit at column 0).
const FIXTURE_3 = [
  '● 2 + 2 = 4',
  '',
  '  Working:',
  '',
  '  1. Start with 2.',
  '  2. Addition means combining quantities, so add 2 more units to it: 2 → 3 (that\'s +1) → 4 (that\'s +2).',
  '  3. Counting the total units: ●● + ●● = ●●●● = 4.',
  '',
  '  So 2 + 2 = 4. ✅',
  '',
  '✻ Brewed for 5s',
];

const FIXTURE_3_EXPECTED =
  '2 + 2 = 4 Working: ' +
  '1. Start with 2. ' +
  '2. Addition means combining quantities, so add 2 more units to it: 2 → 3 (that\'s +1) → 4 (that\'s +2). ' +
  '3. Counting the total units: ●● + ●● = ●●●● = 4. ' +
  'So 2 + 2 = 4. ✅';

test('extractLastTerminalReply continues a block across paragraph-break blank lines', () => {
  assert.equal(extractLastTerminalReply(FIXTURE_3), FIXTURE_3_EXPECTED);
});

test('extractLastTerminalReply stops a multi-paragraph block before the ✻ footer', () => {
  const out = extractLastTerminalReply(FIXTURE_3);
  assert.ok(!out.includes('✻'));
  assert.ok(!out.includes('Brewed for'));
});

test('extractLastTerminalReply does not treat mid-line ●● as a new bullet', () => {
  // The glyph appears mid-line (indented continuation), not at column 0, so it
  // must be kept as continuation text rather than starting/ending a block.
  const lines = [
    '● Counting demo:',
    '  3. Counting the total units: ●● + ●● = ●●●● = 4.',
    '',
    '✻ Brewed for 1s',
  ];
  assert.equal(
    extractLastTerminalReply(lines),
    'Counting demo: 3. Counting the total units: ●● + ●● = ●●●● = 4.'
  );
});

// ── splitReplySummary ──────────────────────────────────────────────────────
// The space-joined raw reply that extractLastTerminalReply produces for the
// real 6+6 reply, with the 🔊 (U+1F50A) summary line at the end.
const JOINED_6_PLUS_6 =
  '6 + 6 = 12 Working: start with 6, add another 6. Counting up from 6 by six ' +
  'steps (7, 8, 9, 10, 11, 12) lands on 12. Equivalently, 6 × 2 = 12. ' +
  '\u{1F50A} Six plus six equals twelve, which you can get by counting six ' +
  'steps up from six or just doubling six.';

test('splitReplySummary splits the body from the 🔊 summary line', () => {
  const r = splitReplySummary(JOINED_6_PLUS_6);
  assert.equal(r.hasSummary, true);
  assert.equal(
    r.summary,
    'Six plus six equals twelve, which you can get by counting six steps up from six or just doubling six.'
  );
  assert.ok(r.body.endsWith('6 × 2 = 12.'), 'body ends with "6 × 2 = 12."');
  assert.ok(r.body.includes('Working:'), 'body contains "Working:"');
  assert.ok(!r.body.includes('\u{1F50A}'), 'body does not contain the 🔊 glyph');
  assert.ok(!r.body.includes('Six plus six equals twelve'), 'body does not contain the summary text');
});

test('splitReplySummary returns hasSummary false when there is no 🔊 line', () => {
  const raw = '  Just a plain reply with no speaker line.  ';
  const r = splitReplySummary(raw);
  assert.equal(r.hasSummary, false);
  assert.equal(r.body, 'Just a plain reply with no speaker line.');
  assert.equal(r.summary, '');
});

test('splitReplySummary strips a leading variation selector after the 🔊', () => {
  // The emoji cell can leave a leading VS16 (U+FE0F) before the summary text.
  const raw = 'Body text here. \u{1F50A}️ Summary spoken line.';
  const r = splitReplySummary(raw);
  assert.equal(r.hasSummary, true);
  assert.equal(r.summary, 'Summary spoken line.');
  assert.equal(r.body, 'Body text here.');
});

test('splitReplySummary uses the LAST 🔊 when several appear', () => {
  const raw = '\u{1F50A} not really. Body. \u{1F50A} Real summary.';
  const r = splitReplySummary(raw);
  assert.equal(r.hasSummary, true);
  assert.equal(r.summary, 'Real summary.');
  assert.ok(r.body.includes('not really'));
});

test('splitReplySummary handles empty / non-string input', () => {
  assert.deepEqual(splitReplySummary(''), { body: '', summary: '', hasSummary: false });
  assert.deepEqual(splitReplySummary(null), { body: '', summary: '', hasSummary: false });
  assert.deepEqual(splitReplySummary(undefined), { body: '', summary: '', hasSummary: false });
});

// ── firstSentence ──────────────────────────────────────────────────────────
test('firstSentence returns only the first sentence of multi-sentence text', () => {
  assert.equal(
    firstSentence('First sentence here. Second sentence follows. And a third.'),
    'First sentence here.'
  );
  assert.equal(firstSentence('Done! More text after.'), 'Done!');
  assert.equal(firstSentence('Is it ready? Yes it is.'), 'Is it ready?');
});

test('firstSentence returns the whole text when there is no sentence punctuation', () => {
  assert.equal(firstSentence('A reply with no terminal punctuation'), 'A reply with no terminal punctuation');
  assert.equal(firstSentence('  trimmed but unpunctuated  '), 'trimmed but unpunctuated');
});

test('firstSentence does not split on a period mid-token (no following space)', () => {
  // The "." in 3.5 is not a sentence boundary because no whitespace follows it.
  assert.equal(firstSentence('Version 3.5 is out now. Next sentence.'), 'Version 3.5 is out now.');
});

test('firstSentence returns "" for empty / non-string input', () => {
  assert.equal(firstSentence(''), '');
  assert.equal(firstSentence(null), '');
  assert.equal(firstSentence(undefined), '');
});

// U+1F50A speaker emoji — the 🔊 summary-line marker.
const SPEAKER = '\u{1F50A}';

test('extractLastTerminalReply recovers a column-0 🔊 line after a bullet block and separator', () => {
  const lines = [
    '● Committed d53e94c3f with the three FAQ-fix files.',
    '  Other files were left untouched.',
    '',
    '────────',
    '',
    '\u{1F50A}All committed and ready to go. Deploy whenever.',
    '',
    '✻ Sautéed for 42s',
    '❯ ',
  ];
  const out = extractLastTerminalReply(lines);
  assert.ok(out.includes(SPEAKER), 'output should contain the 🔊 marker');
  assert.ok(out.includes('All committed and ready to go'), 'output should contain the summary text');

  const split = splitReplySummary(out);
  assert.equal(split.hasSummary, true);
  assert.equal(split.summary, 'All committed and ready to go. Deploy whenever.');
  assert.equal(
    split.body,
    'Committed d53e94c3f with the three FAQ-fix files. Other files were left untouched.'
  );
});

test('extractLastTerminalReply does not double-append a 🔊 already inside a block continuation', () => {
  const lines = [
    '● Here is the summary of what I did.',
    '  \u{1F50A}All wrapped up and looking good.',
    '',
    '✻ Brewed for 9s',
    '❯ ',
  ];
  const out = extractLastTerminalReply(lines);
  // Exactly one 🔊 marker present (split on it yields 2 parts).
  assert.equal(out.split(SPEAKER).length, 2, 'should contain exactly one 🔊 marker');
});

test('extractLastTerminalReply is unchanged when there is no 🔊 line', () => {
  const lines = [
    '● Committed d53e94c3f with the three FAQ-fix files.',
    '  Other files were left untouched.',
    '',
    '✻ Sautéed for 42s',
    '❯ ',
  ];
  const out = extractLastTerminalReply(lines);
  assert.equal(
    out,
    'Committed d53e94c3f with the three FAQ-fix files. Other files were left untouched.'
  );
  assert.ok(!out.includes(SPEAKER));
});

test('extractLastTerminalReply captures a 🔊 line plus its indented continuation', () => {
  const lines = [
    '● Did the thing.',
    '',
    '────────',
    '',
    '\u{1F50A}All committed and ready to go.',
    '  Deploy whenever you like.',
    '',
    '❯ ',
  ];
  const out = extractLastTerminalReply(lines);
  const split = splitReplySummary(out);
  assert.equal(split.hasSummary, true);
  assert.equal(split.summary, 'All committed and ready to go. Deploy whenever you like.');
});
