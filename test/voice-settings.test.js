const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeVoiceSettings, redactVoiceSettings } = require('../lib/voice-settings');

test('normalizeVoiceSettings applies defaults for empty input', () => {
  const s = normalizeVoiceSettings();
  assert.deepEqual(s, {
    enabled: false,
    mode: 'active',
    readingMode: 'auto',
    voiceId: '',
    voiceName: '',
    modelId: 'eleven_flash_v2_5',
    maxChars: 600,
    focusCatchUp: true,
    debugLog: false,
    personality: '',
    personalityPreset: '',
    stability: 0.5,
    style: 0,
    speed: 1.0,
    similarityBoost: 0.75,
    speakerBoost: true
  });
});

test('normalizeVoiceSettings applies tuning defaults on empty input', () => {
  const s = normalizeVoiceSettings();
  assert.equal(s.stability, 0.5);
  assert.equal(s.style, 0);
  assert.equal(s.speed, 1.0);
  assert.equal(s.similarityBoost, 0.75);
  assert.equal(s.speakerBoost, true);
});

test('normalizeVoiceSettings passes valid tuning values through unchanged', () => {
  const s = normalizeVoiceSettings({ stability: 0.3, style: 0.8, speed: 1.1, similarityBoost: 0.4, speakerBoost: false });
  assert.equal(s.stability, 0.3);
  assert.equal(s.style, 0.8);
  assert.equal(s.speed, 1.1);
  assert.equal(s.similarityBoost, 0.4);
  assert.equal(s.speakerBoost, false);
});

test('normalizeVoiceSettings clamps out-of-range tuning values', () => {
  assert.equal(normalizeVoiceSettings({ stability: 5 }).stability, 1);
  assert.equal(normalizeVoiceSettings({ stability: -1 }).stability, 0);
  assert.equal(normalizeVoiceSettings({ style: 5 }).style, 1);
  assert.equal(normalizeVoiceSettings({ style: -1 }).style, 0);
  assert.equal(normalizeVoiceSettings({ similarityBoost: 5 }).similarityBoost, 1);
  assert.equal(normalizeVoiceSettings({ similarityBoost: -1 }).similarityBoost, 0);
  assert.equal(normalizeVoiceSettings({ speed: 2 }).speed, 1.2);
  assert.equal(normalizeVoiceSettings({ speed: 0.1 }).speed, 0.7);
});

test('normalizeVoiceSettings falls back to default for non-number tuning values', () => {
  assert.equal(normalizeVoiceSettings({ stability: 'abc' }).stability, 0.5);
  assert.equal(normalizeVoiceSettings({ style: 'x' }).style, 0);
  assert.equal(normalizeVoiceSettings({ speed: null }).speed, 1.0);
  assert.equal(normalizeVoiceSettings({ similarityBoost: undefined }).similarityBoost, 0.75);
  assert.equal(normalizeVoiceSettings({ stability: NaN }).stability, 0.5);
});

test('normalizeVoiceSettings defaults speakerBoost true and respects explicit false', () => {
  assert.equal(normalizeVoiceSettings().speakerBoost, true);
  assert.equal(normalizeVoiceSettings({ speakerBoost: 'yes' }).speakerBoost, true);
  assert.equal(normalizeVoiceSettings({ speakerBoost: 1 }).speakerBoost, true);
  assert.equal(normalizeVoiceSettings({ speakerBoost: false }).speakerBoost, false);
  assert.equal(normalizeVoiceSettings({ speakerBoost: true }).speakerBoost, true);
});

test('redactVoiceSettings inherits the five tuning fields from normalize', () => {
  const out = redactVoiceSettings({ stability: 0.2, style: 0.9, speed: 0.8, similarityBoost: 0.6, speakerBoost: false });
  assert.equal(out.stability, 0.2);
  assert.equal(out.style, 0.9);
  assert.equal(out.speed, 0.8);
  assert.equal(out.similarityBoost, 0.6);
  assert.equal(out.speakerBoost, false);
});

test('normalizeVoiceSettings defaults focusCatchUp true and respects explicit false', () => {
  assert.equal(normalizeVoiceSettings().focusCatchUp, true);
  assert.equal(normalizeVoiceSettings({ focusCatchUp: 'yes' }).focusCatchUp, true);
  assert.equal(normalizeVoiceSettings({ focusCatchUp: false }).focusCatchUp, false);
  assert.equal(normalizeVoiceSettings({ focusCatchUp: true }).focusCatchUp, true);
});

test('normalizeVoiceSettings defaults debugLog false and respects explicit true', () => {
  assert.equal(normalizeVoiceSettings().debugLog, false);
  assert.equal(normalizeVoiceSettings({ debugLog: 'yes' }).debugLog, false);
  assert.equal(normalizeVoiceSettings({ debugLog: 1 }).debugLog, false);
  assert.equal(normalizeVoiceSettings({ debugLog: true }).debugLog, true);
  assert.equal(normalizeVoiceSettings({ debugLog: false }).debugLog, false);
  assert.equal(redactVoiceSettings({ debugLog: true }).debugLog, true);
});

test('normalizeVoiceSettings defaults personality fields to empty strings', () => {
  assert.equal(normalizeVoiceSettings().personality, '');
  assert.equal(normalizeVoiceSettings().personalityPreset, '');
  assert.equal(normalizeVoiceSettings({ personality: 'warm', personalityPreset: 'warm' }).personality, 'warm');
  assert.equal(normalizeVoiceSettings({ personality: 'warm', personalityPreset: 'warm' }).personalityPreset, 'warm');
  assert.equal(normalizeVoiceSettings({ personality: 5 }).personality, '');
});

test('redactVoiceSettings inherits focusCatchUp and personality fields', () => {
  const out = redactVoiceSettings({ focusCatchUp: false, personality: 'dry', personalityPreset: 'dry' });
  assert.equal(out.focusCatchUp, false);
  assert.equal(out.personality, 'dry');
  assert.equal(out.personalityPreset, 'dry');
});

test('normalizeVoiceSettings merges partial input', () => {
  const s = normalizeVoiceSettings({ enabled: true, mode: 'all', voiceId: 'v1', voiceName: 'Rachel', modelId: 'eleven_turbo' });
  assert.equal(s.enabled, true);
  assert.equal(s.mode, 'all');
  assert.equal(s.voiceId, 'v1');
  assert.equal(s.voiceName, 'Rachel');
  assert.equal(s.modelId, 'eleven_turbo');
});

test('normalizeVoiceSettings falls back to active for unknown mode', () => {
  assert.equal(normalizeVoiceSettings({ mode: 'bogus' }).mode, 'active');
  assert.equal(normalizeVoiceSettings({ mode: 'notify' }).mode, 'notify');
  assert.equal(normalizeVoiceSettings({ mode: 'active+notify' }).mode, 'active+notify');
});

test('normalizeVoiceSettings coerces and clamps maxChars', () => {
  assert.equal(normalizeVoiceSettings({ maxChars: '9999' }).maxChars, 5000);
  assert.equal(normalizeVoiceSettings({ maxChars: 10 }).maxChars, 50);
  assert.equal(normalizeVoiceSettings({ maxChars: 250.7 }).maxChars, 250);
  assert.equal(normalizeVoiceSettings({ maxChars: 'abc' }).maxChars, 600);
});

test('normalizeVoiceSettings defaults readingMode to auto and validates it', () => {
  assert.equal(normalizeVoiceSettings().readingMode, 'auto');
  assert.equal(normalizeVoiceSettings({ readingMode: 'auto' }).readingMode, 'auto');
  assert.equal(normalizeVoiceSettings({ readingMode: 'full' }).readingMode, 'full');
  assert.equal(normalizeVoiceSettings({ readingMode: 'summary' }).readingMode, 'summary');
  assert.equal(normalizeVoiceSettings({ readingMode: 'bogus' }).readingMode, 'auto');
  assert.equal(normalizeVoiceSettings({ readingMode: 42 }).readingMode, 'auto');
  // readingMode does not disturb other fields
  const s = normalizeVoiceSettings({ readingMode: 'full', mode: 'all', enabled: true });
  assert.equal(s.mode, 'all');
  assert.equal(s.enabled, true);
  // redact inherits readingMode from normalize
  assert.equal(redactVoiceSettings({ readingMode: 'summary' }).readingMode, 'summary');
});

test('normalizeVoiceSettings never leaks apiKey', () => {
  const s = normalizeVoiceSettings({ apiKey: 'secret', enabled: true });
  assert.equal('apiKey' in s, false);
});

test('redactVoiceSettings reports hasApiKey true for an encrypted key without leaking it', () => {
  const out = redactVoiceSettings({ enabled: true, voiceId: 'v1', apiKey: { encrypted: 'abc' } });
  assert.equal(out.hasApiKey, true);
  assert.equal('apiKey' in out, false);
  assert.equal('encrypted' in out, false);
  // public fields are present and normalized
  assert.equal(out.enabled, true);
  assert.equal(out.voiceId, 'v1');
  assert.equal(out.mode, 'active');
  assert.equal(JSON.stringify(out).includes('abc'), false);
});

test('redactVoiceSettings reports hasApiKey true for a plain key and false when absent', () => {
  assert.equal(redactVoiceSettings({ apiKey: { plain: 'xyz' } }).hasApiKey, true);
  assert.equal(redactVoiceSettings({ apiKey: { encrypted: '' } }).hasApiKey, false);
  assert.equal(redactVoiceSettings({}).hasApiKey, false);
  assert.equal(redactVoiceSettings().hasApiKey, false);
});
