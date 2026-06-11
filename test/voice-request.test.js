const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTtsRequest, buildVoicesRequest } = require('../lib/voice-request');

test('buildTtsRequest builds a POST descriptor with headers and JSON body', () => {
  const req = buildTtsRequest({ apiKey: 'sk-1', voiceId: 'voiceX', modelId: 'eleven_turbo', text: 'hello' });
  assert.equal(req.url, 'https://api.elevenlabs.io/v1/text-to-speech/voiceX');
  assert.equal(req.method, 'POST');
  assert.deepEqual(req.headers, {
    'xi-api-key': 'sk-1',
    'Content-Type': 'application/json',
    'Accept': 'audio/mpeg'
  });
  assert.deepEqual(JSON.parse(req.body), { text: 'hello', model_id: 'eleven_turbo' });
});

test('buildTtsRequest defaults modelId to eleven_flash_v2_5 when falsy', () => {
  const req = buildTtsRequest({ apiKey: 'sk-1', voiceId: 'voiceX', text: 'hi' });
  assert.equal(JSON.parse(req.body).model_id, 'eleven_flash_v2_5');
});

test('buildTtsRequest maps a full voiceSettings into body.voice_settings', () => {
  const req = buildTtsRequest({
    apiKey: 'sk-1', voiceId: 'voiceX', text: 'hi',
    voiceSettings: { stability: 0.3, style: 0.8, speed: 1.1, similarityBoost: 0.4, speakerBoost: false }
  });
  const body = JSON.parse(req.body);
  assert.deepEqual(body.voice_settings, {
    stability: 0.3,
    similarity_boost: 0.4,
    style: 0.8,
    use_speaker_boost: false,
    speed: 1.1
  });
});

test('buildTtsRequest includes only mapped keys present in voiceSettings', () => {
  const req = buildTtsRequest({ apiKey: 'sk-1', voiceId: 'voiceX', text: 'hi', voiceSettings: { stability: 0.3 } });
  const body = JSON.parse(req.body);
  assert.deepEqual(body.voice_settings, { stability: 0.3 });
});

test('buildTtsRequest skips non-number/non-boolean voiceSettings values', () => {
  const req = buildTtsRequest({
    apiKey: 'sk-1', voiceId: 'voiceX', text: 'hi',
    voiceSettings: { stability: 'x', style: null, speed: undefined, similarityBoost: 0.6, speakerBoost: 'no' }
  });
  const body = JSON.parse(req.body);
  assert.deepEqual(body.voice_settings, { similarity_boost: 0.6 });
});

test('buildTtsRequest omits voice_settings when voiceSettings is absent or empty', () => {
  const noField = JSON.parse(buildTtsRequest({ apiKey: 'sk-1', voiceId: 'voiceX', text: 'hi' }).body);
  assert.equal('voice_settings' in noField, false);
  const emptyObj = JSON.parse(buildTtsRequest({ apiKey: 'sk-1', voiceId: 'voiceX', text: 'hi', voiceSettings: {} }).body);
  assert.equal('voice_settings' in emptyObj, false);
});

test('buildTtsRequest adds previous_text/next_text as top-level fields when non-empty', () => {
  const req = buildTtsRequest({
    apiKey: 'sk-1', voiceId: 'voiceX', text: 'middle',
    previousText: 'before.', nextText: 'after.'
  });
  const body = JSON.parse(req.body);
  assert.equal(body.previous_text, 'before.');
  assert.equal(body.next_text, 'after.');
  // They are top-level, not nested under voice_settings.
  assert.equal('voice_settings' in body, false);
});

test('buildTtsRequest omits previous_text/next_text when absent or empty', () => {
  const noField = JSON.parse(buildTtsRequest({ apiKey: 'sk-1', voiceId: 'voiceX', text: 'hi' }).body);
  assert.equal('previous_text' in noField, false);
  assert.equal('next_text' in noField, false);
  const empty = JSON.parse(buildTtsRequest({ apiKey: 'sk-1', voiceId: 'voiceX', text: 'hi', previousText: '', nextText: '' }).body);
  assert.equal('previous_text' in empty, false);
  assert.equal('next_text' in empty, false);
});

test('buildTtsRequest throws on missing apiKey, voiceId, or text', () => {
  assert.throws(() => buildTtsRequest({ voiceId: 'v', text: 't' }), /apiKey/);
  assert.throws(() => buildTtsRequest({ apiKey: 'k', text: 't' }), /voiceId/);
  assert.throws(() => buildTtsRequest({ apiKey: 'k', voiceId: 'v', text: '' }), /text/);
});

test('buildTtsRequest rejects a voiceId with non-alphanumeric characters (URL injection guard)', () => {
  // voiceId is concatenated into the URL path; only [A-Za-z0-9] are legitimate.
  assert.throws(() => buildTtsRequest({ apiKey: 'k', voiceId: '../../voices/evil', text: 't' }), /voiceId/);
  assert.throws(() => buildTtsRequest({ apiKey: 'k', voiceId: 'voice/with/slash', text: 't' }), /voiceId/);
  assert.throws(() => buildTtsRequest({ apiKey: 'k', voiceId: 'voice?x=1', text: 't' }), /voiceId/);
  // A normal alphanumeric voiceId is still accepted and lands in the URL verbatim.
  const ok = buildTtsRequest({ apiKey: 'k', voiceId: 'Abc123', text: 't' });
  assert.equal(ok.url, 'https://api.elevenlabs.io/v1/text-to-speech/Abc123');
});

test('buildVoicesRequest builds a GET descriptor with headers', () => {
  const req = buildVoicesRequest({ apiKey: 'sk-2' });
  assert.deepEqual(req, {
    url: 'https://api.elevenlabs.io/v1/voices',
    method: 'GET',
    headers: { 'xi-api-key': 'sk-2', 'Accept': 'application/json' }
  });
});

test('buildVoicesRequest throws on missing apiKey', () => {
  assert.throws(() => buildVoicesRequest({}), /apiKey/);
});
