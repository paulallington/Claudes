// Single source of truth for the Codex CLI's model / reasoning-effort /
// service-tier vocabulary, mirroring lib/claude-models.js for the Claude side.
//
// Loaded two ways (same UMD pattern as the sibling libs):
//   - Node (tests): require('./lib/codex-models')
//   - Renderer: <script src="lib/codex-models.js"> — the renderer runs under
//     contextIsolation:true and cannot require().
//
// EVERYTHING HERE WAS VERIFIED AGAINST THE INSTALLED CLI on 2026-07-25 by
// spawning `codex exec` with each value and checking it ran, not by reading
// docs. Two caveats that matter for the UI:
//
//   1. The CLI ACCEPTS every model x effort combination tried, including
//      gpt-5.3-codex-spark at `ultra`. Acceptance is NOT proof the setting is
//      honoured — unsupported combinations appear to be silently normalised
//      rather than rejected, and the session rollout JSONL does not record the
//      effective model/effort/tier, so there is no way to observe what actually
//      applied. We therefore offer the full ladder for every model rather than
//      encoding per-model gates we cannot verify.
//   2. `flex` and `auto` service tiers are deliberately NOT offered. `flex` is a
//      metered-API billing concept; it is accepted on a ChatGPT subscription but
//      cannot be shown to do anything. Offering a control that may silently
//      no-op is worse than not offering it.

'use strict';

(function () {
  /**
   * Selectable models. `id` is passed to `codex --model <id>`.
   * All three verified to run on a ChatGPT subscription.
   */
  var CODEX_MODELS = [
    { id: 'gpt-5.6-sol', label: 'Sol 5.6', hint: 'Deep reasoning and review' },
    { id: 'gpt-5.6-terra', label: 'Terra 5.6', hint: 'General purpose' },
    { id: 'gpt-5.3-codex-spark', label: 'Spark 5.3', hint: 'Faster, lighter — quick low-stakes work' }
  ];

  /**
   * Reasoning-effort ladder, cheapest first. Emitted as
   * `-c model_reasoning_effort=<id>`.
   *
   * NOTE the local ~/.codex/config.toml comment documents only
   * low|medium|high|max|ultra — it omits `xhigh`, which does exist and runs.
   * That omission is why this list is derived from probing, not from the config.
   */
  var CODEX_EFFORTS = [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'XHigh' },
    { id: 'max', label: 'Max' },
    { id: 'ultra', label: 'Ultra' }
  ];

  /**
   * Service tiers. Emitted as `-c service_tier=<id>`.
   * `priority` is the faster/priority-processing tier (the "~1.5x" one); it may
   * consume subscription allowance faster than `default`.
   */
  var CODEX_TIERS = [
    { id: 'default', label: 'Default' },
    { id: 'priority', label: 'Priority (faster)' }
  ];

  // Empty string = "don't override" — the CLI falls back to ~/.codex/config.toml.
  // This is the default for all three axes so that spawning with no explicit
  // choice behaves exactly as it did before this feature existed.
  var CODEX_INHERIT = '';

  function has(list, id) {
    if (!id) return false;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return true;
    return false;
  }

  /** @returns {boolean} whether `id` is a model we offer. */
  function isKnownModel(id) { return has(CODEX_MODELS, id); }
  /** @returns {boolean} whether `id` is an effort rung we offer. */
  function isKnownEffort(id) { return has(CODEX_EFFORTS, id); }
  /** @returns {boolean} whether `id` is a service tier we offer. */
  function isKnownTier(id) { return has(CODEX_TIERS, id); }

  /**
   * Human label for a stored id, for the column badge / tooltip. Falls back to
   * the raw id so a hand-edited config value still renders as itself rather
   * than vanishing.
   * @param {Array} list
   * @param {string} id
   * @returns {string|null}
   */
  function labelFor(list, id) {
    if (!id) return null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].label;
    return String(id);
  }

  var api = {
    CODEX_MODELS: CODEX_MODELS,
    CODEX_EFFORTS: CODEX_EFFORTS,
    CODEX_TIERS: CODEX_TIERS,
    CODEX_INHERIT: CODEX_INHERIT,
    isKnownModel: isKnownModel,
    isKnownEffort: isKnownEffort,
    isKnownTier: isKnownTier,
    labelFor: labelFor
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.CodexModels = api;
  }
})();
