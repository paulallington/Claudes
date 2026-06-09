const VALID_MODES = ['active', 'all', 'notify', 'active+notify'];
const DEFAULT_MODE = 'active';
const VALID_READING_MODES = ['auto', 'full', 'summary'];
const DEFAULT_READING_MODE = 'auto';
const DEFAULT_MODEL_ID = 'eleven_flash_v2_5';
const DEFAULT_MAX_CHARS = 600;
const MIN_MAX_CHARS = 50;
const MAX_MAX_CHARS = 5000;

function clampMaxChars(raw) {
  const n = typeof raw === 'number' ? raw : parseInt(raw, 10);
  if (!isFinite(n)) return DEFAULT_MAX_CHARS;
  const i = Math.trunc(n);
  if (i < MIN_MAX_CHARS) return MIN_MAX_CHARS;
  if (i > MAX_MAX_CHARS) return MAX_MAX_CHARS;
  return i;
}

function clampTuning(raw, def, min, max) {
  if (typeof raw !== 'number' || !isFinite(raw)) return def;
  if (raw < min) return min;
  if (raw > max) return max;
  return raw;
}

/**
 * Normalize a raw voice config into the public settings shape, applying
 * defaults and clamping. The returned object NEVER contains an apiKey.
 * @param {object} [raw]
 * @returns {{ enabled: boolean, mode: string, readingMode: string, voiceId: string, voiceName: string, modelId: string, maxChars: number, focusCatchUp: boolean, personality: string, personalityPreset: string, stability: number, style: number, speed: number, similarityBoost: number, speakerBoost: boolean }}
 */
function normalizeVoiceSettings(raw) {
  const r = raw || {};
  const mode = VALID_MODES.indexOf(r.mode) !== -1 ? r.mode : DEFAULT_MODE;
  const readingMode = VALID_READING_MODES.indexOf(r.readingMode) !== -1 ? r.readingMode : DEFAULT_READING_MODE;
  return {
    enabled: r.enabled === true,
    mode,
    readingMode,
    voiceId: typeof r.voiceId === 'string' ? r.voiceId : '',
    voiceName: typeof r.voiceName === 'string' ? r.voiceName : '',
    modelId: r.modelId ? String(r.modelId) : DEFAULT_MODEL_ID,
    maxChars: clampMaxChars(r.maxChars),
    focusCatchUp: typeof r.focusCatchUp === 'boolean' ? r.focusCatchUp : true,
    personality: typeof r.personality === 'string' ? r.personality : '',
    personalityPreset: typeof r.personalityPreset === 'string' ? r.personalityPreset : '',
    stability: clampTuning(r.stability, 0.5, 0, 1),
    style: clampTuning(r.style, 0, 0, 1),
    speed: clampTuning(r.speed, 1.0, 0.7, 1.2),
    similarityBoost: clampTuning(r.similarityBoost, 0.75, 0, 1),
    speakerBoost: typeof r.speakerBoost === 'boolean' ? r.speakerBoost : true
  };
}

/**
 * Produce a renderer-safe view of a stored voice config: normalized public
 * fields plus a boolean `hasApiKey`. The key material itself is NEVER returned.
 * A key is considered present when the stored config carries a non-empty
 * `apiKey.encrypted` or `apiKey.plain` value.
 * @param {object} [stored]
 * @returns {{ enabled: boolean, mode: string, readingMode: string, voiceId: string, voiceName: string, modelId: string, maxChars: number, hasApiKey: boolean }}
 */
function redactVoiceSettings(stored) {
  const s = stored || {};
  const key = s.apiKey || {};
  const hasApiKey = !!((key.encrypted && String(key.encrypted).length > 0) ||
                       (key.plain && String(key.plain).length > 0));
  const publicFields = normalizeVoiceSettings(s);
  return Object.assign({}, publicFields, { hasApiKey });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeVoiceSettings, redactVoiceSettings };
}
if (typeof window !== 'undefined') {
  window.VoiceSettings = { normalizeVoiceSettings, redactVoiceSettings };
}
