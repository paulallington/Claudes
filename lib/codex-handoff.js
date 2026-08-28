// Build a Claude -> Codex handoff document from a Claude Code session
// transcript, so work started in a Claude column can be continued in a Codex
// column with the context intact.
//
// WHY A FILE AND NOT A PROMPT ARGUMENT: the CLI accepts a seed prompt
// (`codex [PROMPT]`), but a real conversation is far past any safe
// command-line length, and on Windows argv limits bite early. Writing a
// document and seeding Codex with a short "read this file" prompt is
// unbounded, inspectable by the user afterwards, and survives the column being
// respawned. (`codex exec -` reads stdin and is the equivalent for the
// non-interactive path, but our columns are interactive PTYs.)
//
// WHAT IS DELIBERATELY DROPPED, and why:
//   - `isSidechain` turns — subagent conversations. Including them would hand
//     Codex several parallel narratives interleaved with the main one.
//   - `isMeta` turns — harness bookkeeping, not conversation.
//   - `thinking` blocks — reasoning, not decisions. Also often the bulk of the
//     bytes, and the least useful thing to replay to a different engine.
//   - tool_use / tool_result payloads — file contents and command output that
//     Codex can and should re-read from the actual repository, which it has in
//     front of it. Replaying them is stale by construction.
//   - `<system-reminder>` / `<local-command-*>` wrappers — harness noise.
//
// Loaded two ways (UMD, same as the sibling libs); the renderer cannot require().

'use strict';

(function () {
  // Harness-injected wrappers that are noise in a handoff.
  var NOISE_BLOCKS = [
    /<system-reminder>[\s\S]*?<\/system-reminder>/g,
    /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
    /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
    /<command-name>[\s\S]*?<\/command-name>/g,
    /<command-message>[\s\S]*?<\/command-message>/g,
    /<command-args>[\s\S]*?<\/command-args>/g
  ];

  function scrub(text) {
    var s = String(text || '');
    for (var i = 0; i < NOISE_BLOCKS.length; i++) s = s.replace(NOISE_BLOCKS[i], '');
    return s.trim();
  }

  /**
   * Pull the plain conversational text out of one transcript record's content,
   * which is either a bare string (user turns) or an array of typed blocks
   * (assistant turns). Only `text` blocks contribute.
   * @param {*} content
   * @returns {string}
   */
  function contentText(content) {
    if (content == null) return '';
    if (typeof content === 'string') return scrub(content);
    if (!Array.isArray(content)) return '';
    var parts = [];
    for (var i = 0; i < content.length; i++) {
      var b = content[i];
      if (b && b.type === 'text' && typeof b.text === 'string') {
        var t = scrub(b.text);
        if (t) parts.push(t);
      }
    }
    return parts.join('\n\n');
  }

  /**
   * Parse transcript JSONL into ordered conversational turns.
   *
   * Tolerant by design: a transcript is appended to live and can be read
   * mid-write, so a trailing partial line is normal and must not throw.
   *
   * @param {string} jsonl raw file contents
   * @returns {{role: string, text: string, ts: string|null, cwd: string|null, branch: string|null}[]}
   */
  function extractTurns(jsonl) {
    var out = [];
    if (!jsonl) return out;
    var lines = String(jsonl).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var rec;
      try { rec = JSON.parse(line); } catch (e) { continue; }  // partial tail line
      if (!rec || (rec.type !== 'user' && rec.type !== 'assistant')) continue;
      if (rec.isMeta || rec.isSidechain) continue;
      if (!rec.message) continue;
      var text = contentText(rec.message.content);
      if (!text) continue;
      out.push({
        role: rec.type,
        text: text,
        ts: rec.timestamp || null,
        cwd: rec.cwd || null,
        branch: rec.gitBranch || null
      });
    }
    return out;
  }

  // Inputs that usefully identify what a tool call acted ON, in preference
  // order. `command` first so a Bash call reads as the command, not the cwd.
  var TARGET_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'notebook_path', 'description'];

  /**
   * Extract a compact activity trail: which tools ran, against what.
   *
   * This exists because prose alone is a poor handoff for an agentic session.
   * Measured against a real transcript: of 43 records, 27 carried no text at
   * all — they were tool calls and results. A prose-only document would have
   * handed over almost nothing from precisely the sessions most worth handing
   * over.
   *
   * We take the tool NAME and its TARGET, never the payload. Which files were
   * touched and what commands were run is real, non-recoverable context; the
   * file contents and command output are stale by construction and Codex has
   * the actual repository in front of it.
   *
   * @param {string} jsonl
   * @param {number} [limit] keep at most this many most-recent entries
   * @returns {{name: string, target: string}[]}
   */
  function extractActivity(jsonl, limit) {
    var out = [];
    if (!jsonl) return out;
    var lines = String(jsonl).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var rec;
      try { rec = JSON.parse(line); } catch (e) { continue; }
      if (!rec || rec.type !== 'assistant' || rec.isSidechain || !rec.message) continue;
      var content = rec.message.content;
      if (!Array.isArray(content)) continue;
      for (var b = 0; b < content.length; b++) {
        var blk = content[b];
        if (!blk || blk.type !== 'tool_use' || !blk.name) continue;
        out.push({ name: String(blk.name), target: toolTarget(blk.input) });
      }
    }
    var cap = typeof limit === 'number' && limit > 0 ? limit : 40;
    return out.length > cap ? out.slice(out.length - cap) : out;
  }

  // One short line describing what a tool call acted on. Never the payload.
  function toolTarget(input) {
    if (!input || typeof input !== 'object') return '';
    for (var i = 0; i < TARGET_KEYS.length; i++) {
      var v = input[TARGET_KEYS[i]];
      if (typeof v === 'string' && v.trim()) {
        var s = v.trim().replace(/\s+/g, ' ');
        return s.length > 120 ? s.slice(0, 117) + '...' : s;
      }
    }
    return '';
  }

  /**
   * Keep the most RECENT turns that fit a character budget.
   *
   * Recency wins because a handoff is about what to do next: the open thread,
   * the last decision, the current failure. Truncating from the front would
   * hand over the introduction and drop the conclusion.
   *
   * @param {Array} turns
   * @param {number} maxChars
   * @returns {{turns: Array, truncated: boolean, droppedTurns: number}}
   */
  function tailWithinBudget(turns, maxChars) {
    var list = turns || [];
    var budget = typeof maxChars === 'number' && maxChars > 0 ? maxChars : 60000;
    var kept = [];
    var used = 0;
    for (var i = list.length - 1; i >= 0; i--) {
      var cost = list[i].text.length + 24;   // + heading overhead
      if (used + cost > budget && kept.length) break;
      kept.unshift(list[i]);
      used += cost;
    }
    return {
      turns: kept,
      truncated: kept.length < list.length,
      droppedTurns: list.length - kept.length
    };
  }

  /**
   * Render the handoff document.
   * @param {{turns: Array, title?: string, cwd?: string, branch?: string, sessionId?: string, generatedAt?: string, maxChars?: number}} input
   * @returns {string} markdown
   */
  function buildHandoffDoc(input) {
    input = input || {};
    var budgeted = tailWithinBudget(input.turns || [], input.maxChars);
    var lines = [];

    lines.push('# Handoff from a Claude session');
    lines.push('');
    lines.push('You are picking up work that was in progress in a Claude Code session.');
    lines.push('Below is the conversation. Read it for intent and decisions already');
    lines.push('made, then continue the work.');
    lines.push('');
    lines.push('**Do not re-read this file for repository facts.** Anything about the');
    lines.push('code itself may already be stale — the repository in front of you is the');
    lines.push('source of truth. Use this only for what was decided and what is still open.');
    lines.push('');
    lines.push('| | |');
    lines.push('|---|---|');
    if (input.title) lines.push('| Column | ' + input.title + ' |');
    if (input.cwd) lines.push('| Working directory | `' + input.cwd + '` |');
    if (input.branch) lines.push('| Git branch | `' + input.branch + '` |');
    if (input.sessionId) lines.push('| Source session | `' + input.sessionId + '` |');
    if (input.generatedAt) lines.push('| Generated | ' + input.generatedAt + ' |');
    lines.push('| Turns included | ' + budgeted.turns.length + ' |');
    lines.push('');

    if (budgeted.truncated) {
      lines.push('> **Earlier conversation omitted.** The first ' + budgeted.droppedTurns +
        ' turn(s) were dropped to fit a size budget; what follows is the most recent');
      lines.push('> stretch. If something is referenced that you cannot find, ask rather');
      lines.push('> than assume.');
      lines.push('');
    }

    var activity = input.activity || [];
    if (activity.length) {
      lines.push('## What the session actually did');
      lines.push('');
      lines.push('Tool calls in order, most recent last — names and targets only, no');
      lines.push('payloads. Use this to see which files and commands were in play; read');
      lines.push('the files themselves for their current contents.');
      lines.push('');
      for (var a = 0; a < activity.length; a++) {
        var act = activity[a];
        lines.push('- `' + act.name + '`' + (act.target ? ' — ' + act.target : ''));
      }
      lines.push('');
    }

    if (!budgeted.turns.length) {
      lines.push('_No conversation was recoverable from the transcript._ It may not have');
      lines.push('been flushed to disk yet — a freshly started column writes very little');
      lines.push('until its first exchange completes. Ask what the task is.');
      lines.push('');
      return lines.join('\n');
    }

    lines.push('---');
    lines.push('');
    for (var i = 0; i < budgeted.turns.length; i++) {
      var t = budgeted.turns[i];
      lines.push('## ' + (t.role === 'user' ? 'User' : 'Claude'));
      lines.push('');
      lines.push(t.text);
      lines.push('');
    }
    return lines.join('\n');
  }

  /**
   * The short prompt the Codex column is seeded with. Kept deliberately small —
   * the document carries the payload, this only points at it.
   * @param {string} relPath path to the handoff doc, relative to Codex's cwd
   * @returns {string}
   */
  function buildHandoffPrompt(relPath) {
    var p = String(relPath || '').trim();
    if (!p) return '';
    return 'Read ' + p + ' first. It is a handoff from a Claude Code session that ' +
      'was working in this repository. Pick up from where it left off. Treat the ' +
      'repository as the source of truth for code; treat the handoff as the source ' +
      'of truth for intent and decisions. If the handoff conflicts with what you ' +
      'find, say so rather than silently choosing one.';
  }

  /**
   * Filename for a handoff doc. Timestamp-based so successive handoffs from the
   * same column don't overwrite each other.
   * @param {string|Date} when
   * @returns {string}
   */
  function handoffFileName(when) {
    var d = when instanceof Date ? when : new Date(when || Date.now());
    var iso = isNaN(d.getTime()) ? '' : d.toISOString();
    var stamp = iso ? iso.replace(/[:.]/g, '-').replace(/Z$/, '') : 'unknown';
    return 'handoff-' + stamp + '.md';
  }

  var api = {
    extractTurns: extractTurns,
    extractActivity: extractActivity,
    contentText: contentText,
    tailWithinBudget: tailWithinBudget,
    buildHandoffDoc: buildHandoffDoc,
    buildHandoffPrompt: buildHandoffPrompt,
    handoffFileName: handoffFileName
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.CodexHandoff = api;
  }
})();
