// Parse xterm's OSC 52 payload — the escape sequence Claude's TUI emits to copy
// text to the system clipboard. xterm.js has no built-in OSC 52 handler, so the
// renderer registers one that funnels the payload through here and writes the
// result to the Electron clipboard. Pure: no DOM, no Electron, no deps.
//
// `data` is everything after `52;`, i.e. `<selection>;<payload>` where
// <selection> is zero or more of `c p q s 0-7`. A payload of `?` is a clipboard
// READ request (unsupported → null). Otherwise <payload> is base64-encoded UTF-8.
// Returns the decoded string, or null for read requests / malformed input.
function parseOsc52(data) {
  if (typeof data !== 'string') return null;
  var sep = data.indexOf(';');
  if (sep === -1) return null;

  var payload = data.slice(sep + 1);
  if (payload === '?') return null;

  // Some OSC 52 emitters chunk/wrap the base64 at column boundaries, so strip
  // ALL whitespace before validating and decoding. Empty after stripping → null.
  var clean = payload.replace(/\s/g, '');
  if (clean === '') return null;

  // Reject anything that isn't well-formed base64. Node's Buffer.from silently
  // strips invalid chars (and tolerates bad padding) rather than failing, so
  // validate up front — the character check plus the length-multiple-of-4 check
  // make Node reject the same malformed input the renderer's atob throws on,
  // giving consistent null-on-malformed behaviour across both paths.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return null;
  if (clean.length % 4 !== 0) return null;

  // Defense-in-depth: a rogue pty process shouldn't be able to silently dump
  // unbounded data to the system clipboard. 5M chars is far above any real copy.
  var MAX_DECODED_CHARS = 5 * 1024 * 1024;

  try {
    if (typeof Buffer !== 'undefined') {
      // Node path (and Electron main). Buffer decodes base64 → UTF-8 directly.
      var decoded = Buffer.from(clean, 'base64');
      if (decoded.length === 0) return null;
      var text = decoded.toString('utf8');
      if (text.length > MAX_DECODED_CHARS) return null;
      return text;
    }
    // Renderer path: atob yields a binary (latin1) string; reinterpret its bytes
    // as UTF-8 via TextDecoder so multibyte characters survive.
    var binary = atob(clean);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    var out = new TextDecoder('utf-8').decode(bytes);
    if (out.length > MAX_DECODED_CHARS) return null;
    return out;
  } catch (e) {
    return null;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseOsc52: parseOsc52 };
}
if (typeof window !== 'undefined') {
  window.Osc52 = { parseOsc52: parseOsc52 };
}
