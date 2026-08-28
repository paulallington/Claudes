// lib/profile-resolve.js
// The renderer loads this file via a <script> tag and is sandboxed — it has no
// require(). Only profileClaudeRoot() needs path, and only main calls it, so
// the import is optional and its absence is a clear error rather than a
// module that fails to load at all.
const path = (typeof require === 'function') ? require('path') : null;

const PRIMARY_ID = 'primary';
const PRIMARY_FALLBACK = { id: PRIMARY_ID, name: 'Primary', configDir: null, colour: '#d97757' };

/**
 * Resolve which Claude profile a column/automation runs under.
 *
 * The cascade is column -> workspace -> project -> global default. The first
 * non-empty id in that chain is the SELECTION; if that id is not in the
 * registry the result is Primary plus a warning. Falling through to the next
 * level on an unknown id would silently mask corrupt config, and the delete
 * flow already rewrites dangling references.
 *
 * `profileId` values arrive from sessions.json / projects.json /
 * automations.json and are therefore untrusted. They are only ever used as
 * registry KEYS — never as paths. Only profiles.json (app-written) supplies
 * configDir.
 */
function resolveProfile(input) {
  const o = input || {};
  const list = Array.isArray(o.profiles) ? o.profiles : [];
  const byId = Object.create(null);
  for (const p of list) {
    if (p && typeof p.id === 'string' && p.id) byId[p.id] = p;
  }

  const chain = [o.columnProfileId, o.workspaceProfileId, o.projectProfileId, o.defaultProfileId];
  let selected = null;
  for (const id of chain) {
    if (typeof id === 'string' && id) { selected = id; break; }
  }

  let warning = null;
  let profile;
  if (!selected) {
    profile = byId[PRIMARY_ID] || PRIMARY_FALLBACK;
  } else if (byId[selected]) {
    profile = byId[selected];
  } else {
    warning = 'unknown-profile:' + selected;
    profile = byId[PRIMARY_ID] || PRIMARY_FALLBACK;
  }

  const configDir = (typeof profile.configDir === 'string' && profile.configDir) ? profile.configDir : null;
  const isPrimary = !configDir;

  return {
    id: profile.id || PRIMARY_ID,
    name: profile.name || 'Primary',
    configDir,
    isPrimary,
    colour: profile.colour || PRIMARY_FALLBACK.colour,
    // Primary sets NO env var at all. This is what makes the whole feature a
    // no-op for single-subscription users.
    env: isPrimary ? {} : { CLAUDE_CONFIG_DIR: configDir },
    warning
  };
}

/**
 * The root that stands in for `~/.claude` for this profile: transcripts live
 * at <root>/projects/<key>/<id>.jsonl, credentials at <root>/.credentials.json.
 */
function profileClaudeRoot(profile, homeDir) {
  const dir = profile && typeof profile.configDir === 'string' && profile.configDir ? profile.configDir : null;
  if (dir) return dir;
  if (!path) throw new Error('profileClaudeRoot requires Node path (main process only)');
  return path.join(homeDir, '.claude');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { resolveProfile, profileClaudeRoot, PRIMARY_ID };
}
if (typeof window !== 'undefined') {
  window.ProfileResolve = { resolveProfile, profileClaudeRoot, PRIMARY_ID };
}
