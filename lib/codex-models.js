// Single source of truth for the Codex CLI's model / reasoning-effort /
// service-tier vocabulary, mirroring lib/claude-models.js for the Claude side.
//
// Loaded two ways (same UMD pattern as the sibling libs):
//   - Node (tests): require('./lib/codex-models')
//   - Renderer: <script src="lib/codex-models.js"> — the renderer runs under
//     contextIsolation:true and cannot require().
//
// The app-server's model/list response is authoritative at runtime. The static
// constants below are only an offline/older-CLI fallback; normalizeCatalog
// retains each model's own effort/tier capabilities so the picker never offers
// a setting merely because another model supports it.

'use strict';

(function () {
  /**
   * Offline fallback models. `id` is passed to `codex --model <id>`.
   */
  var CODEX_MODELS = [
    { id: 'gpt-5.6-sol', label: 'Sol 5.6', hint: 'Deep reasoning and review' },
    { id: 'gpt-5.6-terra', label: 'Terra 5.6', hint: 'General purpose' },
    { id: 'gpt-5.3-codex-spark', label: 'Spark 5.3', hint: 'Faster, lighter — quick low-stakes work' }
  ];

  /**
   * Offline fallback reasoning-effort ladder, cheapest first. Emitted as
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

  function safeId(value) {
    if (value == null) return '';
    var id = String(value).trim();
    return /^[A-Za-z0-9._-]+$/.test(id) ? id : '';
  }

  function titleCaseId(id) {
    return String(id || '').split('-').map(function (part) {
      if (!part) return part;
      if (part === 'xhigh') return 'XHigh';
      return part.charAt(0).toUpperCase() + part.slice(1);
    }).join(' ');
  }

  function cloneOptions(list) {
    return list.map(function (item) {
      return { id: item.id, label: item.label, hint: item.hint || '' };
    });
  }

  function fallbackCatalog() {
    return {
      models: CODEX_MODELS.map(function (model) {
        var efforts = cloneOptions(CODEX_EFFORTS);
        var tiers = cloneOptions(CODEX_TIERS);
        // Spark's current catalogue stops at xhigh and exposes no priority
        // tier. Keeping that constraint in the offline fallback prevents the
        // old picker from offering settings Codex will silently normalise.
        if (model.id === 'gpt-5.3-codex-spark') {
          efforts = efforts.filter(function (effort) { return effort.id !== 'max' && effort.id !== 'ultra'; });
          tiers = tiers.filter(function (tier) { return tier.id !== 'priority'; });
        }
        return {
          id: model.id,
          label: model.label,
          hint: model.hint || '',
          efforts: efforts,
          tiers: tiers,
          isDefault: model.id === 'gpt-5.6-sol'
        };
      }),
      defaultModel: 'gpt-5.6-sol'
    };
  }

  /**
   * Convert app-server `model/list` output into the small, renderer-safe
   * catalogue shape used by the pickers. Hidden/malformed entries are dropped
   * and only scalar ids may become CLI arguments later.
   */
  function normalizeCatalog(raw) {
    var source = raw && Array.isArray(raw.data) ? raw.data
      : (raw && Array.isArray(raw.models) ? raw.models : []);
    var models = [];
    var seenModels = Object.create(null);
    for (var i = 0; i < source.length; i++) {
      var item = source[i] || {};
      if (item.hidden) continue;
      var modelId = safeId(item.model || item.id);
      if (!modelId || seenModels[modelId]) continue;
      seenModels[modelId] = true;
      var efforts = [];
      var seenEfforts = Object.create(null);
      var rawEfforts = Array.isArray(item.supportedReasoningEfforts)
        ? item.supportedReasoningEfforts : (Array.isArray(item.efforts) ? item.efforts : []);
      for (var ei = 0; ei < rawEfforts.length; ei++) {
        var effort = rawEfforts[ei] || {};
        var effortId = safeId(effort.reasoningEffort || effort.id || effort);
        if (!effortId || seenEfforts[effortId]) continue;
        seenEfforts[effortId] = true;
        efforts.push({
          id: effortId,
          label: effort.label || titleCaseId(effortId),
          hint: effort.description || effort.hint || ''
        });
      }
      var tiers = [];
      var seenTiers = Object.create(null);
      var rawTiers = Array.isArray(item.serviceTiers)
        ? item.serviceTiers : (Array.isArray(item.tiers) ? item.tiers : []);
      for (var ti = 0; ti < rawTiers.length; ti++) {
        var tier = rawTiers[ti] || {};
        var tierId = safeId(tier.id || tier);
        if (!tierId || seenTiers[tierId]) continue;
        seenTiers[tierId] = true;
        tiers.push({
          id: tierId,
          label: tier.name || tier.label || titleCaseId(tierId),
          hint: tier.description || tier.hint || ''
        });
      }
      models.push({
        id: modelId,
        label: item.displayName || item.label || modelId,
        hint: item.description || item.hint || '',
        efforts: efforts,
        tiers: tiers,
        isDefault: !!item.isDefault
      });
    }
    var defaultModel = '';
    for (var mi = 0; mi < models.length; mi++) {
      if (models[mi].isDefault) { defaultModel = models[mi].id; break; }
    }
    return models.length ? { models: models, defaultModel: defaultModel } : fallbackCatalog();
  }

  function optionsForModel(catalog, modelId) {
    var models = catalog && Array.isArray(catalog.models) ? catalog.models : [];
    for (var i = 0; i < models.length; i++) {
      if (models[i].id === modelId) {
        return {
          efforts: Array.isArray(models[i].efforts) ? models[i].efforts.slice() : [],
          tiers: Array.isArray(models[i].tiers) ? models[i].tiers.slice() : []
        };
      }
    }
    return { efforts: [], tiers: [] };
  }

  function pickerSelection(list, selected, live) {
    var known = !!selected && (list || []).some(function (item) { return item && item.id === selected; });
    return {
      value: known || (!live && selected) ? selected : '',
      includePending: !!selected && !known && !live
    };
  }

  var api = {
    CODEX_MODELS: CODEX_MODELS,
    CODEX_EFFORTS: CODEX_EFFORTS,
    CODEX_TIERS: CODEX_TIERS,
    CODEX_INHERIT: CODEX_INHERIT,
    isKnownModel: isKnownModel,
    isKnownEffort: isKnownEffort,
    isKnownTier: isKnownTier,
    labelFor: labelFor,
    normalizeCatalog: normalizeCatalog,
    optionsForModel: optionsForModel,
    pickerSelection: pickerSelection,
    fallbackCatalog: fallbackCatalog
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.CodexModels = api;
  }
})();
