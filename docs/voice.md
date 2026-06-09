# Voice (Text-to-Speech) Feature

Reads Claude's replies aloud through **ElevenLabs**. This document explains the architecture, the non-obvious design decisions, and the gotchas that have repeatedly tripped people up. **Read this before changing anything under the voice feature.**

---

## 1. The one thing you must understand first

> **Interactive Claude Code columns frequently do NOT persist their reply to the on-disk transcript in real time.**

A freshly-spawned interactive `claude` session often writes only a ~110-byte stub to
`~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`:

```json
{"type":"ai-title","aiTitle":"…","sessionId":"…"}
```

…and the actual user/assistant **messages never appear** until/unless the session flushes them later (multi-turn, resume, or some internal trigger we don't control). Established / multi-turn / `--print` sessions *do* get full transcripts, but a brand-new column's first reply usually does not.

**Consequence:** the disk transcript is an unreliable source for *real-time* voice. This was the root cause of a long debugging saga where "Play does nothing" / "no audio" — the file simply wasn't there yet.

**The fix / current architecture:** voice reads the reply straight off the **live terminal buffer** (what's on screen) first, and only falls back to the disk transcript when the terminal yields nothing. See §3.

---

## 2. Where the code lives

| Layer | File | What |
|---|---|---|
| Pure libs (unit-tested) | `lib/terminal-reply.js` | Parse the **rendered terminal buffer** → last assistant reply; 🔊-summary split; `firstSentence` |
| | `lib/voice-text.js` | Parse the **transcript JSONL** → speakable text; reading-mode logic; sentence splitting; `firstSentence` |
| | `lib/voice-transcript-path.js` | Build/resolve the transcript file path from cwd/projectKey/sessionId |
| | `lib/voice-settings.js` | Validate/merge the voice settings object |
| | `lib/voice-request.js` | Build the ElevenLabs request body (voice_settings tuning) |
| | `lib/voice-personality.js` | Manage the persona block written into global `~/.claude/CLAUDE.md` |
| | `lib/session-target.js` | Session-attribution helpers (`isUsableSessionTarget`, `shouldBindHookSession`, `resolveInputColumn`) |
| | `lib/spawn-session.js` | `planFreshSessionId` — deterministic `--session-id` at fresh spawn |
| Main process | `main.js` (IPC handlers, see §8) | Reads transcripts, calls ElevenLabs, stores settings/key |
| Renderer | `renderer.js` (the `[voice]` section, ~9450–9990) | Eligibility, terminal extraction, playback, buttons, caching |
| UI shell | `index.html` (Voice settings pane) + `lib/*.js` `<script>` tags | Settings panel; loads the browser-side libs |

Each `lib/*.js` has a `test/*.test.js` (run `npm test`; ~227 tests). The libs use the dual-export footer: `module.exports` for Node + `window.X = {…}` for the renderer.

---

## 3. Two reply sources (terminal-first, transcript-fallback)

### 3a. Live terminal (primary, real-time)
- `readColumnTerminalLines(col)` (renderer) reads `col.terminal.buffer.active` line-by-line via `getLine(i).translateToString(true)`.
- `lib/terminal-reply.js` `extractLastTerminalReply(lines)` parses Claude's rendered TUI:
  - A reply/tool block starts at a **column-0 bullet** `● ` (`/^[●•▪]\s+…/`).
  - **Continuation** lines are indented ≥2 spaces; **paragraph breaks (blank lines)** are bridged as long as the reply resumes with an indented line (so multi-paragraph replies aren't cut).
  - A block is a **TOOL block** (skipped) if its first line is `ToolName(…)` (`/^([A-Z][A-Za-z0-9_]*|mcp__\w+)\(/`) or a tool result `⎿`. **MCP tools are lowercase `mcp__server__tool(…)` — the regex explicitly matches that.**
  - Returns the **last PROSE block** (the final spoken answer), skipping tool calls/results.
  - The block ends at the col-0 `✻ … for Ns` footer, the `❯` prompt, or `────` separators (none are indented).
- **This is TUI scraping. It is inherently fragile.** If Anthropic restyles the Claude Code TUI (bullet/footer/tool glyphs), re-capture real fixtures (see §11) and update the parser + its tests.

### 3b. Transcript JSONL (fallback)
- Used when the terminal yields nothing (e.g. an old/persisted reply, or a non-rendered column).
- `lib/voice-text.js` `extractSpeakableText(jsonl, {readingMode, maxChars})` → finds the **last speakable assistant message** (`lastSpeakableAssistant` skips tool-only/thinking-only and non-content turns like "No response requested.").
- Path resolution prefers the column's **actual cwd** then the projectKey (`resolveColumnTranscriptPath` in main.js + `lib/voice-transcript-path.js`), because a column running in a subdirectory writes its transcript under a different sanitized key.

---

## 4. Reading modes & the 🔊 convention

Replies may end with a **🔊 (U+1F50A) summary line** — a spoken one-liner (the user's global `~/.claude/CLAUDE.md` instructs Claude to add one to long/code-heavy replies).

`Reading mode` (a voice setting) controls what gets spoken:

| Mode | With a 🔊 line | Without a 🔊 line |
|---|---|---|
| `full` | body, **🔊 line stripped**, truncated to `maxChars` | full body, truncated to `maxChars` |
| `summary` | the 🔊 line only | **first sentence** (`firstSentence`) — concise, NOT the full body |
| `auto` (default) | the 🔊 line only | full body (truncated) |

- Terminal path: `cleanTerminalSpoken(rawText, readingMode)` + `splitReplySummary(rawJoined)` (splits on the last 🔊).
- Transcript path: `extractSpeakableText` summary branch mirrors the same fallback (`firstSentence`).
- **`auto` keeps the full-reply fallback** when there's no 🔊 line (it means "summary *if I add one*, else full reply"). Only the explicit **summary button** is always concise.
- `Read length` (`maxChars`, default 600) caps `full`-mode reads at a word boundary.

---

## 5. Auto-play eligibility (when does it speak on its own?)

On a column's `Stop` hook (`onVoiceHookEvent` in renderer), auto-play runs only if eligible:

- `voiceSettings.enabled` is true, the project is **not muted** (`isProjectVoiceMuted`), and the window is focused (`voiceWindowFocused`).
- **`mode`** (the "What to speak" setting):
  - `all` → speak every column's reply (ignores focus).
  - `active` (default) / `active+notify` → **only the focused column** speaks.
  - `notify` → only Notification events, never Stop.
- **Focus is GLOBAL, not per-project.** `isActive = lastFocusedColumnId === colId && voiceWindowFocused`. `lastFocusedColumnId` is a single global set in `setFocusedColumn`. **Do not** use the per-project `state.focusedColumnId` for eligibility — each project keeps its own, so a background column would wrongly count as "active" and speak.
- A ~250 ms **settle delay** lets the final terminal line render before reading the buffer; eligibility (focus/mute/enabled) and the stream generation are **re-checked after** the await so a click-away or a manual press during the window wins.
- **Dedup:** `col.lastSpokenText` (the cleaned spoken string) prevents auto-speaking the same reply twice.
- Ineligible Stops set `col.voiceUnspoken = true` so **focus catch-up** ("Speak a column's summary when I focus it") can speak it later when you switch to that column.
- Playback is **streaming/chunked**: `streamSpeakText`/`streamSpeakColumn` split into sentences and synth one chunk ahead while the current plays, so audio starts fast. `voiceStreamGen` lets a newer Stop / manual press supersede an in-flight stream.

---

## 6. Per-column buttons (Play / Summary) & caching

- Each column header has a **full** play button and a **summary** button → `playColumnReply(colId, 'full' | 'summary')`. Focus catch-up uses the configured `readingMode` (or `auto`).
- **Press-while-speaking does NOT restart.** Played audio is tagged with `audio.__colId`. If you press a button for a column that's already speaking (auto-play or manual):
  - same exact source (`__src === colId:mode`) → **pause/resume**;
  - different source (auto-play, or the other mode button) → **stop** (`stopAllVoice()`), no re-synth.
- **Synth cache (terminal path only):** `col.voiceCache[srcKey] = { text, result }`. A repeat press with identical text **replays from cache — no ElevenLabs call**. A new reply (different text) misses and re-synths.
- **The transcript path is intentionally NOT cached** — its only available key (`lastSpokenUuid`) can lag and replay stale audio for a new reply. Don't re-add a uuid-keyed cache there.
- `refreshVoiceButtonStates()` reflects state on the buttons (Stop / Resume / default), including columns speaking via auto-play (matched by `__colId`).

---

## 7. Session attribution (which session is a column reading?)

A column tracks `col.sessionId`. Getting it right was the source of "voice reads the wrong column" / "hallucination" bugs. Current rules — **do not regress these**:

- **Fresh local spawns get a deterministic `--session-id <uuid>`** (`lib/spawn-session.js` `planFreshSessionId`; wired in the spawn path). `col.sessionId` is set immediately and `--session-id` is kept OUT of the persisted `cmdArgs` (the effort-relaunch builder also strips it) so respawns don't re-feed a used id.
- **The session-sync poll is READ-ONLY for `sessionId`.** It only refreshes `sessionMtime`. It used to reassign columns to the newest session by mtime and its claimed-guard raced — so an idle column **stole a sibling's live session**. Never reintroduce mtime-based reassignment.
- **`detectSession` is acquire-only** — it assigns a session to a column that has none; it never reassigns a held id, and it skips 0-byte sessions (`isUsableSessionTarget`).
- **Hook-driven binding** (`clawdResolveHookColumnEx` → `shouldBindHookSession`): an unambiguous-cwd or dominant-recent-input (`resolveInputColumn`) `UserPromptSubmit` rebinds `col.sessionId` to follow a `/clear` fork, guarded so it can never bind onto a sibling's claimed session.

---

## 8. Main-process IPC surface (`main.js`)

| Handler | Purpose |
|---|---|
| `voice:getSettings` / `voice:setSettings` | Read/merge the public voice settings (the API key is never returned to the renderer). |
| `voice:getPersonality` / `voice:setPersonality` | Read/write the persona block in global `~/.claude/CLAUDE.md`. |
| `voice:listVoices` | List ElevenLabs voices (`/v1/voices`). |
| `voice:synthesize` | TTS for arbitrary text (test button, Notification messages). |
| `voice:synthesizeColumn` | Manual Play: resolve the column transcript → extract → synth. Returns a `diag` object (resolvedPath / exists / size / lengths) for debugging. |
| `voice:synthesizeFreshFromColumn` / `voice:extractColumnSentences` | Auto-play transcript path: poll for a reply newer than `baselineUuid`, then synth / return sentence chunks. |
| `voice:peekColumn` | Cheap "what's the latest assistant uuid + has-text" probe (sets the pre-turn baseline). |
| `voice:synthesizeFromTranscript` | TTS directly from a transcript path. |

- **API key:** stored via `safeStorage` (encrypted) when the OS keyring is available, else **plain text** (the settings UI warns). `encryptToken`/`decryptToken`. The key is used only main-side to call ElevenLabs; it is never sent to the renderer.
- Audio is returned as **base64** (binary over the contextBridge is unreliable) and played via a `data:audio/mpeg;base64,…` URL. This requires CSP `media-src 'self' data: blob:` in index.html.
- `readVoiceTranscript()` reads a 1 MB tail and drops the partial leading line so the newest record never parses mid-line.

---

## 9. Settings storage & the clobber gotcha

- Voice settings live under the top-level `voice` object in `~/.claudes/projects.json` (dev: `projects-dev.json`). Terminal settings live under `terminal`.
- Both are written **immediately** by their own IPC handlers (`voice:setSettings`, the terminal settings handler).
- **Gotcha (fixed — keep it fixed):** `config:saveProjects` is debounced and writes the renderer's *startup-stale* full config on every layout change. It must **preserve the on-disk `voice` and `terminal`** objects (`preserveManagedSettings` re-reads them at write time in the debounced flush AND the quit-time `flushPendingConfig`), or it clobbers settings the user just changed → "settings don't save / are glitchy."

---

## 10. Dev vs production app

- **Never close the user's installed/production app** (`…\AppData\Local\Programs\Claudes\Claudes.exe`). It's their daily driver. Test by running the **dev build** (`npm start` from the repo, master) **alongside** it — they coexist (dev pty-server prefers port 3457, hook-server 53457, with OS-assigned fallback if taken).
- Ship changes to the installed app via `/release` (user-triggered), not by restarting it.

---

## 11. Debugging & tuning the TUI parser

- `[voice] …` console logs (in the renderer) trace the pipeline: `hook decision` (mode/isActive/eligible), `terminal reply` (extracted len/head), `manual synth`/`extractSentences` (with a `diag` object: triedCwdPath / triedProjectPath / resolvedExists / size / contentLen / textLen). These are intentionally verbose — fine to silence once stable.
- To re-tune the terminal parser against the **real** rendered output (e.g. after a Claude TUI restyle): spawn `claude` via `node-pty`, pipe its data into a headless xterm (`@xterm/headless`), and dump `buffer.active` lines. Build fixtures from that (this is how `lib/terminal-reply.js`'s tests were written). Do NOT guess the TUI format.

---

## 12. Known limitations

- **Real-time depends on the on-screen render.** A column whose reply isn't on screen (scrolled off / never rendered) and isn't in the transcript yet can't be spoken until it's available.
- **TUI scraping is brittle** to Claude Code UI changes (see §11).
- **Multi-column `/clear` in one project**: if two same-project columns submit within ~1.5 s of each other, one `/clear` fork may not be auto-followed; it self-heals on the next prompt.
- **Popout windows**: the hook-driven `/clear` rebind runs in the main window's hook listener; popped-out columns may not follow a `/clear` fork (known, low-impact).
- **Summary without a 🔊 line** is only as good as `firstSentence` (no LLM summarization).
