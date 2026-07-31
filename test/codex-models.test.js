'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const CodexModels = require('../lib/codex-models');

test('normalizeCatalog: maps visible app-server models and their model-specific capabilities', () => {
  const catalog = CodexModels.normalizeCatalog({ data: [
    {
      id: 'sol-id', model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol',
      description: 'Deep reasoning', hidden: false, isDefault: true,
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'Fast' },
        { reasoningEffort: 'ultra', description: 'Deepest' }
      ],
      serviceTiers: [
        { id: 'priority', name: 'Priority', description: 'Faster' }
      ]
    },
    { id: 'hidden', model: 'gpt-hidden', displayName: 'Hidden', hidden: true }
  ] });

  assert.deepStrictEqual(catalog.models.map((m) => m.id), ['gpt-5.6-sol']);
  assert.strictEqual(catalog.defaultModel, 'gpt-5.6-sol');
  assert.deepStrictEqual(CodexModels.optionsForModel(catalog, 'gpt-5.6-sol'), {
    efforts: [
      { id: 'low', label: 'Low', hint: 'Fast' },
      { id: 'ultra', label: 'Ultra', hint: 'Deepest' }
    ],
    tiers: [{ id: 'priority', label: 'Priority', hint: 'Faster' }]
  });
});

test('normalizeCatalog: malformed or empty app-server output uses the static fallback', () => {
  const empty = CodexModels.normalizeCatalog({ data: [{ model: '--bad value' }, { hidden: true, model: 'x' }] });
  assert.deepStrictEqual(empty.models.map((m) => m.id), CodexModels.CODEX_MODELS.map((m) => m.id));
  assert.ok(CodexModels.optionsForModel(empty, 'gpt-5.6-sol').efforts.some((e) => e.id === 'ultra'));
  assert.ok(!CodexModels.optionsForModel(empty, 'gpt-5.3-codex-spark').efforts.some((e) => e.id === 'ultra'));
  assert.ok(!CodexModels.optionsForModel(empty, 'gpt-5.3-codex-spark').tiers.some((t) => t.id === 'priority'));
});

test('normalizeCatalog: de-duplicates ids while preserving server order and first default', () => {
  const catalog = CodexModels.normalizeCatalog({ ok: true, models: [
    {
      model: 'gpt-a', displayName: 'A', isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'high' }],
      serviceTiers: [{ id: 'priority', name: 'Priority' }, { id: 'priority', name: 'Duplicate' }]
    },
    { model: 'gpt-a', displayName: 'Duplicate model', isDefault: false },
    { model: 'gpt-b', displayName: 'B', isDefault: true }
  ] });
  assert.deepStrictEqual(catalog.models.map((m) => m.id), ['gpt-a', 'gpt-b']);
  assert.strictEqual(catalog.defaultModel, 'gpt-a');
  assert.deepStrictEqual(catalog.models[0].efforts.map((e) => e.id), ['high']);
  assert.deepStrictEqual(catalog.models[0].tiers.map((t) => t.id), ['priority']);
});

test('pickerSelection preserves a saved live-only value until the authoritative catalog arrives', () => {
  const fallback = [{ id: 'gpt-fallback' }];
  assert.deepStrictEqual(CodexModels.pickerSelection(fallback, 'gpt-live-only', false), {
    value: 'gpt-live-only', includePending: true
  });
  assert.deepStrictEqual(CodexModels.pickerSelection([{ id: 'gpt-live-only' }], 'gpt-live-only', true), {
    value: 'gpt-live-only', includePending: false
  });
  assert.deepStrictEqual(CodexModels.pickerSelection([{ id: 'gpt-other' }], 'gpt-live-only', true), {
    value: '', includePending: false
  });
});
