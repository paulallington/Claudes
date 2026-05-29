# Effort badge as source of truth (resume-respawn)

**Date:** 2026-05-29
**Status:** Approved (design)
**Area:** `renderer.js` (per-column effort control)

## Problem

The per-column effort control (the "High" badge / `col-effort` `<select>` in the
column header) is set at spawn via the `claude --effort <level>` flag, but its
displayed value can go stale: today, changing it mid-session opens the
interactive `/effort` picker (`mousedown → write "/effort\n"`), and the app
cannot observe what the user selects there. So the badge stops reflecting the
session's actual effort.

Investigation confirmed there is **no readable signal** for the live effort:

- The session `.jsonl` (the source the context meter polls via
  `getSessionContextTokens`) records `message.model`, `cwd`, `gitBranch`, token
  usage, etc. — but **no effort field**.
- Hook event payloads (the inspector feed) don't carry effort either.
- The CLI exposes `--effort low|medium|high|xhigh|max` at spawn only; there is
  no non-interactive mid-session setter (`/config set effort` doesn't exist;
  `/effort` is an interactive TUI picker).

Therefore the badge can only be truthful if the **app remains the source of
truth** for effort — i.e. effort only ever changes through a mechanism the app
controls.

## Approach (chosen)

Make the dropdown drive effort deterministically by **respawning the session
with `--resume` + the new `--effort`**. Verified: `--resume [sessionId]` and
`--effort <level>` both exist and compose; the app already respawns sessions via
`['--resume', col.sessionId]` (restart button at `renderer.js:2852`).

Rejected alternatives: an "unknown/?" honest-uncertainty badge (never shows the
real value); programmatically driving the `/effort` picker with arrow keys
(fragile against TUI layout, which just shifted when `ultracode` was added).

## Changes (all in `renderer.js`)

1. **Per-column effort state.** Add `col.effort`, initialized from the
   spawn-time `--effort` (cloud/local default). The dropdown always renders
   `col.effort`.

2. **Dropdown becomes a real `change` selector.** Replace the
   `mousedown → "/effort\n"` handler with a `change` handler that:
   - no-ops if the value is unchanged;
   - sets `col.effort` and respawns the column resuming the same session:
     `args: ['--resume', col.sessionId, '--effort', <new>]`, then clears the
     terminal and marks it working — reusing the restart flow at
     `renderer.js:2844`.

3. **Preserve effort on all respawns.** Append `'--effort', col.effort` to the
   resume args in the existing resume paths: restart button (2852),
   auto-resume-on-pty-death (~636), and SendMessage resume (~4229). This also
   fixes the current silent effort-loss on respawn.

4. **Reuse the local-endpoint effort guard.** Pass the new effort through the
   existing `rewriteEffortForEndpoint` logic (~2245) so `xhigh`/`max` don't 400
   on local-server presets.

## Behaviour decisions

- **Mid-turn change:** if the column is actively working, confirm before
  respawning (the resume picks up from the transcript, but the in-flight turn is
  interrupted). Respawn immediately when idle.
- **No session yet** (fresh column, nothing submitted): changing the dropdown
  just updates `col.effort`; it applies on the first spawn.

## Out of scope

- **`ultracode`** — not a `--effort` value (it's xhigh + workflows, enabled via
  `--settings`/control request). It cannot ride this mechanism. The dropdown
  stays `low → max`. A separate feature if wanted later.
- No `main.js` / `pty-server.js` changes.

## Success criteria

- Selecting a new effort visibly resumes the session at that effort, and the
  badge reflects the selected value.
- Respawn / auto-resume / SendMessage-resume preserve the column's effort
  rather than dropping it.
- Local-endpoint columns never receive an effort value the local server rejects.
