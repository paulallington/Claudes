(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexThreadState = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function isUuid(value) {
    return typeof value === 'string' && UUID_RE.test(value);
  }

  function createThreadState(threadId) {
    if (!isUuid(threadId)) return null;
    return {
      threadId: threadId,
      status: 'unknown',
      settings: {
        model: null,
        reasoningEffort: null,
        serviceTier: null,
        approvalPolicy: null,
        sandbox: null
      },
      context: {
        usedTokens: null,
        modelContextWindow: null,
        percent: null
      },
      compactedAt: null
    };
  }

  function finiteNonNegative(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  }

  function stringOrNull(value) {
    return typeof value === 'string' && value.length <= 200 ? value : null;
  }

  function normalizeStatus(status) {
    if (!status || typeof status !== 'object') return 'unknown';
    if (status.type === 'idle') return 'idle';
    if (status.type === 'systemError') return 'error';
    if (status.type !== 'active') return 'unknown';
    var flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
    if (flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput')) return 'needs-input';
    return 'running';
  }

  function copyState(state) {
    return {
      threadId: state.threadId,
      status: state.status,
      settings: Object.assign({}, state.settings),
      context: Object.assign({}, state.context),
      compactedAt: state.compactedAt
    };
  }

  function reduceThreadNotification(previous, message) {
    if (!previous || !message || typeof message !== 'object') return previous;
    var params = message.params;
    if (!params || params.threadId !== previous.threadId) return previous;
    var next = copyState(previous);

    if (message.method === 'thread/status/changed') {
      next.status = normalizeStatus(params.status);
      return next;
    }

    if (message.method === 'thread/settings/updated') {
      var settings = params.threadSettings || {};
      var sandbox = settings.sandboxPolicy;
      var approval = settings.approvalPolicy;
      next.settings = {
        model: stringOrNull(settings.model),
        reasoningEffort: stringOrNull(settings.effort),
        serviceTier: stringOrNull(settings.serviceTier),
        approvalPolicy: typeof approval === 'string' ? stringOrNull(approval) : (approval && approval.granular ? 'granular' : null),
        sandbox: sandbox && typeof sandbox === 'object' ? stringOrNull(sandbox.type) : stringOrNull(sandbox)
      };
      return next;
    }

    if (message.method === 'thread/tokenUsage/updated') {
      var usage = params.tokenUsage || {};
      var used = finiteNonNegative(usage.last && usage.last.totalTokens);
      var windowSize = finiteNonNegative(usage.modelContextWindow);
      var percent = used !== null && windowSize > 0
        ? Math.min(100, Math.round((used / windowSize) * 1000) / 10)
        : null;
      next.context = {
        usedTokens: used,
        modelContextWindow: windowSize,
        percent: percent
      };
      return next;
    }

    var compacted = message.method === 'thread/compacted'
      || (message.method === 'item/completed' && params.item && params.item.type === 'contextCompaction');
    if (compacted) {
      var at = finiteNonNegative(message.emittedAtMs);
      if (at === null) at = finiteNonNegative(params.completedAtMs);
      next.compactedAt = at;
      return next;
    }

    return previous;
  }

  return {
    isUuid: isUuid,
    createThreadState: createThreadState,
    normalizeStatus: normalizeStatus,
    reduceThreadNotification: reduceThreadNotification
  };
});
