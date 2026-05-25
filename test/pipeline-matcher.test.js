const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// TODO: DOM rendering not unit-tested — covered by manual e2e step 10

const {
  PLAN_MODE_BANNER,
  matchKeyword,
  applyPlanEnter,
  applyPlanExit,
  applyKeywordMatch,
  applyManualToggle,
  shouldExitPlanMode,
  serializePipeline,
  buildPipelineState,
} = require('../lib/pipeline-matcher');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides) {
  return Object.assign(
    {
      steps: [
        { id: 'anchor-plan',    label: 'Plan',    complete: false },
        { id: 'step-review',    label: 'Review',  complete: false },
        { id: 'anchor-execute', label: 'Execute', complete: false },
        { id: 'step-test',      label: 'Test',    complete: false },
        { id: 'step-done',      label: 'Done',    complete: false },
      ],
      currentIdx: 0,
      visible: false,
      flags: { plan: false },
      lastBannerSeenAt: 0,
      bannerTail: '',
      exitCheckIntervalId: null,
    },
    overrides
  );
}

// ---------------------------------------------------------------------------
// 1. PLAN_MODE_BANNER regex matches
// ---------------------------------------------------------------------------

test('PLAN_MODE_BANNER: matches Claude 2.1.123 captured shape (24-bit RGB foreground)', () => {
  // Real bytes captured from Claude Code 2.1.123 entering plan mode:
  // \x1b[38;2;72;150;140m{bullet} plan mode on \x1b[38;2;153;153;153m(shift+tab to cycle)
  const input = '\x1b[38;2;72;150;140m⯏ plan mode on \x1b[38;2;153;153;153m(shift+tab to cycle)';
  assert.ok(PLAN_MODE_BANNER.test(input));
});

test('PLAN_MODE_BANNER: matches Claude 2.1.123 real captured bytes (with CUP escape between SGR and phrase)', () => {
  // Actual byte stream from Claude Code 2.1.123 — includes a CSI cursor-position
  // escape (\x1b[16;3H) between the 24-bit RGB SGR colour and the pause glyph.
  // The original hand-written test omitted this escape, masking a real-world bug.
  const input = '\x1b[38;2;72;150;140m\x1b[16;3H⏸ plan mode on \x1b[38;2;153;153;153m(shift+tab to cycle)';
  assert.ok(PLAN_MODE_BANNER.test(input));
});

test('PLAN_MODE_BANNER: matches simple SGR + literal phrase', () => {
  assert.ok(PLAN_MODE_BANNER.test('\x1b[7m plan mode on \x1b[0m'));
  assert.ok(PLAN_MODE_BANNER.test('\x1b[1;36m plan mode on'));
});

test('PLAN_MODE_BANNER: case-insensitive on the phrase', () => {
  assert.ok(PLAN_MODE_BANNER.test('\x1b[7m Plan Mode On'));
  assert.ok(PLAN_MODE_BANNER.test('\x1b[7m PLAN MODE ON'));
});

test('PLAN_MODE_BANNER: does not match unstyled "plan mode on" (no SGR prefix)', () => {
  // Conversation text Claude generates in plain output — no leading SGR escape
  // within the 40-byte gap. Must not false-positive.
  assert.ok(!PLAN_MODE_BANNER.test('plan mode on'));
  assert.ok(!PLAN_MODE_BANNER.test('I will turn plan mode on shortly'));
});

test('PLAN_MODE_BANNER: does not match when SGR escape is far from phrase (plain-byte gap)', () => {
  // 100 plain bytes between the SGR and the phrase. Each plain byte counts
  // as one unit under the regex's {0,80} cap, so 100 > 80 → rejected.
  // (Note: a CSI escape in the gap counts as a *single* unit regardless of
  // its byte length, so the cap bounds units, not raw bytes.)
  const input = '\x1b[7m' + 'x'.repeat(100) + 'plan mode on';
  assert.ok(!PLAN_MODE_BANNER.test(input));
});

// ---------------------------------------------------------------------------
// 2. Banner regex against split-chunk concatenation
// ---------------------------------------------------------------------------

test('PLAN_MODE_BANNER: matches across split chunks when concatenated', () => {
  const prevTail = '\x1b[38;2;72;150;140m⯏ plan ';
  const chunk    = 'mode on \x1b[0m';
  assert.ok(PLAN_MODE_BANNER.test(prevTail + chunk));
  assert.ok(!PLAN_MODE_BANNER.test(chunk));
});

// ---------------------------------------------------------------------------
// 3. matchKeyword
// ---------------------------------------------------------------------------

test('matchKeyword: returns true on exact match', () => {
  // (a)
  assert.ok(matchKeyword('/test', ['/test']));
});

test('matchKeyword: returns true when keyword is prefix followed by space', () => {
  // (b)
  assert.ok(matchKeyword('/test foo', ['/test']));
});

test('matchKeyword: returns false on same-prefix imposter', () => {
  // (c)
  assert.ok(!matchKeyword('/test-foo', ['/test']));
});

test('matchKeyword: case-insensitive', () => {
  // (d)
  assert.ok(matchKeyword('/Test', ['/test']));
  assert.ok(matchKeyword('/TEST', ['/test']));
});

test('matchKeyword: returns false when keywords array is empty', () => {
  // (e)
  assert.ok(!matchKeyword('/test', []));
});

test('matchKeyword: multi-keyword — both /test and /check match their respective inputs', () => {
  // (f)
  const kws = ['/test', '/check'];
  assert.ok(matchKeyword('/test', kws));
  assert.ok(matchKeyword('/check', kws));
  assert.ok(matchKeyword('/test foo', kws));
  assert.ok(matchKeyword('/check foo', kws));
});

// ---------------------------------------------------------------------------
// 4. applyPlanEnter — first call (flags.plan=false)
// ---------------------------------------------------------------------------

test('applyPlanEnter: first call resets state, returns true', () => {
  const state = makeState({
    steps: [
      { id: 'anchor-plan',    label: 'Plan',    complete: true },
      { id: 'anchor-execute', label: 'Execute', complete: true },
    ],
    currentIdx: 2,
    flags: { plan: false },
    lastBannerSeenAt: 0,
    bannerTail: 'leftover',
    visible: false,
  });
  const now = 9999;
  const result = applyPlanEnter(state, now);
  assert.strictEqual(result, true);
  for (const step of state.steps) assert.strictEqual(step.complete, false);
  assert.strictEqual(state.currentIdx, 0);
  assert.strictEqual(state.flags.plan, true);
  assert.strictEqual(state.visible, true);
  assert.strictEqual(state.lastBannerSeenAt, now);
});

// ---------------------------------------------------------------------------
// 5. applyPlanEnter — re-render call (flags.plan=true)
// ---------------------------------------------------------------------------

test('applyPlanEnter: re-render call refreshes timestamp only, returns false', () => {
  const state = makeState({
    steps: [
      { id: 'anchor-plan',    label: 'Plan',    complete: true },
      { id: 'anchor-execute', label: 'Execute', complete: false },
    ],
    currentIdx: 2,
    flags: { plan: true },
    lastBannerSeenAt: 1000,
    bannerTail: 'tail',
    visible: true,
  });
  const result = applyPlanEnter(state, 5000);
  assert.strictEqual(result, false);
  assert.strictEqual(state.lastBannerSeenAt, 5000);
  assert.strictEqual(state.steps[0].complete, true);
  assert.strictEqual(state.currentIdx, 2);
  assert.strictEqual(state.visible, true);
});

// ---------------------------------------------------------------------------
// 6. shouldExitPlanMode
// ---------------------------------------------------------------------------

test('shouldExitPlanMode: returns false when flags.plan is false', () => {
  // (a)
  const state = makeState({ flags: { plan: false }, lastBannerSeenAt: 0 });
  assert.strictEqual(shouldExitPlanMode(state, 9999), false);
});

test('shouldExitPlanMode: returns false at exactly 2000ms boundary (strict >)', () => {
  // (b)
  const state = makeState({ flags: { plan: true }, lastBannerSeenAt: 1000 });
  assert.strictEqual(shouldExitPlanMode(state, 3000), false);
});

test('shouldExitPlanMode: returns true when gap is 2001ms', () => {
  // (c)
  const state = makeState({ flags: { plan: true }, lastBannerSeenAt: 1000 });
  assert.strictEqual(shouldExitPlanMode(state, 3001), true);
});

test('shouldExitPlanMode: returns false when flags.plan is false even if gap > 2000', () => {
  // (d)
  const state = makeState({ flags: { plan: false }, lastBannerSeenAt: 0 });
  assert.strictEqual(shouldExitPlanMode(state, 5000), false);
});

// ---------------------------------------------------------------------------
// 7. applyPlanExit
// ---------------------------------------------------------------------------

test('applyPlanExit: sets flags.plan false, marks anchor-plan complete, advances to anchor-execute', () => {
  const state = makeState({
    steps: [
      { id: 'anchor-plan',    label: 'Plan',    complete: false },
      { id: 'step-review',    label: 'Review',  complete: false },
      { id: 'anchor-execute', label: 'Execute', complete: false },
    ],
    flags: { plan: true },
  });
  const result = applyPlanExit(state);
  assert.strictEqual(result, true);
  assert.strictEqual(state.flags.plan, false);
  assert.strictEqual(state.steps.find(s => s.id === 'anchor-plan').complete, true);
  const execIdx = state.steps.findIndex(s => s.id === 'anchor-execute');
  assert.strictEqual(state.currentIdx, execIdx);
});

test('applyPlanEnter: finds anchor-plan by id when not at index 0', () => {
  const state = makeState({
    steps: [
      { id: 'step-foo',       label: 'Foo',     complete: false },
      { id: 'anchor-plan',    label: 'Plan',    complete: false },
      { id: 'anchor-execute', label: 'Execute', complete: false },
      { id: 'step-bar',       label: 'Bar',     complete: false },
    ],
    flags: { plan: false },
  });
  const result = applyPlanEnter(state, 1234);
  assert.strictEqual(result, true);
  assert.strictEqual(state.currentIdx, 1);
});

test('applyPlanExit: marks anchor-plan complete by id (not index 0) and advances to anchor-execute', () => {
  const state = makeState({
    steps: [
      { id: 'step-foo',       label: 'Foo',     complete: false },
      { id: 'anchor-plan',    label: 'Plan',    complete: false },
      { id: 'anchor-execute', label: 'Execute', complete: false },
      { id: 'step-bar',       label: 'Bar',     complete: false },
    ],
    flags: { plan: true },
  });
  const result = applyPlanExit(state);
  assert.strictEqual(result, true);
  assert.strictEqual(state.steps[1].complete, true);
  assert.strictEqual(state.steps[0].complete, false);
  assert.strictEqual(state.currentIdx, 2);
});

// ---------------------------------------------------------------------------
// 8. applyKeywordMatch
// ---------------------------------------------------------------------------

test('applyKeywordMatch: returns false and mutates nothing when flags.plan is true', () => {
  // (a)
  const state = makeState({ flags: { plan: true } });
  const config = {
    pipeline: {
      userSteps: [{ id: 'step-test', keywords: ['/test'] }],
    },
  };
  const before = JSON.stringify(state);
  const result = applyKeywordMatch(state, '/test', config);
  assert.strictEqual(result, false);
  assert.strictEqual(JSON.stringify(state), before);
});

test('applyKeywordMatch: returns true and advances currentIdx when match found', () => {
  // (b)
  const state = makeState({
    steps: [
      { id: 'anchor-plan',    label: 'Plan',    complete: true },
      { id: 'anchor-execute', label: 'Execute', complete: true },
      { id: 'step-test',      label: 'Test',    complete: false },
      { id: 'step-done',      label: 'Done',    complete: false },
    ],
    currentIdx: 2,
    flags: { plan: false },
  });
  const config = {
    pipeline: {
      userSteps: [{ id: 'step-test', keywords: ['/test'] }],
    },
  };
  const result = applyKeywordMatch(state, '/test', config);
  assert.strictEqual(result, true);
  const testIdx = state.steps.findIndex(s => s.id === 'step-test');
  assert.strictEqual(state.steps[testIdx].complete, true);
  assert.strictEqual(state.currentIdx, testIdx + 1);
});

test('applyKeywordMatch: returns false when no keyword matches', () => {
  // (c)
  const state = makeState({ flags: { plan: false } });
  const config = {
    pipeline: {
      userSteps: [{ id: 'step-test', keywords: ['/test'] }],
    },
  };
  const before = JSON.stringify(state);
  const result = applyKeywordMatch(state, '/unrelated', config);
  assert.strictEqual(result, false);
  assert.strictEqual(JSON.stringify(state), before);
});

test('applyKeywordMatch: first-step-with-any-match wins when two steps share overlapping keyword', () => {
  // (d)
  const state = makeState({
    steps: [
      { id: 'step-a', label: 'A', complete: false },
      { id: 'step-b', label: 'B', complete: false },
    ],
    currentIdx: 0,
    flags: { plan: false },
  });
  const config = {
    pipeline: {
      userSteps: [
        { id: 'step-a', keywords: ['/run'] },
        { id: 'step-b', keywords: ['/run'] },
      ],
    },
  };
  const result = applyKeywordMatch(state, '/run', config);
  assert.strictEqual(result, true);
  assert.strictEqual(state.steps[0].complete, true);
  assert.strictEqual(state.steps[1].complete, false);
  assert.strictEqual(state.currentIdx, 1);
});

test('applyKeywordMatch: multi-keyword step — /test and /check both advance the same step', () => {
  // (e)
  const makeMultiState = () => makeState({
    steps: [
      { id: 'anchor-execute', label: 'Execute', complete: true },
      { id: 'step-verify',    label: 'Verify',  complete: false },
    ],
    currentIdx: 1,
    flags: { plan: false },
  });
  const config = {
    pipeline: {
      userSteps: [{ id: 'step-verify', keywords: ['/test', '/check'] }],
    },
  };

  let state = makeMultiState();
  assert.strictEqual(applyKeywordMatch(state, '/test', config), true);
  assert.strictEqual(state.steps.find(s => s.id === 'step-verify').complete, true);

  state = makeMultiState();
  assert.strictEqual(applyKeywordMatch(state, '/check', config), true);
  assert.strictEqual(state.steps.find(s => s.id === 'step-verify').complete, true);

  state = makeMultiState();
  assert.strictEqual(applyKeywordMatch(state, '/test with args', config), true);
  assert.strictEqual(state.steps.find(s => s.id === 'step-verify').complete, true);

  state = makeMultiState();
  assert.strictEqual(applyKeywordMatch(state, '/check with args', config), true);
  assert.strictEqual(state.steps.find(s => s.id === 'step-verify').complete, true);
});

// ---------------------------------------------------------------------------
// 9. applyManualToggle on not-complete step at index i
// ---------------------------------------------------------------------------

test('applyManualToggle: toggling not-complete step marks it complete, advances pointer', () => {
  const state = makeState({
    steps: [
      { id: 's0', label: '0', complete: true  },
      { id: 's1', label: '1', complete: false }, // target
      { id: 's2', label: '2', complete: false },
    ],
    currentIdx: 1,
  });
  const i = 1;
  applyManualToggle(state, i);
  assert.strictEqual(state.steps[i].complete, true);
  assert.strictEqual(state.currentIdx, Math.min(i + 1, state.steps.length));
  assert.strictEqual(state.steps[0].complete, true);
  assert.strictEqual(state.steps[2].complete, false);
});

// ---------------------------------------------------------------------------
// 10. applyManualToggle on complete step at index i (cascade)
// ---------------------------------------------------------------------------

test('applyManualToggle: toggling complete step uncompletes it and cascades', () => {
  const state = makeState({
    steps: [
      { id: 's0', label: '0', complete: true  },
      { id: 's1', label: '1', complete: true  }, // target i=1
      { id: 's2', label: '2', complete: true  },
      { id: 's3', label: '3', complete: true  },
    ],
    currentIdx: 3,
  });
  const i = 1;
  applyManualToggle(state, i);
  assert.strictEqual(state.steps[i].complete, false);
  for (let j = i + 1; j < state.steps.length; j++) {
    assert.strictEqual(state.steps[j].complete, false);
  }
  assert.strictEqual(state.currentIdx, i);
  assert.strictEqual(state.steps[0].complete, true);
});

// ---------------------------------------------------------------------------
// 11. Click current pill (idx === currentIdx, complete === false)
// ---------------------------------------------------------------------------

test('applyManualToggle: clicking current incomplete pill advances pointer to idx+1', () => {
  // covered by test 9 logic; explicit assertion for the pointer
  const state = makeState({
    steps: [
      { id: 's0', label: '0', complete: false },
      { id: 's1', label: '1', complete: false },
    ],
    currentIdx: 0,
  });
  applyManualToggle(state, 0);
  assert.strictEqual(state.currentIdx, 1);
});

// ---------------------------------------------------------------------------
// 12. Click earlier-than-currentIdx not-complete pill
// ---------------------------------------------------------------------------

test('applyManualToggle: clicking not-complete pill behind currentIdx moves leading edge backward', () => {
  const state = makeState({
    steps: [
      { id: 's0', label: '0', complete: true  },
      { id: 's1', label: '1', complete: false }, // click here, idx=1
      { id: 's2', label: '2', complete: false },
      { id: 's3', label: '3', complete: false }, // currentIdx=3
    ],
    currentIdx: 3,
  });
  applyManualToggle(state, 1);
  assert.strictEqual(state.steps[1].complete, true);
  assert.strictEqual(state.currentIdx, 2);
});

// ---------------------------------------------------------------------------
// 13. State serialization round-trip (skipped if not exported)
// ---------------------------------------------------------------------------

test('serializePipeline / buildPipelineState: round-trip strips and restores transients', () => {
  if (typeof serializePipeline !== 'function' || typeof buildPipelineState !== 'function') {
    // Implementer did not export these — skip
    return;
  }
  const state = makeState({
    steps: [
      { id: 's0', label: '0', complete: true  },
      { id: 's1', label: '1', complete: false },
    ],
    currentIdx: 1,
    visible: true,
    flags: { plan: true },
    lastBannerSeenAt: 12345,
    bannerTail: 'abc',
    exitCheckIntervalId: 42,
  });

  const serialized = serializePipeline(state);
  const keys = Object.keys(serialized).sort();
  assert.deepEqual(keys, ['currentIdx', 'steps', 'visible']);

  const restored = buildPipelineState(serialized);
  assert.deepEqual(restored.steps, state.steps);
  assert.strictEqual(restored.currentIdx, state.currentIdx);
  assert.strictEqual(restored.visible, state.visible);
  assert.deepEqual(restored.flags, { plan: false });
  assert.strictEqual(restored.lastBannerSeenAt, 0);
  assert.strictEqual(restored.exitCheckIntervalId, null);
});

// ---------------------------------------------------------------------------
// 14. UMD dual-export
// ---------------------------------------------------------------------------

test('UMD: CommonJS require populates exports object', () => {
  const mod = require('../lib/pipeline-matcher');
  assert.ok(mod && typeof mod === 'object');
  assert.ok(typeof mod.matchKeyword === 'function');
  assert.ok(typeof mod.applyPlanEnter === 'function');
});

test('UMD: browser path (module undefined) populates globalThis.PipelineMatcher', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'pipeline-matcher.js'),
    'utf8'
  );
  const sandbox = vm.createContext({ globalThis: {}, console });
  // Evaluate without a `module` variable — simulates browser / non-CJS environment
  vm.runInContext(src, sandbox);
  const exported = sandbox.globalThis.PipelineMatcher;
  assert.ok(exported && typeof exported === 'object', 'globalThis.PipelineMatcher should be set');
  assert.ok(typeof exported.matchKeyword === 'function');
});
