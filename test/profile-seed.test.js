// test/profile-seed.test.js
const test = require('node:test');
const assert = require('node:assert');
const { extractSeedClaudeJson, TRUST_KEYS } = require('../lib/profile-seed');

const PRIMARY = {
  oauthAccount: { accountUuid: 'secret-account', emailAddress: 'me@example.com' },
  userID: 'secret-user',
  machineID: 'abc',
  cachedStatsigGates: { a: 1 },
  projects: {
    'D:/repo/one': {
      hasTrustDialogAccepted: true,
      allowedTools: ['Bash(npm test)'],
      hasClaudeMdExternalIncludesApproved: true,
      projectOnboardingSeenCount: 3,
      lastSessionId: 'sess-abc',
      lastCost: 1.23,
      lastTotalInputTokens: 5000,
      mcpServers: { foo: {} }
    },
    'D:/repo/two': { hasTrustDialogAccepted: false }
  }
};

test('copies no top-level keys at all', () => {
  const seed = extractSeedClaudeJson(PRIMARY);
  assert.deepStrictEqual(Object.keys(seed), ['projects']);
});

test('never copies the oauth account or user id', () => {
  const seed = extractSeedClaudeJson(PRIMARY);
  const serialised = JSON.stringify(seed);
  assert.ok(!serialised.includes('secret-account'));
  assert.ok(!serialised.includes('secret-user'));
  assert.strictEqual(seed.oauthAccount, undefined);
  assert.strictEqual(seed.userID, undefined);
});

test('copies only the allowlisted trust keys per project', () => {
  const seed = extractSeedClaudeJson(PRIMARY);
  assert.deepStrictEqual(Object.keys(seed.projects['D:/repo/one']).sort(), [
    'allowedTools',
    'hasClaudeMdExternalIncludesApproved',
    'hasTrustDialogAccepted',
    'projectOnboardingSeenCount'
  ]);
});

test('drops per-project session and cost telemetry', () => {
  const p = extractSeedClaudeJson(PRIMARY).projects['D:/repo/one'];
  assert.strictEqual(p.lastSessionId, undefined);
  assert.strictEqual(p.lastCost, undefined);
  assert.strictEqual(p.lastTotalInputTokens, undefined);
});

test('drops per-project mcpServers (the app scopes MCP explicitly at spawn)', () => {
  const p = extractSeedClaudeJson(PRIMARY).projects['D:/repo/one'];
  assert.strictEqual(p.mcpServers, undefined);
});

test('omits projects that have no allowlisted keys', () => {
  const seed = extractSeedClaudeJson({ projects: { 'D:/repo/x': { lastCost: 1 } } });
  assert.deepStrictEqual(seed.projects, {});
});

test('keeps a project whose trust was explicitly declined', () => {
  const seed = extractSeedClaudeJson(PRIMARY);
  assert.deepStrictEqual(seed.projects['D:/repo/two'], { hasTrustDialogAccepted: false });
});

test('tolerates missing/garbage input', () => {
  assert.deepStrictEqual(extractSeedClaudeJson(null), { projects: {} });
  assert.deepStrictEqual(extractSeedClaudeJson({}), { projects: {} });
  assert.deepStrictEqual(extractSeedClaudeJson({ projects: 'nope' }), { projects: {} });
  assert.deepStrictEqual(extractSeedClaudeJson({ projects: { a: null } }), { projects: {} });
});

test('the allowlist is exported and closed', () => {
  assert.deepStrictEqual([...TRUST_KEYS].sort(), [
    'allowedTools',
    'hasClaudeMdExternalIncludesApproved',
    'hasTrustDialogAccepted',
    'projectOnboardingSeenCount'
  ]);
});
