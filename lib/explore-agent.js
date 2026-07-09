const path = require('path');

// Relative path (OS-correct) where the Explore subagent override file lives.
const EXPLORE_AGENT_REL = path.join('.claude', 'agents', 'Explore.md');

function exploreAgentRelPath() {
  return EXPLORE_AGENT_REL;
}

const KNOWN_MODELS = new Set(['haiku', 'sonnet', 'opus', 'fable']);
const CLAUDE_MODEL_RE = /^claude-[a-z0-9.\-]+$/;

function assertValidModel(model) {
  if (typeof model === 'string' && (KNOWN_MODELS.has(model) || CLAUDE_MODEL_RE.test(model))) {
    return;
  }
  throw new TypeError(
    'buildExploreAgentFile: invalid model ' + JSON.stringify(model) +
    ' (expected haiku|sonnet|opus|fable or claude-*)'
  );
}

// Build the full text of a `.claude/agents/Explore.md` subagent override file.
// This pins Claude Code's built-in Explore subagent to a chosen (cheap) model
// and restricts it to read-only tools. Output is deterministic.
function buildExploreAgentFile({ model = 'haiku' } = {}) {
  assertValidModel(model);

  const frontmatter = [
    '---',
    'name: Explore',
    'description: Read-only fan-out search agent for locating code across many files, directories, and naming conventions.',
    'tools: Glob, Grep, Read',
    'model: ' + model,
    '---',
  ].join('\n');

  const body = [
    'You are a strictly read-only exploration agent. Your job is to locate code, not to review or audit it. You must not attempt to modify files or run shell commands — only locate code and report back with file:line anchors.',
    '',
    'Fan out widely. Search across many files, directories, and naming conventions at once — consider alternate spellings, casings, and synonyms for the thing you are looking for. Cast a broad net before narrowing down.',
    '',
    'Read excerpts, not whole files. Pull just enough surrounding context to confirm a match; do not dump entire files into your reasoning.',
    '',
    'Honor the requested search breadth. "Medium" means moderate exploration of the likely locations; "very thorough" means sweeping multiple locations and naming conventions exhaustively before concluding.',
    '',
    'Return a concise summary with file:line anchors — point to where the relevant code lives, not raw file contents. Locating code is the goal; leave reviewing, judging, and auditing it to the caller.',
    '',
  ].join('\n');

  return frontmatter + '\n\n' + body;
}

module.exports = { buildExploreAgentFile, EXPLORE_AGENT_REL, exploreAgentRelPath };
