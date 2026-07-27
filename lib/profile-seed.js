// lib/profile-seed.js

// Per-project keys carried into a new profile's .claude.json. Deliberately a
// closed allowlist, not a denylist: the CLI adds keys over time, and a
// denylist would silently start copying whatever is added next. Everything
// here is a decision the USER made about a folder; everything excluded is
// either telemetry, cache, or account identity.
const TRUST_KEYS = [
  'hasTrustDialogAccepted',
  'allowedTools',
  'hasClaudeMdExternalIncludesApproved',
  'projectOnboardingSeenCount'
];

/**
 * Build the .claude.json body for a freshly created profile from the primary
 * account's .claude.json.
 *
 * NO top-level key is copied. `oauthAccount` is the account identity and must
 * come from a real `/login` in the new profile; copying it would cross the
 * subscriptions over. Only the per-project trust allowlist survives, so the
 * first column on a new profile does not stall on the folder-trust prompt.
 */
function extractSeedClaudeJson(primary) {
  const out = { projects: {} };
  const src = primary && typeof primary === 'object' ? primary.projects : null;
  if (!src || typeof src !== 'object' || Array.isArray(src)) return out;

  for (const key of Object.keys(src)) {
    const entry = src[key];
    if (!entry || typeof entry !== 'object') continue;
    const kept = {};
    let any = false;
    for (const k of TRUST_KEYS) {
      if (Object.prototype.hasOwnProperty.call(entry, k)) { kept[k] = entry[k]; any = true; }
    }
    if (any) out.projects[key] = kept;
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractSeedClaudeJson, TRUST_KEYS };
}
if (typeof window !== 'undefined') {
  window.ProfileSeed = { extractSeedClaudeJson, TRUST_KEYS };
}
