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
  function pinned(id, label, family, contextWindow, input, output, pickable) {
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
      // Whether this model is offered in the spawn / agent model pickers.
      // Superseded versions stay in the catalogue so historical sessions still
      // price and size correctly, but there is no reason to start a NEW column
      // on one — keeping them out of the dropdown stops the list growing
      // without bound every time Anthropic ships a model.
      pickable: pickable !== false,
    };
  }

  /** Ordered array of the pinned model entries (exact ids Anthropic ships today). */
  var MODELS = [
    pinned('claude-fable-5', 'Fable 5', 'fable', 1000000, 10.0, 50.0),
    pinned('claude-opus-5', 'Opus 5', 'opus', 1000000, 5.0, 25.0),
    pinned('claude-opus-4-8', 'Opus 4.8', 'opus', 1000000, 5.0, 25.0),
    pinned('claude-opus-4-7', 'Opus 4.7', 'opus', 1000000, 5.0, 25.0, false),
    pinned('claude-opus-4-6', 'Opus 4.6', 'opus', 1000000, 5.0, 25.0, false),
    // Still-active older pins — 200k context, not 1M like the 4.6+ line.
    pinned('claude-opus-4-5', 'Opus 4.5', 'opus', 200000, 5.0, 25.0, false),
    pinned('claude-opus-4-1', 'Opus 4.1', 'opus', 200000, 15.0, 75.0, false),
    pinned('claude-sonnet-5', 'Sonnet 5', 'sonnet', 1000000, 3.0, 15.0),
    pinned('claude-sonnet-4-6', 'Sonnet 4.6', 'sonnet', 1000000, 3.0, 15.0, false),
    pinned('claude-haiku-4-5', 'Haiku 4.5', 'haiku', 200000, 1.0, 5.0),
  ];

  /**
   * Ordered array of the CLI's "latest" aliases — what `claude --model`
   * accepts as shorthand, resolved to whatever build is current at spawn
   * time rather than a pinned version.
   */
  var ALIASES = [
    { id: 'fable', label: 'Fable (latest)', family: 'fable', isAlias: true },
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
   * Strip Headroom's `[1m]` window marker from a model id.
   *
   * The app injects `ANTHROPIC_MODEL=<id>[1m]` to re-activate the 1M window
   * behind the proxy, so that suffixed string is what the CLI is told its
   * model is — and it can come back to us in a session digest or a persisted
   * column. Without this, `claude-opus-5[1m]` misses the exact-id lookup and
   * falls through to the legacy family fallback: 200k instead of 1M, and
   * $15/$75 instead of $5/$25. That is the exact staleness this catalogue
   * exists to kill, so normalise before every lookup rather than asking each
   * caller to remember.
   *
   * @param {string} modelId
   * @returns {string}
   */
  function stripWindowMarker(modelId) {
    return String(modelId).replace(/\[1m\]\s*$/i, '');
  }

  /**
   * Look up a catalogue entry (pinned model or alias) by id, ignoring any
   * trailing `[1m]` window marker.
   * @param {string} modelId
   * @returns {object|null}
   */
  function lookup(modelId) {
    if (!modelId) return null;
    modelId = stripWindowMarker(modelId);
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
   * Resolve a CLI alias (`opus`/`sonnet`/`haiku`) to the newest pinned id in
   * that family; any other id passes through unchanged.
   *
   * Callers that need a CONCRETE id must resolve first. Headroom is the
   * motivating case: it pins the 1M window by appending a `[1m]` suffix to
   * ANTHROPIC_MODEL, and an alias carries no version — so `opus` has no known
   * context window, would be treated as a non-1M model, and would silently
   * lose the 1M window the user was entitled to. MODELS is ordered
   * newest-first per family, so the first match is the latest.
   *
   * Note this pins "latest" to the newest model THIS CATALOGUE knows about,
   * which is the point (deterministic), but means the catalogue must be kept
   * current when Anthropic ships a new model.
   *
   * @param {string} modelId
   * @returns {string} a concrete model id, or the input unchanged
   */
  function resolveModelId(modelId) {
    if (!modelId) return modelId;
    var entry = lookup(modelId);
    if (!entry || !entry.isAlias) return stripWindowMarker(modelId);
    for (var i = 0; i < MODELS.length; i++) {
      if (MODELS[i].family === entry.family) return MODELS[i].id;
    }
    return modelId;
  }

  /**
   * Whether a model id supports the 1M context window. Aliases are resolved
   * to their concrete latest id first.
   * @param {string} modelId
   * @returns {boolean}
   */
  function supportsOneM(modelId) {
    return contextWindowFor(resolveModelId(modelId)) >= 1000000;
  }

  var api = {
    MODELS: MODELS,
    ALIASES: ALIASES,
    DEFAULT_1M_MODEL: DEFAULT_1M_MODEL,
    lookup: lookup,
    familyOf: familyOf,
    resolveModelId: resolveModelId,
    stripWindowMarker: stripWindowMarker,
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
