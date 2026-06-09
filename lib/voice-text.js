/**
 * Newest text-bearing assistant message whose joined text is NOT a non-content
 * turn. Walks newest→oldest, parsing each line individually (malformed lines are
 * skipped; never throws). Skips tool_use/thinking-only entries (no text) AND
 * "No response requested." style turns, falling back to the most recent message
 * that actually has something to say. Routing both lastAssistantText and
 * lastAssistantUuid through this guarantees the chosen message is identical for
 * text and uuid.
 * @param {string} jsonlContent - raw JSONL file content
 * @returns {{ text: string, uuid: string }|null} the chosen message, or null
 */
function lastSpeakableAssistant(jsonlContent) {
  if (!jsonlContent || typeof jsonlContent !== 'string') return null;
  const lines = jsonlContent.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line[0] !== '{') continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'assistant' || !entry.message) continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    const texts = content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
    if (texts.length === 0) continue;
    const joined = texts.join('\n');
    if (isNonContent(joined)) continue;
    return { text: joined, uuid: typeof entry.uuid === 'string' ? entry.uuid : '' };
  }
  return null;
}

/**
 * Extract the raw joined text of the newest speakable assistant message from a
 * Claude Code transcript JSONL string. Tool_use/thinking-only entries (no text)
 * and non-content turns ("No response requested." style) are skipped, falling
 * back to the most recent message that actually has something to say.
 * @param {string} jsonlContent - raw JSONL file content
 * @returns {string} joined text blocks of the newest speakable assistant message, or ''
 */
function lastAssistantText(jsonlContent) {
  return lastSpeakableAssistant(jsonlContent)?.text || '';
}

/**
 * Find the top-level uuid of the newest speakable assistant entry in a Claude
 * Code transcript JSONL string. Tool_use/thinking-only entries (no text) and
 * non-content turns are skipped, so the uuid advances only on a real reply.
 * Used to detect when a *new* assistant reply has been written.
 * @param {string} jsonlContent - raw JSONL file content
 * @returns {string} uuid of the newest speakable assistant entry, or ''
 */
function lastAssistantUuid(jsonlContent) {
  return lastSpeakableAssistant(jsonlContent)?.uuid || '';
}

/**
 * Turn a Claude Code transcript JSONL string into speakable text: find the last
 * text-bearing assistant message, then return its speakable form.
 * @param {string} jsonlContent - raw JSONL file content
 * @param {{ maxChars?: number, readingMode?: 'auto'|'full'|'summary' }} [opts]
 * @returns {string} speakable text, or '' when no assistant text is found
 */
function extractSpeakableText(jsonlContent, opts) {
  const lastText = lastAssistantText(jsonlContent);
  if (!lastText) return '';
  const readingMode = opts && opts.readingMode ? opts.readingMode : 'auto';
  const maxChars = opts && typeof opts.maxChars === 'number' ? opts.maxChars : 600;
  if (readingMode === 'full') {
    return filterNonContent(cleanSpokenText(stripSummaryLines(lastText), maxChars));
  }
  if (readingMode === 'summary') {
    const only = findSummaryLine(lastText);
    if (only !== null) return filterNonContent(only);
    // No 🔊 line: the explicit Summary button should stay concise, so speak just
    // the FIRST sentence of the cleaned body rather than the whole reply.
    return filterNonContent(firstSentence(cleanSpokenText(stripSummaryLines(lastText), maxChars)));
  }
  const summary = findSummaryLine(lastText);
  if (summary !== null) return filterNonContent(summary);
  return filterNonContent(cleanSpokenText(lastText, maxChars));
}

// Non-content turns Claude Code emits for background events that produce no
// reply. These must never be spoken. Exact full-text matches only (after
// normalization) — longer replies that merely contain the phrase are kept.
const NON_CONTENT = new Set(['no response requested', 'no response needed']);

/**
 * Normalize text and test for an exact match against the non-content blocklist.
 * @param {string} t
 * @returns {boolean}
 */
function isNonContent(t) {
  const n = String(t || '').trim().toLowerCase().replace(/^["'\s]+|["'.!…\s]+$/g, '');
  return NON_CONTENT.has(n);
}

/**
 * Return '' when the final speakable text is a non-content turn, else the text.
 * @param {string} t
 * @returns {string}
 */
function filterNonContent(t) {
  return isNonContent(t) ? '' : t;
}

/**
 * Remove every line that begins (after optional leading whitespace) with the
 * speaker emoji, so a 🔊 summary line is never read in 'full' mode.
 * @param {string} text
 * @returns {string}
 */
function stripSummaryLines(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .split('\n')
    .filter((l) => !l.replace(/^\s+/, '').startsWith(SPEAKER_EMOJI))
    .join('\n');
}

/**
 * Return the FIRST sentence of `text`: everything up to and including the first
 * `.`, `!`, or `?` that is followed by whitespace or end-of-string. When no such
 * boundary exists, the whole trimmed text is returned. Mirrors
 * TerminalReply.firstSentence so the transcript and terminal voice paths agree
 * on the concise Summary fallback.
 * @param {string} text
 * @returns {string}
 */
function firstSentence(text) {
  const s = (typeof text === 'string' ? text : '').trim();
  if (!s) return '';
  const m = s.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return m ? m[0].trim() : s;
}

// Unicode speaker-with-three-sound-waves emoji (U+1F50A).
const SPEAKER_EMOJI = '\u{1F50A}';

/**
 * Return the trimmed remainder of the LAST line that begins (after optional
 * leading whitespace) with the speaker emoji, or null if no such line exists.
 * @param {string} text
 * @returns {string|null}
 */
function findSummaryLine(text) {
  if (!text || typeof text !== 'string') return null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].replace(/^\s+/, '');
    if (trimmed.startsWith(SPEAKER_EMOJI)) {
      return trimmed.slice(SPEAKER_EMOJI.length).trim();
    }
  }
  return null;
}

/**
 * Strip markdown for text-to-speech and truncate to maxChars at a word
 * boundary (never mid-word). Removes fenced code blocks, inline code,
 * converts [label](url) -> label, strips heading hashes, turns bullet
 * markers into sentence breaks, strips emphasis markers, and collapses
 * whitespace. Appends an ellipsis when truncation occurred.
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
function cleanSpokenText(text, maxChars) {
  if (!text || typeof text !== 'string') return '';
  // Hard-cap the input BEFORE any regex runs. The link/markdown regexes below
  // can catastrophically backtrack on pathological bracket-heavy input, which
  // would freeze the main process. The final maxChars truncation still applies.
  if (text.length > 200000) text = text.slice(0, 200000);
  let out = text;
  // Fenced code blocks (```...```), including the language hint.
  out = out.replace(/```[\s\S]*?```/g, ' ');
  // Inline code: keep the inner text, drop the backticks.
  out = out.replace(/`([^`]*)`/g, '$1');
  // Links / images: [label](url) -> label (drop a leading ! for images).
  // Excluding '[' from the label class (in addition to ']') prevents catastrophic
  // backtracking on pathological bracket-heavy input: a '[' run can't be consumed
  // as a label body, so the engine fails fast instead of going O(n^2). Real
  // markdown link labels don't contain an unescaped '[', so output is unchanged.
  out = out.replace(/!?\[([^\][]*)\]\([^)]*\)/g, '$1');
  // Bullet markers at line start -> sentence break.
  out = out.replace(/^[ \t]*[-*+][ \t]+/gm, '. ');
  // Heading hashes at line start.
  out = out.replace(/^[ \t]*#{1,6}[ \t]*/gm, '');
  // Emphasis markers (** then *), and underscores used for emphasis.
  out = out.replace(/\*\*/g, '');
  out = out.replace(/\*/g, '');
  out = out.replace(/(^|[^a-zA-Z0-9])_([^_]+)_([^a-zA-Z0-9]|$)/g, '$1$2$3');
  // Collapse all whitespace runs to single spaces.
  out = out.replace(/\s+/g, ' ').trim();
  // Tidy any ". ." style artifacts from bullet conversion.
  out = out.replace(/\.\s*(?=\.)/g, '').replace(/^\.\s*/, '').trim();

  const limit = typeof maxChars === 'number' && maxChars > 0 ? maxChars : out.length;
  if (out.length <= limit) return out;
  let cut = out.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > 0) cut = cut.slice(0, lastSpace);
  return cut.trim() + '…';
}

/**
 * Split already-cleaned plain text into an ordered array of speakable chunks so
 * the first chunk can be synthesized and played while later ones are still being
 * synthesized ("streaming-start" voice playback). Splits on one or more
 * sentence-ending marks (. ! ?) followed by whitespace or end-of-string, keeping
 * the punctuation attached to its chunk, and treats a newline as a soft
 * boundary. Each chunk is trimmed and empty chunks are dropped. Very short
 * chunks (< 25 chars) are merged into the following chunk (joined with a space)
 * to avoid tiny fragments. Text with no sentence punctuation is returned as a
 * single chunk. Pure (no I/O); abbreviations are handled best-effort only.
 * @param {string} text - already-cleaned plain text
 * @returns {string[]} ordered speakable chunks (empty array for empty input)
 */
function splitSentences(text) {
  if (!text || typeof text !== 'string') return [];
  // Split keeping sentence-ending punctuation, and on newlines (soft boundary).
  const parts = text
    // Constant-width lookbehind ([.!?] not [.!?]+) avoids the O(n^2) backtracking
    // a variable-length lookbehind incurs on a long run of sentence punctuation.
    .split(/(?<=[.!?])(?=\s)|\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return [];

  const chunks = [];
  let pending = '';
  for (const part of parts) {
    pending = pending ? `${pending} ${part}` : part;
    // Hold onto a too-short chunk and merge the next part into it.
    if (pending.length < 25) continue;
    chunks.push(pending);
    pending = '';
  }
  if (pending) {
    // A trailing short fragment merges back into the previous chunk if one exists.
    if (chunks.length > 0) chunks[chunks.length - 1] += ` ${pending}`;
    else chunks.push(pending);
  }
  return chunks;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractSpeakableText, findSummaryLine, cleanSpokenText, lastAssistantUuid, splitSentences, firstSentence };
}
if (typeof window !== 'undefined') {
  window.VoiceText = { extractSpeakableText, findSummaryLine, cleanSpokenText, lastAssistantUuid, splitSentences, firstSentence };
}
