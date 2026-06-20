const test = require('node:test');
const assert = require('node:assert/strict');
const { planFreshSessionId, randomUuidV4, planResumeArgs } = require('../lib/spawn-session');

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('rule 1: arbitrary cmd spawn gets no --session-id', () => {
  const args = ['foo', 'bar'];
  const r = planFreshSessionId({ args: args, cmd: 'bash', hasEndpoint: false }, () => 'stub');
  assert.deepEqual(r.args, ['foo', 'bar']);
  assert.equal(r.sessionId, null);
});

test('rule 2: endpoint/remote spawn gets no --session-id', () => {
  const args = ['--model', 'x'];
  const r = planFreshSessionId({ args: args, cmd: null, hasEndpoint: true }, () => 'stub');
  assert.deepEqual(r.args, ['--model', 'x']);
  assert.equal(r.sessionId, null);
});

test('rule 3a: --resume spawn gets no --session-id', () => {
  const args = ['--resume', 'abc-123'];
  const r = planFreshSessionId({ args: args, cmd: null, hasEndpoint: false }, () => 'stub');
  assert.deepEqual(r.args, ['--resume', 'abc-123']);
  assert.equal(r.sessionId, null);
});

test('rule 3b: --continue spawn gets no --session-id', () => {
  const args = ['--continue'];
  const r = planFreshSessionId({ args: args, cmd: null, hasEndpoint: false }, () => 'stub');
  assert.deepEqual(r.args, ['--continue']);
  assert.equal(r.sessionId, null);
});

test('rule 4: existing --session-id is adopted, not duplicated', () => {
  const args = ['--session-id', 'existing-id', '--foo'];
  const r = planFreshSessionId({ args: args, cmd: null, hasEndpoint: false }, () => 'stub');
  assert.deepEqual(r.args, ['--session-id', 'existing-id', '--foo']);
  assert.equal(r.sessionId, 'existing-id');
});

test('rule 5: fresh local spawn gets a generated --session-id appended', () => {
  const args = ['--effort', 'high'];
  const r = planFreshSessionId({ args: args, cmd: null, hasEndpoint: false }, () => 'gen-uuid-xyz');
  assert.deepEqual(r.args, ['--effort', 'high', '--session-id', 'gen-uuid-xyz']);
  assert.equal(r.sessionId, 'gen-uuid-xyz');
});

test('rule 5: uses default randomUuidV4 when no genUuid passed', () => {
  const r = planFreshSessionId({ args: [], cmd: null, hasEndpoint: false });
  assert.match(r.sessionId, UUID_V4_RE);
  assert.deepEqual(r.args, ['--session-id', r.sessionId]);
});

test('does not mutate the input args array', () => {
  const args = ['--effort', 'high'];
  planFreshSessionId({ args: args, cmd: null, hasEndpoint: false }, () => 'gen');
  assert.deepEqual(args, ['--effort', 'high']);
});

test('planResumeArgs: exists=true + sessionId appends --resume <id>', () => {
  const baseArgs = ['--effort', 'high'];
  const r = planResumeArgs({ baseArgs: baseArgs, sessionId: 'abc-123', exists: true });
  assert.deepEqual(r, ['--effort', 'high', '--resume', 'abc-123']);
});

test('planResumeArgs: exists=false + sessionId omits --resume', () => {
  const baseArgs = ['--effort', 'high'];
  const r = planResumeArgs({ baseArgs: baseArgs, sessionId: 'abc-123', exists: false });
  assert.deepEqual(r, ['--effort', 'high']);
});

test('planResumeArgs: null/empty sessionId omits --resume regardless of exists', () => {
  assert.deepEqual(planResumeArgs({ baseArgs: ['x'], sessionId: null, exists: true }), ['x']);
  assert.deepEqual(planResumeArgs({ baseArgs: ['x'], sessionId: '', exists: true }), ['x']);
  assert.deepEqual(planResumeArgs({ baseArgs: ['x'], sessionId: undefined, exists: true }), ['x']);
});

test('planResumeArgs: does not mutate baseArgs and returns a new array', () => {
  const baseArgs = ['--effort', 'high'];
  const r = planResumeArgs({ baseArgs: baseArgs, sessionId: 'abc-123', exists: true });
  assert.deepEqual(baseArgs, ['--effort', 'high']);
  assert.notEqual(r, baseArgs);
  const r2 = planResumeArgs({ baseArgs: baseArgs, sessionId: 'abc-123', exists: false });
  assert.notEqual(r2, baseArgs);
});

test('randomUuidV4 returns a valid v4 uuid and two calls differ', () => {
  const a = randomUuidV4();
  const b = randomUuidV4();
  assert.match(a, UUID_V4_RE);
  assert.match(b, UUID_V4_RE);
  assert.notEqual(a, b);
});
