const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';
const DEFAULT_MODEL_ID = 'eleven_flash_v2_5';

/**
 * Map a normalized voiceSettings object to the ElevenLabs voice_settings
 * payload, including only keys whose source value is the right type. Numeric
 * keys are included only when finite numbers; speakerBoost only when boolean.
 * Returns undefined when nothing maps (so the caller omits voice_settings).
 * @param {object} [vs]
 * @returns {object|undefined}
 */
function mapVoiceSettings(vs) {
  if (!vs || typeof vs !== 'object') return undefined;
  const out = {};
  const num = (v) => typeof v === 'number' && isFinite(v);
  if (num(vs.stability)) out.stability = vs.stability;
  if (num(vs.similarityBoost)) out.similarity_boost = vs.similarityBoost;
  if (num(vs.style)) out.style = vs.style;
  if (typeof vs.speakerBoost === 'boolean') out.use_speaker_boost = vs.speakerBoost;
  if (num(vs.speed)) out.speed = vs.speed;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Build a pure request descriptor for an ElevenLabs text-to-speech call.
 * Does not perform any network I/O.
 * @param {{ apiKey: string, voiceId: string, modelId?: string, text: string, voiceSettings?: object }} opts
 * @returns {{ url: string, method: string, headers: object, body: string }}
 * @throws {Error} if apiKey, voiceId, or text is missing/empty
 */
function buildTtsRequest(opts) {
  const o = opts || {};
  if (!o.apiKey) throw new Error('buildTtsRequest: apiKey is required');
  if (!o.voiceId) throw new Error('buildTtsRequest: voiceId is required');
  // voiceId is concatenated into the URL path; reject anything that isn't a
  // plain alphanumeric id so it can't inject path segments or query strings.
  if (!/^[A-Za-z0-9]+$/.test(o.voiceId)) throw new Error('buildTtsRequest: voiceId is invalid');
  if (!o.text) throw new Error('buildTtsRequest: text is required');
  const modelId = o.modelId || DEFAULT_MODEL_ID;
  const payload = { text: o.text, model_id: modelId };
  const voiceSettings = mapVoiceSettings(o.voiceSettings);
  if (voiceSettings) payload.voice_settings = voiceSettings;
  return {
    url: ELEVENLABS_BASE + '/text-to-speech/' + o.voiceId,
    method: 'POST',
    headers: {
      'xi-api-key': o.apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg'
    },
    body: JSON.stringify(payload)
  };
}

/**
 * Build a pure request descriptor for listing ElevenLabs voices.
 * Does not perform any network I/O.
 * @param {{ apiKey: string }} opts
 * @returns {{ url: string, method: string, headers: object }}
 * @throws {Error} if apiKey is missing/empty
 */
function buildVoicesRequest(opts) {
  const o = opts || {};
  if (!o.apiKey) throw new Error('buildVoicesRequest: apiKey is required');
  return {
    url: ELEVENLABS_BASE + '/voices',
    method: 'GET',
    headers: {
      'xi-api-key': o.apiKey,
      'Accept': 'application/json'
    }
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildTtsRequest, buildVoicesRequest };
}
if (typeof window !== 'undefined') {
  window.VoiceRequest = { buildTtsRequest, buildVoicesRequest };
}
