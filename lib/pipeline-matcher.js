(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.PipelineMatcher = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {

  // Matches Claude Code's plan-mode indicator. Captured from 2.1.123:
  //   \x1b[38;2;72;150;140m\x1b[16;3H{bullet} plan mode on \x1b[38;2;153;153;153m(shift+tab to cycle)
  // Note the embedded CSI cursor-position escape (\x1b[16;3H) between the SGR
  // colour and the literal phrase. The gap is matched as a sequence of either
  // complete CSI escapes or non-ESC bytes, so embedded cursor moves don't break
  // detection while we still anchor on a nearby SGR to avoid false positives on
  // unstyled "plan mode on" appearing in conversation text.
  var PLAN_MODE_BANNER = /\x1b\[[\d;]*m(?:\x1b\[[\d;]*[A-Za-z]|[^\x1b]){0,80}?plan mode on/i;

  function matchKeyword(cmd, keywords) {
    if (typeof cmd !== 'string' || !Array.isArray(keywords)) return false;
    var c = cmd.trim().toLowerCase();
    if (!c) return false;
    for (var i = 0; i < keywords.length; i++) {
      var keyword = keywords[i];
      if (typeof keyword !== 'string') continue;
      var k = keyword.trim().toLowerCase();
      if (!k) continue;
      if (c === k) return true;
      if (c.indexOf(k + ' ') === 0) return true;
    }
    return false;
  }

  function findStepIdx(state, id) {
    if (!state || !Array.isArray(state.steps)) return -1;
    for (var i = 0; i < state.steps.length; i++) {
      if (state.steps[i] && state.steps[i].id === id) return i;
    }
    return -1;
  }

  function findExecuteIdx(state) {
    return findStepIdx(state, 'anchor-execute');
  }

  function applyPlanEnter(state, now) {
    if (!state) return false;
    if (state.flags && state.flags.plan === true) {
      state.lastBannerSeenAt = now;
      return false;
    }
    if (Array.isArray(state.steps)) {
      for (var i = 0; i < state.steps.length; i++) {
        if (state.steps[i]) state.steps[i].complete = false;
      }
    }
    var planIdx = findStepIdx(state, 'anchor-plan');
    state.currentIdx = (planIdx >= 0) ? planIdx : 0;
    if (!state.flags || typeof state.flags !== 'object') state.flags = {};
    state.flags.plan = true;
    state.visible = true;
    state.lastBannerSeenAt = now;
    return true;
  }

  function applyPlanExit(state) {
    if (!state) return false;
    if (!state.flags || typeof state.flags !== 'object') state.flags = {};
    state.flags.plan = false;
    var planIdx = findStepIdx(state, 'anchor-plan');
    if (planIdx >= 0 && state.steps[planIdx]) {
      state.steps[planIdx].complete = true;
    }
    var execIdx = findExecuteIdx(state);
    if (execIdx >= 0) state.currentIdx = execIdx;
    return true;
  }

  function shouldExitPlanMode(state, now) {
    if (!state || !state.flags || state.flags.plan !== true) return false;
    return (now - (state.lastBannerSeenAt || 0)) > 2000;
  }

  function applyKeywordMatch(state, cmd, pipelinesConfig) {
    if (!state) return false;
    if (state.flags && state.flags.plan) return false;
    if (typeof cmd !== 'string' || !cmd.trim()) return false;
    if (!pipelinesConfig || !pipelinesConfig.pipeline ||
        !Array.isArray(pipelinesConfig.pipeline.userSteps)) return false;
    if (!Array.isArray(state.steps)) return false;

    var userSteps = pipelinesConfig.pipeline.userSteps;
    for (var i = 0; i < userSteps.length; i++) {
      var us = userSteps[i];
      if (!us || !us.id || !Array.isArray(us.keywords)) continue;
      if (!matchKeyword(cmd, us.keywords)) continue;

      // Find this step's index in state.steps
      var stepIdx = -1;
      for (var s = 0; s < state.steps.length; s++) {
        if (state.steps[s] && state.steps[s].id === us.id) { stepIdx = s; break; }
      }
      if (stepIdx < 0) continue;
      if (stepIdx < (state.currentIdx || 0)) return false;
      state.steps[stepIdx].complete = true;
      state.currentIdx = stepIdx + 1;
      if (state.currentIdx > state.steps.length) state.currentIdx = state.steps.length;
      return true;
    }
    return false;
  }

  function buildPipelineState(persisted, defaultSteps) {
    var baseSteps = Array.isArray(defaultSteps) ? defaultSteps.map(function (s) {
      return { id: s.id, label: s.label, complete: !!s.complete };
    }) : [
      { id: 'anchor-plan', label: 'Plan', complete: false },
      { id: 'anchor-execute', label: 'Execute', complete: false }
    ];
    var state = {
      visible: false,
      steps: baseSteps,
      currentIdx: 0,
      flags: { plan: false },
      lastBannerSeenAt: 0,
      exitCheckIntervalId: null,
      restoredWithProgress: false
    };
    if (persisted && typeof persisted === 'object') {
      if (Array.isArray(persisted.steps) && persisted.steps.length > 0) {
        // Use persisted step list directly so progress is preserved across pipeline edits.
        state.steps = persisted.steps.map(function (s) {
          return { id: s.id, label: s.label, complete: !!s.complete };
        });
      }
      if (typeof persisted.currentIdx === 'number' && persisted.currentIdx >= 0) {
        state.currentIdx = Math.min(persisted.currentIdx, state.steps.length);
      }
      if (typeof persisted.visible === 'boolean') state.visible = persisted.visible;
      var anyComplete = state.steps.some(function (s) { return s.complete === true; });
      if (anyComplete || state.currentIdx > 0) state.restoredWithProgress = true;
    }
    return state;
  }

  function serializePipeline(pipelineState) {
    if (!pipelineState) return null;
    return {
      steps: (pipelineState.steps || []).map(function (s) {
        return { id: s.id, label: s.label, complete: !!s.complete };
      }),
      currentIdx: pipelineState.currentIdx || 0,
      visible: !!pipelineState.visible
    };
  }

  function applyManualToggle(state, idx) {
    if (!state || !Array.isArray(state.steps)) return false;
    if (typeof idx !== 'number' || idx < 0 || idx >= state.steps.length) return false;
    var step = state.steps[idx];
    if (!step) return false;
    if (step.complete === true) {
      step.complete = false;
      for (var j = idx + 1; j < state.steps.length; j++) {
        if (state.steps[j]) state.steps[j].complete = false;
      }
      state.currentIdx = idx;
    } else {
      step.complete = true;
      state.currentIdx = idx + 1;
      if (state.currentIdx > state.steps.length) state.currentIdx = state.steps.length;
    }
    return true;
  }

  return {
    PLAN_MODE_BANNER: PLAN_MODE_BANNER,
    matchKeyword: matchKeyword,
    applyPlanEnter: applyPlanEnter,
    applyPlanExit: applyPlanExit,
    applyKeywordMatch: applyKeywordMatch,
    applyManualToggle: applyManualToggle,
    shouldExitPlanMode: shouldExitPlanMode,
    buildPipelineState: buildPipelineState,
    serializePipeline: serializePipeline
  };
}));
