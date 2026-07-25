'use strict';

(function () {
  /**
   * Single source of truth for Claude model facts — id, label, family,
   * context window, and per-Mtok prices — plus lookup helpers keyed by
   * model id or CLI alias (`opus`/`sonnet`/`haiku`).
   *
   * Cache prices are derived, not hand-typed:
   *   cacheRead     = input * 0.1
   *   cacheCreation = input * 1.25
   */

  /**
   * Build a pinned model entry with derived cache prices.
   * @param {string} id
   * @param {string} label
   * @param {string} family
   * @param {number} contextWindow
   * @param {number} input
   * @param {number} output
   * @returns {object}
   */
  function pinned(id, label, family, contextWindow, input, output) {
    return {
      id: id,
      label: label,
      family: family,
      contextWindow: contextWindow,
      input: input,
      output: output,
      cacheRead: input * 0.1,
      cacheCreation: input * 1.25,
      isAlias: false,
    };
  }

  /** Ordered array of the pinned model entries (exact ids Anthropic ships today). */
  var MODELS = [
    pinned('claude-fable-5', 'Fable 5', 'fable', 1000000, 10.0, 50.0),
    pinned('claude-opus-5', 'Opus 5', 'opus', 1000000, 5.0, 25.0),
    pinned('claude-opus-4-8', 'Opus 4.8', 'opus', 1000000, 5.0, 25.0),
    pinned('claude-opus-4-7', 'Opus 4.7', 'opus', 1000000, 5.0, 25.0),
    pinned('claude-opus-4-6', 'Opus 4.6', 'opus', 1000000, 5.0, 25.0),
    pinned('claude-sonnet-5', 'Sonnet 5', 'sonnet', 1000000, 3.0, 15.0),
    pinned('claude-sonnet-4-6', 'Sonnet 4.6', 'sonnet', 1000000, 3.0, 15.0),
    pinned('claude-haiku-4-5', 'Haiku 4.5', 'haiku', 200000, 1.0, 5.0),
  ];

  /**
   * Ordered array of the CLI's "latest" aliases — what `claude --model`
   * accepts as shorthand, resolved to whatever build is current at spawn
   * time rather than a pinned version.
   */
  var ALIASES = [
    { id: 'opus', label: 'Opus (latest)', family: 'opus', isAlias: true },
    { id: 'sonnet', label: 'Sonnet (latest)', family: 'sonnet', isAlias: true },
    { id: 'haiku', label: 'Haiku (latest)', family: 'haiku', isAlias: true },
  ];

  /** Model used to re-activate the 1M context window via Headroom. */
  var DEFAULT_1M_MODEL = 'claude-opus-5';

  // Conservative fallbacks for an id that names a family but no known pinned
  // version (e.g. an old `claude-opus-4-1`). NOT applied to ids in MODELS.
  var FAMILY_FALLBACK = {
    opus: { input: 15.0, output: 75.0, contextWindow: 200000 },
    sonnet: { input: 3.0, output: 15.0, contextWindow: 200000 },
    haiku: { input: 1.0, output: 5.0, contextWindow: 200000 },
    fable: { input: 10.0, output: 50.0, contextWindow: 1000000 },
  };

  // Checked most-specific-first so e.g. 'claude-fable-5' never falls through
  // to a less specific family match.
  var FAMILY_ORDER = ['fable', 'opus', 'sonnet', 'haiku'];

  /**
   * Look up a catalogue entry (pinned model or alias) by exact id.
   * @param {string} modelId
   * @returns {object|null}
   */
  function lookup(modelId) {
    if (!modelId) return null;
    for (var i = 0; i < MODELS.length; i++) {
      if (MODELS[i].id === modelId) return MODELS[i];
    }
    for (var j = 0; j < ALIASES.length; j++) {
      if (ALIASES[j].id === modelId) return ALIASES[j];
    }
    return null;
  }

  /**
   * Case-insensitive substring match of a model id against known families,
   * checked most-specific-first so e.g. `claude-fable-5` never classifies
   * as `opus`/`sonnet`/`haiku`.
   * @param {string} modelId
   * @returns {'fable'|'opus'|'sonnet'|'haiku'|null}
   */
  function familyOf(modelId) {
    if (!modelId) return null;
    var lower = String(modelId).toLowerCase();
    for (var i = 0; i < FAMILY_ORDER.length; i++) {
      var family = FAMILY_ORDER[i];
      if (lower.indexOf(family) !== -1) return family;
    }
    return null;
  }

  /**
   * Context window for a model id — exact-id lookup first, then family
   * fallback, then the safe default (200000) for null/unknown.
   * @param {string} modelId
   * @returns {number}
   */
  function contextWindowFor(modelId) {
    var entry = lookup(modelId);
    if (entry && typeof entry.contextWindow === 'number') return entry.contextWindow;
    var family = familyOf(modelId);
    if (family && FAMILY_FALLBACK[family]) return FAMILY_FALLBACK[family].contextWindow;
    return 200000;
  }

  /**
   * Per-Mtok prices for a model id — exact-id lookup first, then family
   * fallback, then null for null/unknown.
   * @param {string} modelId
   * @returns {{input: number, output: number, cacheRead: number, cacheCreation: number}|null}
   */
  function pricesFor(modelId) {
    var entry = lookup(modelId);
    if (entry && typeof entry.input === 'number') {
      return {
        input: entry.input,
        output: entry.output,
        cacheRead: entry.cacheRead,
        cacheCreation: entry.cacheCreation,
      };
    }
    var family = familyOf(modelId);
    if (family && FAMILY_FALLBACK[family]) {
      var fb = FAMILY_FALLBACK[family];
      return {
        input: fb.input,
        output: fb.output,
        cacheRead: fb.input * 0.1,
        cacheCreation: fb.input * 1.25,
      };
    }
    return null;
  }

  /**
   * Whether a model id supports the 1M context window.
   * @param {string} modelId
   * @returns {boolean}
   */
  function supportsOneM(modelId) {
    return contextWindowFor(modelId) >= 1000000;
  }

  var api = {
    MODELS: MODELS,
    ALIASES: ALIASES,
    DEFAULT_1M_MODEL: DEFAULT_1M_MODEL,
    lookup: lookup,
    familyOf: familyOf,
    contextWindowFor: contextWindowFor,
    pricesFor: pricesFor,
    supportsOneM: supportsOneM,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.ClaudeModels = api;
  }
})();
