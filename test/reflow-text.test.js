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

test('4: list items each stay on their own line, not merged into prose', () => {
  const input = 'intro line wraps\nhere\n- first bullet\n- second bullet\n1. ordered one\n2. ordered two';
  assert.equal(
    reflowSelection(input),
    'intro line wraps here\n- first bullet\n- second bullet\n1. ordered one\n2. ordered two'
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
