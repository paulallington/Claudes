'use strict';

// Which command resolves an executable's path on this platform.
function codexLookupCommand(platform) {
  return platform === 'win32' ? 'where' : 'which';
}

// First non-empty line of `where`/`which` output, or null if none.
function parseWhichOutput(raw) {
  if (!raw) return null;
  const lines = String(raw).split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

// Descriptor for spawning a Codex column via addColumn(args, row, opts).
// Deliberately carries NO Claude-specific fields — a Codex column must never
// pick up permission-mode / model / headroom / endpoint plumbing.
function buildCodexSpawn(cwd) {
  return {
    args: [],
    opts: { cmd: 'codex', title: 'Codex', cwd: cwd == null ? null : cwd }
  };
}

// A column uses Claude-specific header chrome (compact/teleport/effort, the
// starburst icon) only when it has no custom command. cmd columns (Codex,
// launch configs) do not.
function columnUsesClaudeChrome(col) {
  return !col || !col.cmd;
}

module.exports = {
  codexLookupCommand,
  parseWhichOutput,
  buildCodexSpawn,
  columnUsesClaudeChrome
};
