const PERSONALITY_PRESETS = [
  { key: 'warm', label: 'Warm & enthusiastic', persona: 'warm, upbeat and encouraging' },
  { key: 'dry', label: 'Dry & witty', persona: 'dry, witty and a little sardonic' },
  { key: 'concise', label: 'Concise & professional', persona: 'concise, professional and matter-of-fact' },
  { key: 'calm', label: 'Calm & measured', persona: 'calm, measured and reassuring' },
  { key: 'playful', label: 'Playful', persona: 'playful and lighthearted' }
];

const START_MARKER = '<!-- VOICE-PERSONALITY:START -->';
const END_MARKER = '<!-- VOICE-PERSONALITY:END -->';

/**
 * Insert, replace, or remove the managed personality block in a CLAUDE.md text.
 * A non-empty persona upserts the block; an empty/whitespace persona removes it.
 * @param {string} text
 * @param {string} persona
 * @returns {string}
 */
const BLOCK_RE = /\n*<!-- VOICE-PERSONALITY:START -->[\s\S]*?<!-- VOICE-PERSONALITY:END -->/;

function upsertPersonalityBlock(text, persona) {
  const base = typeof text === 'string' ? text : '';
  const clean = String(persona == null ? '' : persona)
    .replace(/<!--\s*VOICE-PERSONALITY:(START|END)\s*-->/g, '')
    .trim();
  if (!clean) {
    return base.replace(BLOCK_RE, '');
  }
  const block = `${START_MARKER}\nWhen writing the \u{1F50A} summary line, speak with this persona: ${clean}.\n${END_MARKER}`;
  if (BLOCK_RE.test(base)) {
    return base.replace(BLOCK_RE, '\n\n' + block).replace(/^\n\n/, '');
  }
  const trimmed = base.replace(/\s*$/, '');
  return (trimmed ? trimmed + '\n\n' : '') + block;
}

const EXTRACT_RE = /speak with this persona:\s*([\s\S]*?)\.\s*<!-- VOICE-PERSONALITY:END -->/;

/**
 * Return the persona string from the managed block, or '' when no block exists.
 * Anchored on the ASCII text `speak with this persona:` for robustness.
 * @param {string} text
 * @returns {string}
 */
function extractPersonalityBlock(text) {
  if (!text || typeof text !== 'string') return '';
  const m = text.match(EXTRACT_RE);
  return m ? m[1].trim() : '';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PERSONALITY_PRESETS, upsertPersonalityBlock, extractPersonalityBlock };
}
if (typeof window !== 'undefined') {
  window.VoicePersonality = { PERSONALITY_PRESETS, upsertPersonalityBlock, extractPersonalityBlock };
}
