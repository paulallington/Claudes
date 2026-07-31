// Pure helpers for spawning a Codex CLI column and distinguishing it from a
// Claude column. Extracted so the logic is unit-testable without a DOM.
//
// Loaded two ways:
//   - Node (main.js + tests): require('./lib/codex-spawn') via module.exports.
//   - Renderer: <script src="lib/codex-spawn.js"> — the renderer runs under
//     contextIsolation:true / nodeIntegration:false and cannot require(), so the
//     API is also attached to window. Same UMD pattern as lib/permission-mode.js.

'use strict';

(function () {
  // Which command resolves an executable's path on this platform.
  function codexLookupCommand(platform) {
    return platform === 'win32' ? 'where' : 'which';
  }

  // First non-empty line of `where`/`which` output, or null if none.
  function parseWhichOutput(raw) {
    if (!raw) return null;
    var lines = String(raw).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var trimmed = lines[i].trim();
      if (trimmed) return trimmed;
    }
    return null;
  }

  // Curated approval presets → Codex CLI flags. Order here is the dropdown order.
  // (Codex has two independent axes: -a approval and -s sandbox; plus a bypass flag.)
  var CODEX_APPROVAL_PRESETS = [
    { key: 'read-only', label: 'Read Only', args: ['-a', 'untrusted', '-s', 'read-only'] },
    { key: 'auto', label: 'Auto', args: ['-a', 'on-request', '-s', 'workspace-write'] },
    { key: 'full-access', label: 'Full Access', args: ['-a', 'never', '-s', 'danger-full-access'] },
    { key: 'yolo', label: 'Yolo (bypass)', args: ['--dangerously-bypass-approvals-and-sandbox'] },
    { key: 'codex-default', label: 'Codex default', args: [] }
  ];
  var DEFAULT_CODEX_APPROVAL = 'auto';

  function findPreset(key) {
    for (var i = 0; i < CODEX_APPROVAL_PRESETS.length; i++) {
      if (CODEX_APPROVAL_PRESETS[i].key === key) return CODEX_APPROVAL_PRESETS[i];
    }
    return null;
  }

  // Preset key -> flag args. Unknown/undefined -> [] (Codex uses its own default).
  // Returns a fresh array so callers can't mutate the preset table.
  function codexApprovalArgs(key) {
    var p = findPreset(key);
    return p ? p.args.slice() : [];
  }

  /**
   * Recover {model, effort, tier} from a spawned column's cmdArgs, so a
   * restored column can report what it is actually running rather than what the
   * picker currently says. Tolerates the flags appearing in any order.
   * @param {string[]} args
   * @returns {{model: string, effort: string, tier: string}}
   */
  function codexTuningFromArgs(args) {
    var out = { model: '', effort: '', tier: '' };
    if (!args) return out;
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if ((a === '--model' || a === '-m') && i + 1 < args.length) { out.model = args[i + 1]; i++; continue; }
      if (typeof a === 'string' && a.indexOf('--model=') === 0) { out.model = a.slice('--model='.length); continue; }
      if (a === '-c' && i + 1 < args.length) {
        var kv = String(args[i + 1]);
        if (kv.indexOf('model_reasoning_effort=') === 0) out.effort = kv.slice('model_reasoning_effort='.length);
        else if (kv.indexOf('service_tier=') === 0) out.tier = kv.slice('service_tier='.length);
        i++;
      }
    }
    return out;
  }

  // Drop the tuning flags so the approval preset can still be matched exactly.
  // Without this, appending --model/-c to a preset's args makes every column's
  // badge read 'Custom' — the reverse map compares the WHOLE array.
  function stripTuningArgs(args) {
    var out = [];
    for (var i = 0; i < (args || []).length; i++) {
      var a = args[i];
      if ((a === '--model' || a === '-m') && i + 1 < args.length) { i++; continue; }
      if (typeof a === 'string' && a.indexOf('--model=') === 0) continue;
      if (a === '-c' && i + 1 < args.length) {
        var kv = String(args[i + 1]);
        if (kv.indexOf('model_reasoning_effort=') === 0 || kv.indexOf('service_tier=') === 0) { i++; continue; }
      }
      out.push(a);
    }
    return out;
  }

  // Reverse map: flag args -> preset label, for the column badge tooltip (works on
  // restore, where only cmdArgs survive). [] -> 'Codex default'; unmatched -> 'Custom'.
  // Tuning flags are stripped first so they don't turn every badge into 'Custom'.
  function codexApprovalLabelFromArgs(args) {
    var base = stripTuningArgs(args || []);
    var hit = matchPresetByPrefix(base);
    if (hit) return hit.label;
    return base.length ? 'Custom' : 'Codex default';
  }

  // Reverse map to the preset KEY (not the label) so a restored column can be
  // rebuilt from its semantic settings rather than from stored argv.
  function codexPresetKeyFromArgs(args) {
    var hit = matchPresetByPrefix(stripTuningArgs(args || []));
    return hit ? hit.key : null;
  }

  /**
   * Match a preset by PREFIX rather than whole-array equality.
   *
   * Whole-array equality broke twice: once when tuning flags were appended, and
   * again when the handoff appended a positional seed prompt. A
   * strip-the-trailing-positional heuristic cannot fix it either — it cannot
   * tell a boolean flag from a value-taking one, so with the bypass preset
   * (a lone boolean flag) it mistakes the prompt for that flag's value.
   *
   * A preset matches when its flags are a prefix of the argv AND nothing after
   * them is a flag — trailing positionals (the prompt) are allowed, stray flags
   * are not. Longest preset wins so the empty 'codex-default' can't shadow a
   * real one.
   *
   * @param {string[]} args argv with tuning flags already stripped
   * @returns {object|null} the matching preset
   */
  function matchPresetByPrefix(args) {
    var list = args || [];
    var best = null;
    for (var i = 0; i < CODEX_APPROVAL_PRESETS.length; i++) {
      var p = CODEX_APPROVAL_PRESETS[i];
      if (p.args.length > list.length) continue;
      var ok = true;
      for (var j = 0; j < p.args.length; j++) {
        if (list[j] !== p.args[j]) { ok = false; break; }
      }
      if (!ok) continue;
      // everything after the preset's flags must be positional
      for (var k = p.args.length; k < list.length; k++) {
        if (typeof list[k] === 'string' && list[k].charAt(0) === '-') { ok = false; break; }
      }
      if (!ok) continue;
      if (!best || p.args.length > best.args.length) best = p;
    }
    return best;
  }

  /**
   * Rebuild a Codex spawn from a PERSISTED session entry.
   *
   * SECURITY: `<project>/.claudes/sessions.json` lives inside the repository,
   * so it is attacker-controlled — a hostile repo can ship one and it is read
   * automatically when the project is opened. It must therefore never be able
   * to name a program or supply free-form argv. This function is the whole
   * defence: the command is OUR constant, and every value out of the file is
   * validated against the catalogue before use. Anything unrecognised is
   * dropped rather than passed through.
   *
   * Returns null for an entry that is not a recognised Codex column, which
   * includes any legacy entry carrying a raw `cmd`/`cmdArgs` — those are the
   * exact shape of the vector and are deliberately not honoured.
   *
   * @param {object} entry persisted session entry
   * @param {string} cwd
   * @param {object} models the CodexModels catalogue (injected so this stays pure)
   * @returns {{args: string[], opts: object}|null}
   */
  function buildCodexRestore(entry, cwd, models) {
    if (!entry || entry.kind !== 'codex') return null;
    var preset = findPreset(entry.codexPreset) ? entry.codexPreset : DEFAULT_CODEX_APPROVAL;
    var tuning = { model: '', effort: '', tier: '' };
    if (models) {
      if (models.isKnownModel(entry.codexModel)) tuning.model = entry.codexModel;
      if (models.isKnownEffort(entry.codexEffort)) tuning.effort = entry.codexEffort;
      if (models.isKnownTier(entry.codexTier)) tuning.tier = entry.codexTier;
    }
    var spec = buildCodexSpawn(cwd, preset, tuning);
    if (isCodexThreadId(entry.codexThreadId)) spec.opts.codexThreadId = entry.codexThreadId;
    return spec;
  }

  /**
   * The persistable, non-executable description of a Codex column, derived from
   * its live argv. Contains only enum values the catalogue can validate — never
   * a program name and never free-form arguments.
   * @param {string[]} args
   * @returns {{kind: string, codexPreset: string|null, codexModel: string, codexEffort: string, codexTier: string}}
   */
  function codexPersistShape(args, threadId, managed) {
    var tuning = codexTuningFromArgs(args);
    var shape = {
      kind: 'codex',
      codexPreset: codexPresetKeyFromArgs(args),
      codexModel: tuning.model,
      codexEffort: tuning.effort,
      codexTier: tuning.tier
    };
    if (managed === true && isCodexThreadId(threadId)) shape.codexThreadId = threadId;
    return shape;
  }

  // Descriptor for spawning a Codex column via addColumn(args, row, opts).
  // Deliberately carries NO Claude-specific fields — a Codex column must never
  // pick up permission-mode / model / headroom / endpoint plumbing. `preset` maps
  // to approval/sandbox flags; omitted -> [] (Codex default), preserving old callers.
  function buildCodexSpawn(cwd, preset, tuning) {
    // No `title` — createColumnHeader derives "Codex #<id>" (matching the
    // "Claude #<id>" convention) so the column name doesn't duplicate the badge.
    return {
      args: codexApprovalArgs(preset).concat(codexTuningArgs(tuning)),
      opts: { cmd: 'codex', cwd: cwd == null ? null : cwd }
    };
  }

  /**
   * Model / reasoning-effort / service-tier flags, appended after the approval
   * preset's flags.
   *
   * Every axis is opt-in: an empty or omitted value emits nothing, so the CLI
   * falls back to ~/.codex/config.toml exactly as it did before this existed.
   * That matters — a Codex column spawned with no explicit choice must behave
   * identically to one spawned by the old two-argument signature.
   *
   * `--model` is a first-class flag; effort and tier are config overrides
   * (`-c key=value`), which is the CLI's documented mechanism for them.
   *
   * Values are NOT validated against the catalogue here. The catalogue is what
   * the picker offers, but a hand-edited persisted value should still be passed
   * through rather than silently dropped — the CLI is the authority on what it
   * accepts, not us. We only refuse values that would corrupt the argv itself.
   *
   * @param {{model?: string, effort?: string, tier?: string}} tuning
   * @returns {string[]}
   */
  function codexTuningArgs(tuning) {
    if (!tuning) return [];
    var args = [];
    var model = safeArgValue(tuning.model);
    var effort = safeArgValue(tuning.effort);
    var tier = safeArgValue(tuning.tier);
    if (model) args.push('--model', model);
    if (effort) args.push('-c', 'model_reasoning_effort=' + effort);
    if (tier) args.push('-c', 'service_tier=' + tier);
    return args;
  }

  // A tuning value reaches argv directly, so reject anything that isn't a plain
  // scalar token: whitespace would split into extra argv entries, and a leading
  // dash would be read as another flag. Returns '' for anything unusable.
  function safeArgValue(v) {
    if (v == null) return '';
    var s = String(v).trim();
    if (!s) return '';
    // Strict allow-list, not a deny-list: these values reach argv, and on
    // Windows pty-server can fall back to `cmd.exe /c`, where &, |, >, ^ are
    // shell-active. Anything outside [A-Za-z0-9._-] is refused.
    // Must not START with a dash, or the value is read as another flag —
    // `effort: '--dangerously-bypass-approvals-and-sandbox'` is all letters and
    // dashes, so a charset check alone lets it through. Both rules are needed.
    if (!/^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(s)) return '';
    return s;
  }

  function isCodexThreadId(value) {
    return typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  function isCodexClaimId(value) {
    return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
  }

  function safeLoopbackRemoteUrl(value) {
    if (typeof value !== 'string') return '';
    var match = /^ws:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(value);
    if (!match) return '';
    var port = Number(match[1]);
    return port > 0 && port <= 65535 ? value : '';
  }

  function safeCodexPrompt(value, fresh) {
    if (typeof value !== 'string') return '';
    var prompt = value.trim();
    if (!prompt || /[\x00-\x1f\x7f&|<>^%!"()]/.test(prompt)) return '';
    if (fresh && (isCodexThreadId(prompt) || /^(exec|e|review|login|logout|mcp|plugin|mcp-server|app-server|remote-control|app|completion|update|doctor|sandbox|debug|apply|a|resume|archive|delete|unarchive|fork|cloud|exec-server|features|help)$/.test(prompt))) return '';
    return prompt;
  }

  function safeCodexWorkingDirectory(value) {
    if (typeof value !== 'string') return '';
    var cwd = value.trim();
    if (!cwd || /[\x00-\x1f\x7f]/.test(cwd)) return '';
    if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(cwd)) return '';
    return cwd;
  }

  /**
   * Build the actual argv used to attach the normal Codex TUI to Claudes'
   * authenticated app-server. The semantic argv is parsed then rebuilt so a
   * persisted data file can never smuggle arbitrary flags onto this trusted
   * spawn. Bridge coordinates are loopback-only and never returned by
   * codexPersistShape.
   */
  function buildCodexRemoteAttach(semanticArgs, prepared, prompt) {
    if (!prepared || (prepared.mode !== 'fresh' && prepared.mode !== 'resume')) return null;
    var remoteUrl = safeLoopbackRemoteUrl(prepared.remoteUrl);
    var envName = typeof prepared.remoteTokenEnvName === 'string'
      ? prepared.remoteTokenEnvName : '';
    if (!remoteUrl || !/^CLAUDES_CODEX_[A-Z0-9_]+$/.test(envName)) return null;

    var preset = codexPresetKeyFromArgs(semanticArgs || []);
    var tuning = codexTuningFromArgs(semanticArgs || []);
    var safeSemantic = buildCodexSpawn(null, preset || 'codex-default', tuning).args;
    var out;
    if (prepared.mode === 'resume') {
      if (prepared.claimId != null || !isCodexThreadId(prepared.threadId)) return null;
      out = ['resume'].concat(safeSemantic, [
        '--remote', remoteUrl,
        '--remote-auth-token-env', envName,
        prepared.threadId
      ]);
    } else {
      if (prepared.threadId != null || !isCodexClaimId(prepared.claimId)) return null;
      var freshCwd = safeCodexWorkingDirectory(prepared.cwd);
      if (!freshCwd) return null;
      out = safeSemantic.concat([
        '-C', freshCwd,
        '--remote', remoteUrl,
        '--remote-auth-token-env', envName
      ]);
    }
    if (typeof prompt === 'string' && prompt.trim()) {
      var safePrompt = safeCodexPrompt(prompt, prepared.mode === 'fresh');
      if (!safePrompt) return null;
      out.push(safePrompt);
    }
    return out;
  }

  // Compatibility wrapper for callers that still name the resume-only helper.
  function buildCodexRemoteResume(semanticArgs, prepared, prompt) {
    if (!prepared) return null;
    return buildCodexRemoteAttach(semanticArgs, {
      mode: 'resume',
      threadId: prepared.threadId,
      remoteUrl: prepared.remoteUrl,
      remoteTokenEnvName: prepared.remoteTokenEnvName
    }, prompt);
  }

  function compactTokenCount(value) {
    if (value >= 1000000 && value % 1000000 === 0) return (value / 1000000) + 'M';
    if (value >= 1000) return Math.round(value / 1000) + 'k';
    return String(value);
  }

  function codexContextDisplay(state) {
    var context = state && state.context;
    var used = context && typeof context.usedTokens === 'number' ? context.usedTokens : NaN;
    var limit = context && typeof context.modelContextWindow === 'number' ? context.modelContextWindow : NaN;
    if (!isFinite(used) || used < 0 || !isFinite(limit) || limit <= 0) return null;
    var rawPercent = Number(context.percent);
    var percent = isFinite(rawPercent) ? rawPercent : (used / limit) * 100;
    percent = Math.max(0, Math.min(100, percent));

    var settings = state.settings || {};
    var labels = [];
    var modelLabels = {
      'gpt-5.6-sol': 'Sol 5.6',
      'gpt-5.6-terra': 'Terra 5.6',
      'gpt-5.3-codex-spark': 'Spark 5.3'
    };
    if (settings.model) labels.push(modelLabels[settings.model] || String(settings.model));
    if (settings.reasoningEffort) {
      labels.push(settings.reasoningEffort === 'xhigh' ? 'XHigh'
        : String(settings.reasoningEffort).charAt(0).toUpperCase() + String(settings.reasoningEffort).slice(1));
    }
    if (settings.serviceTier) {
      labels.push(settings.serviceTier === 'priority' ? 'Priority (faster)'
        : String(settings.serviceTier).charAt(0).toUpperCase() + String(settings.serviceTier).slice(1));
    }
    if (state.status) labels.push(String(state.status));
    return {
      usedTokens: used,
      limit: limit,
      percent: percent,
      text: compactTokenCount(used) + '/' + compactTokenCount(limit),
      title: 'Codex context: ' + used.toLocaleString('en-US') + ' / ' + limit.toLocaleString('en-US') +
        ' tokens (' + Math.round(percent) + '%)' + (labels.length ? '\n' + labels.join(' · ') : '')
    };
  }

  // A column uses Claude-specific header chrome (compact/teleport/effort, the
  // starburst icon) only when it has no custom command. cmd columns (Codex,
  // launch configs) do not.
  function columnUsesClaudeChrome(col) {
    return !col || !col.cmd;
  }

  var api = {
    codexLookupCommand: codexLookupCommand,
    parseWhichOutput: parseWhichOutput,
    buildCodexSpawn: buildCodexSpawn,
    columnUsesClaudeChrome: columnUsesClaudeChrome,
    CODEX_APPROVAL_PRESETS: CODEX_APPROVAL_PRESETS,
    DEFAULT_CODEX_APPROVAL: DEFAULT_CODEX_APPROVAL,
    codexApprovalArgs: codexApprovalArgs,
    codexApprovalLabelFromArgs: codexApprovalLabelFromArgs,
    codexTuningArgs: codexTuningArgs,
    codexTuningFromArgs: codexTuningFromArgs,
    codexPresetKeyFromArgs: codexPresetKeyFromArgs,
    buildCodexRestore: buildCodexRestore,
    codexPersistShape: codexPersistShape,
    isCodexThreadId: isCodexThreadId,
    isCodexClaimId: isCodexClaimId,
    buildCodexRemoteAttach: buildCodexRemoteAttach,
    buildCodexRemoteResume: buildCodexRemoteResume,
    codexContextDisplay: codexContextDisplay
  };

  // CommonJS export for main.js + tests; harmless in the browser (no module global).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  // Browser: namespace on window so renderer.js can call it, matching the
  // sibling libs (window.PermissionMode, window.MaximizeLayout, window.RowLayout).
  if (typeof window !== 'undefined') {
    window.CodexSpawn = api;
  }
})();
