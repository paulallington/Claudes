# Usage Modal Rework — Design

**Date:** 2026-04-20
**Status:** Approved

## Problem

Three issues with the in-app Usage modal (toolbar → Usage):

1. **Hangs on open.** `ipcMain.handle('usage:getAll')` walks every `~/.claude/projects/*/<sessionId>.jsonl` sequentially, `readFile`s the whole file, `split('\n')`s, and `JSON.parse`s every line. No caching. With many sessions this stalls the UI for seconds.
2. **Token count is misleading.** "Total Tokens" currently sums `input + cache_read + cache_creation` across every assistant message in every session. That matches what Anthropic processed (correct for energy/cost) but heavily over-counts conversation content because `cache_read_input_tokens` grows turn-over-turn — the displayed number is quadratic in conversation length, not linear in content.
3. **Environmental / token displays are dry.** Current equivalents (Google searches, LED hours, Netflix) are fine but uninspired; no humour, no rotation, no absurd-mundane flavour.

## Goals

- Open the modal in <200 ms on warm cache, <1 s on cold cache for typical session counts.
- Show both "API tokens processed" and a grounded "conversation tokens" headline side-by-side, each self-explanatory.
- Make the equivalents sections entertaining on repeat opens via rotation + a reroll button.

## Non-goals

- Rewriting the summary chart, daily view, or sessions table.
- Showing per-user Anthropic API pricing / billing figures.
- Transferring usage data across machines.

## Design

### Performance

Three compounding changes inside `ipcMain.handle('usage:getAll')`:

1. **Parallelise.** Replace the nested `for…of + await` loops with a batched `Promise.all` over jsonl files (concurrency cap 8).
2. **Line-stream.** Use `readline` over `createReadStream` instead of `readFile`+`split`. Cheap-reject lines that don't contain `"usage"` or `"timestamp"` before `JSON.parse` — most lines are tool output and prompts we never aggregate from.
3. **Cache.** Persist per-session digests to `~/.claudes/usage-cache.json`:
   ```
   {
     "<projectKey>/<sessionId>": {
       mtimeMs, size,
       inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
       model, firstTimestamp, lastTimestamp, messageCount,
       lastTurn: { input, output, cacheRead, cacheCreation }
     }
   }
   ```
   A file is cache-valid iff both `mtimeMs` and `size` match the on-disk jsonl. Valid entries skip parsing entirely. Cache is written at the end of every `usage:getAll`. First open rebuilds in full; every open thereafter is near-instant.

### Token methodology

Per-session digest gains a `lastTurn` field: the `input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens` of the **final** assistant message. This represents the true conversation size at its peak.

In the renderer's `renderUsageSummary`:

- `totalApiProcessed` = sum across the selected period of each session's `inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens`. Unchanged from today.
- `totalConversation` = sum across the selected period of each session's `lastTurn.total`. New.

Top summary changes from one "Total Tokens" card to three:

| Card | Value | Sub-label |
|---|---|---|
| API Tokens Processed | `formatTokenCount(totalApiProcessed)` | "incl. cached re-reads · drives energy estimate" |
| Conversation Tokens | `formatTokenCount(totalConversation)` | "actual content across your chats" |
| Input / Output | `formatTokenCount(input) / formatTokenCount(output)` | API-processed in / out |

A small `(i)` hover tooltip on the first two cards explains the difference.

Environmental impact block is **unchanged** — it already uses input+output+cache per model, which is the right energy proxy regardless of this relabel.

### Humour layer

Two data modules in `renderer.js` (or a separate included file if it grows large):

```js
var TOKEN_EQUIVALENTS = [
  { unit: "complete LOTR trilogies (text)", tokensPer: 576000, tone: "nerdy" },
  { unit: "full Shakespeare plays", tokensPer: 30000, tone: "nerdy" },
  { unit: "IKEA instruction manuals end-to-end", tokensPer: 2000, tone: "mundane" },
  { unit: "tweets (old 280-char era)", tokensPer: 50, tone: "mundane" },
  { unit: "regretful voicemails left by a sentient toaster", tokensPer: 300, tone: "absurd" },
  { unit: "pages of minutes from an imaginary goose AGM", tokensPer: 500, tone: "absurd" },
  { unit: "slightly embarrassed British apologies", tokensPer: 12, tone: "deadpan" },
  { unit: "strongly worded letters to the council", tokensPer: 180, tone: "deadpan" },
  // ~30 entries total, balanced across tones
];

var ENV_EQUIVALENTS = [
  { unit: "electric shavers fully charged", gCO2Per: 0.8, tone: "mundane" },
  { unit: "hair dryers run for 1 minute", gCO2Per: 2, tone: "mundane" },
  { unit: "Tamagotchis kept alive for 24h", gCO2Per: 0.02, tone: "mundane" },
  { unit: "Roombas woken up unnecessarily", gCO2Per: 1, tone: "mundane" },
  { unit: "tears boiled off a single disappointed octopus", gCO2Per: 0.5, tone: "absurd" },
  { unit: "gerbils levitated for 3 seconds", gCO2Per: 0.9, tone: "absurd" },
  { unit: "seconds of a DeLorean at 88mph", gCO2Per: 85, tone: "nerdy" },
  { unit: "mildly awkward silences in a Zoom meeting", gCO2Per: 0.3, tone: "deadpan" },
  // ~25 entries total
];
```

**Picker** (`pickEquivalents(pool, metric, count, seed, excludeSet)`):

1. Filter pool to entries where `0.3 ≤ metric / entry.per ≤ 5000` (keeps display counts sensible).
2. Seeded shuffle over the filtered pool.
3. Take the first `count` entries, ensuring no tone appears more than twice.
4. If the tone constraint can't be satisfied with filtered entries, relax and accept any mix.
5. If fewer than `count` entries total, return what we have.

`excludeSet` supports the reroll button: pass the currently-displayed units so reroll never gives you the same four back.

**Reroll button**: small circular `↻` button in the top-right of each grid. Click increments a seed counter and re-runs the picker with the current 4 in `excludeSet`.

### UI changes

- `index.html`: add a new section `<div id="usage-tokens-perspective">` between the summary cards and the chart. Add reroll buttons to both `#usage-environmental` and `#usage-tokens-perspective`.
- `renderer.js`:
  - `renderUsageSummary` emits three cards instead of one.
  - New `renderTokensPerspective(totalConversation, periodLabel)` builds the 4-card grid.
  - `renderEnvironmentalImpact` replaces the single-best-equivalent display with a 4-card grid, using the picker with `ENV_EQUIVALENTS`.
  - Both rendering functions set `data-seed` on the container so reroll can bump it.
- `styles.css`: grid styles for the new `.usage-env-grid` (extend) and `.usage-tokens-grid` (new). Reroll button styling.

### Accessibility

- `(i)` tooltips are `title=` attributes plus a visible info-dot icon; full sentence stays on the card for screen readers.
- Reroll button has `aria-label="Re-roll equivalents"`.

## Files touched

- `main.js` — rewrite `ipcMain.handle('usage:getAll')`, add cache helpers.
- `renderer.js` — new `TOKEN_EQUIVALENTS`, `ENV_EQUIVALENTS`, picker, `renderTokensPerspective`; update `renderUsageSummary`, `renderEnvironmentalImpact`.
- `index.html` — new perspective section + reroll buttons.
- `styles.css` — new grid + reroll button styles.

## Risks

- **Cache staleness** if a jsonl is overwritten with same size+mtime: theoretically possible, practically never (Claude CLI appends only). Mitigation: `size` check already guards against in-place edits that change length.
- **Equivalent calibrations** for absurd units are guesses by definition. Tag the environmental section header with "(estimated)" as it already does.
- **Tone constraint solvability**: if a tone has only 1 entry and the range filter rejects it, we relax — worst case the same tone twice, which is fine.
