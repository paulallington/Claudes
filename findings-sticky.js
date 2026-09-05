// findings-sticky.js — renderer script for the always-on-top findings
// sticky note. Plain classic script (no bundler, no `require`); everything
// comes in over `window.electronAPI` (see preload.js's findings* bridge).
//
// No polling: the list is fetched once on load, then kept live purely by
// main's 'findings:updated' push (sent alongside the same push the main
// window's inbox view gets, from finalizeAgentRun's findings write hook).
// Finding text is model-authored — every dynamic value below goes through
// textContent, never innerHTML.

(function () {
  'use strict';

  var state = {
    findings: [],
    pinned: true // matches the window's actual default (alwaysOnTop: true)
  };

  function applyTheme(theme) {
    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  function buildRow(finding) {
    var row = document.createElement('div');
    row.className = 'fs-row';

    var body = document.createElement('div');
    body.className = 'fs-row-body';

    var summary = document.createElement('div');
    summary.className = 'fs-summary';
    summary.textContent = finding.summary || '(no summary)';
    body.appendChild(summary);

    var metaParts = [];
    if (finding.automationName) metaParts.push(finding.automationName);
    if (finding.occurrences > 1) metaParts.push('seen ' + finding.occurrences + ' times');
    if (metaParts.length) {
      var meta = document.createElement('div');
      meta.className = 'fs-meta';
      meta.textContent = metaParts.join(' · ');
      meta.title = meta.textContent;
      body.appendChild(meta);
    }

    var decisionEl = buildDecision(finding);
    if (decisionEl) body.appendChild(decisionEl);

    row.appendChild(body);

    var ackBtn = document.createElement('button');
    ackBtn.type = 'button';
    ackBtn.className = 'fs-ack-btn';
    ackBtn.title = 'Acknowledge';
    ackBtn.textContent = '✓';
    ackBtn.addEventListener('click', function () {
      acknowledge(finding.id);
    });
    row.appendChild(ackBtn);

    return row;
  }

  // Same decision rendering as the inbox (lib/findings-inbox-view.js),
  // reduced to this window's flatter DOM: option buttons + free-text box
  // while unresolved, a muted "Resolved as: X" line once answered.
  function buildDecision(finding) {
    var vm = window.FindingsInboxView.decisionViewModel(finding);
    if (!vm) return null;

    var wrap = document.createElement('div');
    wrap.className = 'fs-decision';

    if (vm.resolved) {
      var resolvedEl = document.createElement('div');
      resolvedEl.className = 'fs-resolution';
      resolvedEl.textContent = window.FindingsInboxView.resolutionSummaryLabel(finding) || 'Resolved';
      wrap.appendChild(resolvedEl);
      return wrap;
    }

    if (vm.prompt) {
      var promptEl = document.createElement('div');
      promptEl.className = 'fs-decision-prompt';
      promptEl.textContent = vm.prompt;
      wrap.appendChild(promptEl);
    }

    var optionsEl = document.createElement('div');
    optionsEl.className = 'fs-decision-options';
    vm.options.forEach(function (opt) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fs-decision-option-btn';
      btn.textContent = opt.label || opt.id || '';
      if (opt.hint) btn.title = opt.hint;
      btn.addEventListener('click', function () { resolve(finding.id, opt.id, null); });
      optionsEl.appendChild(btn);
    });
    wrap.appendChild(optionsEl);

    if (vm.freeText) {
      var freeTextEl = document.createElement('div');
      freeTextEl.className = 'fs-decision-freetext';
      var input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Type an answer…';
      var submitBtn = document.createElement('button');
      submitBtn.type = 'button';
      submitBtn.textContent = 'Send';
      var submit = function () {
        var text = input.value.trim();
        if (!text) return;
        resolve(finding.id, null, text);
      };
      submitBtn.addEventListener('click', submit);
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
      freeTextEl.appendChild(input);
      freeTextEl.appendChild(submitBtn);
      wrap.appendChild(freeTextEl);
    }

    return wrap;
  }

  function resolve(id, choiceId, text) {
    // Not removed optimistically like acknowledge() — the row still needs to
    // show the "Resolved as" state, not disappear, so just wait for the
    // findings:updated push (like loadFindings() does everywhere else).
    window.electronAPI.findingsResolve(id, { choiceId: choiceId, text: text }).then(function () {
      loadFindings();
    }).catch(function () { /* reconciled by next push */ });
  }

  function render() {
    var listEl = document.getElementById('fs-list');
    var emptyEl = document.getElementById('fs-empty');
    listEl.textContent = '';

    if (!state.findings.length) {
      listEl.classList.add('fs-hidden');
      emptyEl.classList.remove('fs-hidden');
      return;
    }

    emptyEl.classList.add('fs-hidden');
    listEl.classList.remove('fs-hidden');
    state.findings.forEach(function (finding) {
      listEl.appendChild(buildRow(finding));
    });
  }

  function loadFindings() {
    window.electronAPI.findingsList({ unacknowledgedOnly: true }).then(function (res) {
      state.findings = (res && res.ok && res.findings) || [];
      render();
    }).catch(function () {
      state.findings = [];
      render();
    });
  }

  function acknowledge(id) {
    // Optimistic removal so the row disappears immediately; loadFindings()
    // will still run on the next push and reconcile with the store.
    state.findings = state.findings.filter(function (f) { return f.id !== id; });
    render();
    window.electronAPI.findingsAcknowledge(id).catch(function () { /* reconciled by next push */ });
  }

  function applyPinButton() {
    var btn = document.getElementById('fs-pin');
    btn.classList.toggle('fs-pinned', state.pinned);
    btn.title = state.pinned ? 'Pinned on top — click to unpin' : 'Unpinned — click to pin on top';
  }

  function init() {
    var params = new URLSearchParams(window.location.search);
    applyTheme(params.get('theme'));
    if (window.electronAPI.onFindingsStickyTheme) {
      window.electronAPI.onFindingsStickyTheme(applyTheme);
    }

    applyPinButton();

    document.getElementById('fs-pin').addEventListener('click', function () {
      window.electronAPI.findingsStickyTogglePin().then(function (res) {
        if (res && res.ok) {
          state.pinned = !!res.pinned;
          applyPinButton();
        }
      }).catch(function () {});
    });

    document.getElementById('fs-close').addEventListener('click', function () {
      window.electronAPI.findingsCloseSticky().catch(function () {});
    });

    window.electronAPI.onFindingsUpdated(function () {
      loadFindings();
    });

    loadFindings();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
