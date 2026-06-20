const test = require('node:test');
const assert = require('node:assert/strict');
const { reflowSelection } = require('../lib/reflow-text');

test('1: hard-wrapped prose joins into one paragraph with single spaces', () => {
  const input = 'the groundwork, integrations, moving off Unity\nplatform framework, so we can';
  assert.equal(
    reflowSelection(input),
    'the groundwork, integrations, moving off Unity platform framework, so we can'
  );
});

test('2: uniform left-margin is dedented away', () => {
  const input = '    hello there friend\n    this is one paragraph';
  assert.equal(reflowSelection(input), 'hello there friend this is one paragraph');
});

test('3: blank line is a paragraph break; each paragraph reflowed to one line', () => {
  const input = 'first line of\npara one\n\nsecond line of\npara two';
  assert.equal(reflowSelection(input), 'first line of para one\n\nsecond line of para two');
});

test('4: list items each stay on their own line and absorb their wrapped continuation', () => {
  // A list-marker line flushes the current paragraph and seeds a new one; the
  // following wrapped (flowable) line appends to it. A new marker flushes the
  // prior item. So each item ends up on its own single line.
  const input = 'intro line wraps\nhere\n- first bullet\ncontinues here\n- second bullet\n1. ordered one\nwraps too\n2. ordered two';
  assert.equal(
    reflowSelection(input),
    'intro line wraps here\n- first bullet continues here\n- second bullet\n1. ordered one wraps too\n2. ordered two'
  );
});

test('5: deeper indentation than the common margin is kept on its own line', () => {
  const input = '  prose line\n  more prose\n      code = indented()\n  back to prose';
  assert.equal(
    reflowSelection(input),
    'prose line more prose\n    code = indented()\nback to prose'
  );
});

test('6: empty / whitespace-only input returns empty string', () => {
  assert.equal(reflowSelection(''), '');
  assert.equal(reflowSelection('   \n  \n\t'), '');
  assert.equal(reflowSelection(null), '');
  assert.equal(reflowSelection(undefined), '');
});

test('7: multiple blank lines between paragraphs collapse to a single blank line', () => {
  const input = 'para one\n\n\n\npara two';
  assert.equal(reflowSelection(input), 'para one\n\npara two');
});

test('8: leading and trailing blank lines are trimmed from the output', () => {
  const input = '\n\n  real content here\n  wraps on\n\n';
  assert.equal(reflowSelection(input), 'real content here wraps on');
});

test('9: heading at col 0 with inconsistently 1-space-indented wrapped body joins into one paragraph', () => {
  // Real user paste: heading is at column 0, but TUI-wrapped body lines carry an
  // inconsistent ~1-space residual indent. baseIndent is 0 (heading + some
  // no-indent body lines), so the small residual must count as noise, not structure.
  const input =
    'Message to Sam (WhatsApp):\n' +
    '\n' +
    ' Hey Sam, update on the R&D claim. I\'ve been through everything\n' +
    'we\'ve built this year and assessed it\n' +
    ' properly against what HMRC actually counts as R&D. The honest\n' +
    'read is most of this year was\n' +
    ' groundwork: integrations, rules, getting the platform into the right\n' +
    'state so we can start on the AI';
  const expected =
    'Message to Sam (WhatsApp):\n' +
    '\n' +
    'Hey Sam, update on the R&D claim. I\'ve been through everything we\'ve built this year and assessed it properly against what HMRC actually counts as R&D. The honest read is most of this year was groundwork: integrations, rules, getting the platform into the right state so we can start on the AI';
  assert.equal(reflowSelection(input), expected);
});

test('10: a >=4-space indented block is preserved as code, not flowed', () => {
  const input = 'prose line\nmore prose\n    code = block()\n    next = line()\nback to prose';
  assert.equal(
    reflowSelection(input),
    'prose line more prose\n    code = block()\n    next = line()\nback to prose'
  );
});

test('11: full real-world sample — list items absorb wrapped continuations', () => {
  const input =
    '  So the helper I added to the results sheet is not shared here — this is a separate\n' +
    '  surface that was never wired for it.\n' +
    '\n' +
    '  What "use the primary image" would mean here — and a decision for you\n' +
    '\n' +
    '  Because the message is text-only, there are really two different things you might want,\n' +
    '  and they need different work:\n' +
    '\n' +
    '  1. Put a photo URL into the query JSON when a damaged component has no own photo — i.e.\n' +
    '  swap the empty/own ImageUrl for the matching primary photo URL using the same mapping\n' +
    '  helper I just wrote (FallbackSlotFor). Cheap to do; the URL would appear as text in the\n' +
    '  message Claude generates. Useful only if the query message is meant to link a photo.\n' +
    '  2. Actually show Claude the damage photos (per-component, with primary-photo fallback) so\n' +
    '  its written assessment is informed by what the damage looks like. This is a bigger\n' +
    '  change — ClaudeClient currently sends a plain string, so it\'d need to switch to image\n' +
    '  content blocks and fetch/attach the images. The fallback would slot into that naturally.\n' +
    '\n' +
    '  Which do you want?\n' +
    '  - (1) just feed the fallback photo URL into the query message (small change, mirrors the\n' +
    '  results-sheet logic), or\n' +
    '  - (2) properly attach the damage photos to the AI request with the primary-photo fallback\n' +
    '  (more work, but the AI actually "sees" the damage), or\n' +
    '  - both?';
  const expected =
    'So the helper I added to the results sheet is not shared here — this is a separate surface that was never wired for it.\n' +
    '\n' +
    'What "use the primary image" would mean here — and a decision for you\n' +
    '\n' +
    'Because the message is text-only, there are really two different things you might want, and they need different work:\n' +
    '\n' +
    '1. Put a photo URL into the query JSON when a damaged component has no own photo — i.e. swap the empty/own ImageUrl for the matching primary photo URL using the same mapping helper I just wrote (FallbackSlotFor). Cheap to do; the URL would appear as text in the message Claude generates. Useful only if the query message is meant to link a photo.\n' +
    '2. Actually show Claude the damage photos (per-component, with primary-photo fallback) so its written assessment is informed by what the damage looks like. This is a bigger change — ClaudeClient currently sends a plain string, so it\'d need to switch to image content blocks and fetch/attach the images. The fallback would slot into that naturally.\n' +
    '\n' +
    'Which do you want?\n' +
    '- (1) just feed the fallback photo URL into the query message (small change, mirrors the results-sheet logic), or\n' +
    '- (2) properly attach the damage photos to the AI request with the primary-photo fallback (more work, but the AI actually "sees" the damage), or\n' +
    '- both?';
  assert.equal(reflowSelection(input), expected);
});

test('12: internal multi-space runs collapse in prose but are preserved in code', () => {
  // Prose: a mid-line run of multiple spaces (terminal padding) collapses to one.
  assert.equal(
    reflowSelection('this has    a big gap\nand wraps on'),
    'this has a big gap and wraps on'
  );
  // Code (>=4 indent): internal spacing is significant and preserved verbatim.
  assert.equal(
    reflowSelection('prose\n    code  =  block()'),
    'prose\n    code  =  block()'
  );
  // Code inside a fence: internal spacing preserved verbatim.
  assert.equal(
    reflowSelection('```\nfoo    bar\n```'),
    '```\nfoo    bar\n```'
  );
});
