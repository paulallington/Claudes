const test = require('node:test');
const assert = require('node:assert/strict');
const { extractSpeakableText, findSummaryLine, cleanSpokenText, lastAssistantUuid, splitSentences, firstSentence } = require('../lib/voice-text');

function line(obj) {
  return JSON.stringify(obj);
}

function assistantText(...texts) {
  return line({
    type: 'assistant',
    message: { role: 'assistant', content: texts.map((t) => ({ type: 'text', text: t })) }
  });
}

test('extractSpeakableText returns the last assistant text-bearing message', () => {
  const jsonl = [
    assistantText('first reply'),
    line({ type: 'user', message: { role: 'user', content: 'hi' } }),
    assistantText('second reply line one', 'line two'),
    // trailing tool-only assistant entry should be skipped
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] } })
  ].join('\n');
  // The last text-bearing assistant message wins; its two text blocks are joined.
  assert.equal(extractSpeakableText(jsonl, { maxChars: 600 }), 'second reply line one line two');
});

test('findSummaryLine returns trimmed remainder of last speaker-emoji line, else null', () => {
  assert.equal(findSummaryLine('no marker here'), null);
  assert.equal(findSummaryLine('intro\n\u{1F50A} First summary.\nmore'), 'First summary.');
  // last marker wins, leading whitespace before marker allowed
  assert.equal(findSummaryLine('\u{1F50A} early\nmiddle\n   \u{1F50A}  Final summary. '), 'Final summary.');
});

test('extractSpeakableText returns only the summary line remainder when present', () => {
  const jsonl = assistantText('Here is a long explanation with **bold** detail.\n\u{1F50A} Short summary.');
  assert.equal(extractSpeakableText(jsonl, { maxChars: 600 }), 'Short summary.');
});

test('cleanSpokenText strips markdown and truncates at a word boundary', () => {
  const md = [
    '# Big Heading',
    '',
    'Here is **bold** prose and a [link](https://example.com/x) to follow.',
    '',
    '```js',
    'const secret = 42;',
    'doNotSpeak();',
    '```',
    '',
    '- bullet point one',
    '- bullet point two'
  ].join('\n');
  const out = cleanSpokenText(md, 600);
  assert.ok(out.includes('Big Heading'));
  assert.ok(out.includes('bold'));
  assert.ok(out.includes('link'));
  assert.ok(!out.includes('https://example.com'));
  assert.ok(!out.includes('const secret'));
  assert.ok(!out.includes('doNotSpeak'));
  assert.ok(!out.includes('#'));
  assert.ok(!out.includes('*'));

  // truncation does not cut mid-word
  const long = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet';
  const truncated = cleanSpokenText(long, 20);
  assert.ok(truncated.length <= 21); // <= maxChars (+ optional ellipsis)
  assert.ok(!/\b(alph|brav|charli)$/.test(truncated.replace(/…$/, '')));
  assert.ok(long.startsWith(truncated.replace(/…$/, '').trim()));
});

test('cleanSpokenText hard-caps a huge bracket-heavy input without hanging (ReDoS guard)', () => {
  // A 300K-char run of '[' would trigger catastrophic backtracking in the link
  // regex if fed verbatim; cleanSpokenText must cap the input up front so it
  // returns promptly with a bounded-length result.
  const huge = '['.repeat(300000);
  const start = Date.now();
  const out = cleanSpokenText(huge, 600);
  const elapsed = Date.now() - start;
  assert.equal(typeof out, 'string');
  assert.ok(out.length <= 601, `output too long: ${out.length}`); // <= maxChars (+ ellipsis)
  assert.ok(elapsed < 2000, `cleanSpokenText took too long: ${elapsed}ms`);
});

test('extractSpeakableText cleans markdown when no summary line is present', () => {
  const jsonl = assistantText('## Result\n\nThe **answer** is ready. See ```js\ncode()\n``` above.');
  const out = extractSpeakableText(jsonl, { maxChars: 600 });
  assert.ok(out.includes('Result'));
  assert.ok(out.includes('answer'));
  assert.ok(!out.includes('code()'));
  assert.ok(!out.includes('#'));
  assert.ok(!out.includes('*'));
});

test('extractSpeakableText readingMode full speaks full reply and excludes the summary line', () => {
  const jsonl = assistantText('Here is the **detailed** prose explanation.\n\u{1F50A} Short summary sentence.');
  const out = extractSpeakableText(jsonl, { maxChars: 600, readingMode: 'full' });
  assert.ok(out.includes('detailed'));
  assert.ok(out.includes('prose explanation'));
  // the summary line text and the emoji must NOT be present
  assert.ok(!out.includes('Short summary sentence'));
  assert.ok(!out.includes('\u{1F50A}'));
  assert.ok(!out.includes('*'));
});

test('extractSpeakableText readingMode summary returns the summary line when present', () => {
  const withSummary = assistantText('Long prose explanation here.\n\u{1F50A} The summary.');
  assert.equal(extractSpeakableText(withSummary, { maxChars: 600, readingMode: 'summary' }), 'The summary.');
});

test('extractSpeakableText readingMode summary falls back to the FIRST sentence when no summary line', () => {
  // No 🔊 line present -> must NOT go silent, and must NOT read the whole reply;
  // the explicit Summary button speaks only the first sentence of the body.
  const noSummary = assistantText('The answer is ready and fully detailed. There is a second sentence here. And a third.');
  const summaryOut = extractSpeakableText(noSummary, { maxChars: 600, readingMode: 'summary' });
  const fullOut = extractSpeakableText(noSummary, { maxChars: 600, readingMode: 'full' });
  assert.equal(summaryOut, 'The answer is ready and fully detailed.');
  // It is concise: shorter than the full reply, and excludes later sentences.
  assert.ok(summaryOut.length < fullOut.length);
  assert.ok(!summaryOut.includes('second sentence'));
  assert.ok(!summaryOut.includes('third'));
});

test('firstSentence returns the first sentence, the whole text, or "" appropriately', () => {
  assert.equal(firstSentence('One. Two. Three.'), 'One.');
  assert.equal(firstSentence('No punctuation at all'), 'No punctuation at all');
  assert.equal(firstSentence(''), '');
  assert.equal(firstSentence(null), '');
});

test('extractSpeakableText readingMode auto equals omitted readingMode (backward compatible)', () => {
  // summary present -> both speak the summary line
  const withSummary = assistantText('Here is a long explanation with **bold** detail.\n\u{1F50A} Short summary.');
  assert.equal(
    extractSpeakableText(withSummary, { maxChars: 600 }),
    extractSpeakableText(withSummary, { maxChars: 600, readingMode: 'auto' })
  );
  assert.equal(extractSpeakableText(withSummary, { maxChars: 600, readingMode: 'auto' }), 'Short summary.');

  // no summary -> both clean + truncate the full reply
  const noSummary = assistantText('## Result\n\nThe **answer** is ready.');
  assert.equal(
    extractSpeakableText(noSummary, { maxChars: 600 }),
    extractSpeakableText(noSummary, { maxChars: 600, readingMode: 'auto' })
  );
  const autoOut = extractSpeakableText(noSummary, { maxChars: 600, readingMode: 'auto' });
  assert.ok(autoOut.includes('Result'));
  assert.ok(autoOut.includes('answer'));
  assert.ok(!autoOut.includes('#'));
  assert.ok(!autoOut.includes('*'));
});

test('lastAssistantUuid returns uuid of last text-bearing assistant entry, ignoring tool-only', () => {
  const jsonl = [
    line({ type: 'assistant', uuid: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } }),
    line({ type: 'user', message: { role: 'user', content: 'hi' } }),
    line({ type: 'assistant', uuid: 'u2', message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] } }),
    // trailing tool-only assistant entry has no text -> must be ignored
    line({ type: 'assistant', uuid: 'u3', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] } })
  ].join('\n');
  assert.equal(lastAssistantUuid(jsonl), 'u2');
  assert.equal(lastAssistantUuid(''), '');
});

test('splitSentences chunks text for streaming voice playback', () => {
  // 3-sentence paragraph -> 3 ordered chunks, each ending with its punctuation
  const para = 'The build finished successfully. There were two warnings to review! Did you want me to fix them?';
  const chunks = splitSentences(para);
  assert.deepEqual(chunks, [
    'The build finished successfully.',
    'There were two warnings to review!',
    'Did you want me to fix them?'
  ]);

  // a leading tiny fragment merges so there's no <25-char standalone chunk
  const merged = splitSentences('Ok. Here is the full detailed result that follows.');
  assert.deepEqual(merged, ['Ok. Here is the full detailed result that follows.']);
  for (const c of merged) assert.ok(c.length >= 25, `chunk too short: ${c}`);

  // no sentence punctuation -> single-element array
  assert.deepEqual(splitSentences('just some words with no terminator'), ['just some words with no terminator']);

  // empty / whitespace-only -> []
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences('   '), []);
});

test('splitSentences does not blow up on a long run of sentence punctuation (ReDoS guard)', () => {
  // A variable-length lookbehind on [.!?]+ is O(n^2) on a long '.' run; the
  // constant-width lookbehind must handle this promptly.
  const dots = '.'.repeat(100000);
  const start = Date.now();
  const chunks = splitSentences(dots);
  const elapsed = Date.now() - start;
  assert.ok(Array.isArray(chunks));
  assert.ok(elapsed < 2000, `splitSentences took too long: ${elapsed}ms`);
});

test('extractSpeakableText suppresses non-content turns (exact match only)', () => {
  // A turn whose entire text is "No response requested." must never be spoken.
  assert.equal(extractSpeakableText(assistantText('No response requested.'), { maxChars: 600 }), '');
  // A normal reply that merely mentions the phrase mid-text is unaffected.
  const normal = assistantText("Done. No response requested earlier, but here's the result.");
  assert.notEqual(extractSpeakableText(normal, { maxChars: 600 }), '');
});

test('extractSpeakableText returns empty string for empty/whitespace/malformed input', () => {
  assert.equal(extractSpeakableText('', { maxChars: 600 }), '');
  assert.equal(extractSpeakableText('   \n  ', { maxChars: 600 }), '');
  assert.equal(extractSpeakableText('{not json\nalso not json', { maxChars: 600 }), '');
});

function assistantTextUuid(uuid, ...texts) {
  return line({
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: texts.map((t) => ({ type: 'text', text: t })) }
  });
}

const thinkingOnly = line({
  type: 'assistant',
  uuid: 'think',
  message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 'sig' }] }
});

const toolUseOnly = line({
  type: 'assistant',
  uuid: 'tool',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] }
});

test('voice falls back past a non-content newest turn to the real reply (the bug)', () => {
  const jsonl = [
    assistantTextUuid('A', 'Hi! What would you like to work on?'),
    assistantTextUuid('B', 'No response requested.'),
    thinkingOnly,
    toolUseOnly,
    line({ type: 'mode', mode: 'default' }),
    line({ type: 'permission-mode', permissionMode: 'default' })
  ].join('\n');
  assert.equal(extractSpeakableText(jsonl, { readingMode: 'full' }), 'Hi! What would you like to work on?');
  assert.equal(lastAssistantUuid(jsonl), 'A');
});

test('newest real reply still wins when it is the last text turn (no regression)', () => {
  const jsonl = [
    line({ type: 'user', message: { role: 'user', content: 'hi' } }),
    assistantTextUuid('only', 'The newest and only reply.')
  ].join('\n');
  assert.equal(extractSpeakableText(jsonl, { readingMode: 'full' }), 'The newest and only reply.');
  assert.equal(lastAssistantUuid(jsonl), 'only');
});

test('all assistant turns non-content yields empty text and empty uuid', () => {
  const jsonl = [
    assistantTextUuid('n1', 'No response requested.'),
    assistantTextUuid('n2', 'No response requested.')
  ].join('\n');
  assert.equal(extractSpeakableText(jsonl, { readingMode: 'full' }), '');
  assert.equal(lastAssistantUuid(jsonl), '');
});

test('a real reply followed by multiple non-content turns falls back to the real reply', () => {
  const jsonl = [
    assistantTextUuid('real', 'The actual answer is here.'),
    assistantTextUuid('n1', 'No response requested.'),
    assistantTextUuid('n2', 'No response needed.'),
    assistantTextUuid('n3', 'No response requested.')
  ].join('\n');
  assert.equal(extractSpeakableText(jsonl, { readingMode: 'full' }), 'The actual answer is here.');
  assert.equal(lastAssistantUuid(jsonl), 'real');
});

test('tool_use-only / thinking-only with no text anywhere yields empty text and uuid', () => {
  const jsonl = [thinkingOnly, toolUseOnly].join('\n');
  assert.equal(extractSpeakableText(jsonl, { readingMode: 'full' }), '');
  assert.equal(lastAssistantUuid(jsonl), '');
});

test('summary mode: newest speakable summary line wins, else falls back past non-content', () => {
  // Newest speakable turn carries a 🔊 line -> summary returned.
  const withSummary = [
    assistantTextUuid('s1', 'Long prose explanation here.\n\u{1F50A} The newest summary.')
  ].join('\n');
  assert.equal(extractSpeakableText(withSummary, { readingMode: 'summary' }), 'The newest summary.');

  // Newest turn is non-content -> fall back to the prior real reply's summary line.
  const nonContentNewest = [
    assistantTextUuid('s2', 'Earlier prose.\n\u{1F50A} The prior summary.'),
    assistantTextUuid('B', 'No response requested.')
  ].join('\n');
  assert.equal(extractSpeakableText(nonContentNewest, { readingMode: 'summary' }), 'The prior summary.');
  assert.equal(lastAssistantUuid(nonContentNewest), 's2');
});
