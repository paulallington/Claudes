# Headroom toggles + terminal cols-sync fix — design

**Date:** 2026-07-03
**Status:** Draft (pending user review)
**Builds on:** [`2026-07-03-headroom-spawn-option-design.md`](2026-07-03-headroom-spawn-option-design.md)

## Summary

Work shipped on one branch, in priority order:

0. **App-owned proxy lifecycle** *(P0 — live blocker)* — the app starts and owns a
   single Headroom proxy; columns launch with `--no-proxy` so they only ever
   *reuse* it. Fixes the post-reboot / cold-start failure where every column runs
   the full proxy-managing `headroom wrap` and they race (or the proxy-management
   path misbehaves in the Electron spawn env) → `ConnectionRefused` → `exited (code 1)`.
1. **More Headroom toggles** — **1M context (`--1m`, wrap/claude-side)**,
   **persistent memory (`--memory`, proxy-side)**, **live learning (`--learn`)**.
2. **Output shaper toggle** — a *runtime* (hot, no-restart) toggle that enables
   Headroom's output-token shaper via its `/admin/runtime-env` admin channel.
3. **Per-column Headroom badge** — a small `HR ↗` indicator showing which
   columns are actually routed through Headroom.
4. **Terminal garble bug fix** — a data-sync bug where a column's xterm buffer
   is corrupted when Claude streams a response, currently worked around by
   manually resizing the window.

Items 0–3 extend the shipped `lib/headroom-wrap.js` feature. Item 4 is an
independent, investigation-led bug fix bundled into the same branch.

### Why item 0 comes first, and what it proved

Root cause confirmed by test: `headroom wrap claude --no-proxy -- --print "…"`
against an already-running proxy returns cleanly (exit 0). A plain
`headroom wrap claude` (which detects-or-starts the proxy) works from a normal
shell but fails when spawned by the app's pty-server — the app currently emits
`headroom wrap claude -- <args>` with **no `--no-proxy`** and **never starts a
proxy itself**, so every column runs the fragile proxy-management path. Moving
proxy ownership into the app removes all reliance on that path, fixes the cold-start
race, and is the prerequisite that makes the memory toggle's restart feasible.

## Background

### How the wrap flags work (verified against headroom 0.29.0)

`headroom wrap claude [WRAP-OPTIONS] -- [CLAUDE-ARGS]`. Wrap options sit **before**
the `--`; Claude args after it. Relevant options:

- `--1m` — Preserve the 1M context window. Behind a custom `ANTHROPIC_BASE_URL`
  (which Headroom sets), Claude Code drops the `context-1m` beta header and caps
  at 200k. `--1m` sets `ANTHROPIC_MODEL=<opus>[1m]` on the launched process so the
  1M window activates through the proxy (headroom issue #1158). **High value: the
  user runs a 1M Opus model, so today's wrap (no `--1m`) may silently cap at 200k.**
- `--memory` — Enable persistent cross-session memory. Decided at proxy
  **startup** — the proxy builds its `MemoryConfig` at boot, so enabling it
  requires a proxy restart. Proxy-wide (one shared proxy → affects all wrapped
  columns). Embeddings run on CPU ONNX in this build (no GPU path).
- `--learn` — Enable live traffic learning; patterns saved to `MEMORY.md`,
  improving compression over time. Low-risk.

### How the output shaper works

Not a wrap flag. `headroom learn --verbosity --apply` learns the user's preferred
output verbosity from session transcripts into `verbosity.json`, seeds the savings
baseline, and **hot-enables** the shaper by POSTing `{"HEADROOM_OUTPUT_SHAPER":"1"}`
to `http://127.0.0.1:<port>/admin/runtime-env` (the proxy's `runtime_env.set_overrides`
channel — *no restart*, same channel `wrap` uses). `verbosity.json` is inert until
the shaper env is enabled. It reduces **output** tokens (≈5× the price of input),
so it targets the expensive side. Proxy-wide, but live-togglable.

### The garble bug — confirmed root cause

Reproduced live with CDP inspection of the dev app:

- The garbled text is stored **in the xterm buffer** (`translateToString()` returns
  the corrupted characters, e.g. `"dpsign"` for "design", `"garbleddoutput wasdjust"`).
  A pure `terminal.refresh(0, rows-1)` (repaint, no resize) does **not** fix it —
  proving the corruption is in the buffer data, not the WebGL paint. (WebGL was an
  early hypothesis, disproven by this test.)
- The pattern is **interleaved text** — characters from different redraw passes
  landing in the same cells. This is the signature of Claude's cursor-positioned
  redraws (it runs a full-screen TUI on the alternate buffer) landing on the wrong
  cells because **xterm's column count did not match the pty's** during streaming.
- The corrupted region begins at a wide `🔊` emoji (a 4-byte / 2-cell character) —
  wide-char handling is exactly where a cols-desync or an xterm reflow tips into
  corruption.
- Manually resizing "fixes" it only because the OS resize → SIGWINCH → Claude
  repaints the whole screen with correct bytes over the corrupt buffer.

The transport itself is clean: `pty-server.js` reads the pty as decoded UTF-8
strings (`encoding: 'utf8'`) and JSON-wraps them; the renderer does
`col.terminal.write(msg.data)` with no transformation. So corruption is a **cols
desync between xterm and the pty**, in the `fitTerminal` → pty-resize path.

Two candidate mechanisms remain, to be disambiguated by an instrumented repro:

- **(A) Streaming under a transient mismatch** — a fit updates `xterm.cols`, but the
  pty `resize` message is debounced (100ms) / async, and Claude streams into the gap.
- **(B) xterm reflow corruption** — a cols change makes xterm rewrap scrollback and
  mangles lines around the wide emoji.

## Decisions

- **1M default ON**, memory/learn/output-shaper default OFF. (User runs a 1M model.)
- All four config keys are **global** (like `useHeadroom`), added to
  `preserveManagedSettings`.
- Wrap flags (`--1m`/`--memory`/`--learn`) apply to **new/respawned** columns only
  (they're baked at spawn), matching the existing `useHeadroom` behavior. Memory and
  the output shaper additionally have proxy-wide runtime effects.
- Bug: **instrument first, fix second.** Do not guess the mechanism; log
  `xterm.cols`/`rows` vs the pty size at each `data`/`resize` event, reproduce, pin
  A vs B, then fix and add a regression test.
- One branch, sequenced: **(0) app-owned proxy lifecycle first** (live blocker +
  prerequisite for memory-restart), then **`--1m` + badge + garble bug**, then
  **memory + output-shaper + learn**.
- The proxy is **persistent/detached** — its lifetime must not be tied to any single
  column or the spawning shell.

## Components

### 0. App-owned proxy lifecycle (`main.js` + `lib/` + `renderer.js`) — P0

**Confirmed requirement:** a `headroom wrap` process *owns* the proxy it starts —
when that process dies, the proxy dies (verified: closing the owning cmd wrapper
drops every routed session). So the app must start a **persistent, detached**
proxy that outlives individual columns and the spawning shell.

- **`main.js` — `ensureHeadroomProxy()`**:
  - GET `http://127.0.0.1:<port>/health` (short timeout). Healthy → resolve (reuse).
  - Else spawn **`headroom proxy [--memory] [--learn]`** *detached + unref'd* (NOT via
    `wrap`, so its lifetime isn't tied to a column), then poll `/health` until ready
    (~15–20s timeout). Include the proxy-side flags per config (`useHeadroomMemory`,
    `useHeadroomLearn`).
  - **Concurrency guard:** memoize the in-flight promise so N concurrent columns
    trigger **one** proxy start, not N (kills the cold-start race).
  - Returns `{ ok, started, error }`.
- **Column spawns use `--no-proxy`** (see component 1) so they only ever *reuse* the
  app-owned proxy — never run the fragile detect-or-start path.
- **Startup + pre-spawn:** call `ensureHeadroomProxy()` on app launch when
  `useHeadroom` is on, and (idempotently — fast when already healthy) before each
  wrapped spawn. Renderer awaits IPC `headroom:ensureProxy` before a wrapped spawn;
  on failure, surface an error (do not silently spawn a column that will `exit 1`).
- **Lifecycle on quit:** leave the proxy running (persistent, matches user
  expectation) OR track+stop on app quit — decide during implementation; persistent
  is the lower-friction default.
- **Testable core:** extract the decision/readiness logic to a `lib/` helper
  (e.g. `ensure-proxy.js`) with injected `probeHealth` / `startProxy` / `sleep` so the
  reuse/start/race-guard logic is unit-tested without real I/O. The detached spawn
  itself is thin glue in `main.js`, verified via the dev app.

**Interaction with memory/learn:** because the app now owns the proxy, `--memory`
and `--learn` move onto the **`headroom proxy`** start command (they are proxy-side),
not the per-column wrap. Enabling memory therefore = restart the app-owned proxy with
`--memory` — which is exactly the memory-restart affordance (component 4), now trivial
since the app controls the one proxy. `--1m` stays on the wrap (it's claude-side:
`ANTHROPIC_MODEL`). **Verify** which of memory/learn are `headroom proxy` flags vs
`wrap` flags during implementation (`--memory` confirmed on `headroom proxy`).

### 1. `lib/headroom-wrap.js` (extend, pure, unit-tested)

Extend the signature to carry the wrap-flag booleans:

```js
// applyHeadroomWrap({ enabled, cmd, args, hasEndpoint, oneM }) -> { cmd, args }
```

- Passthrough rules unchanged (falsy `enabled`, truthy `hasEndpoint`, or a truthy
  non-`claude` `cmd` → return original).
- When wrapping, always include **`--no-proxy`** (reuse the app-owned proxy), then the
  claude-side `--1m` when `oneM` is on, before `--`:
  `['wrap', 'claude', '--no-proxy', ...(oneM ? ['--1m'] : []), '--', ...args]`.
- `--memory` / `--learn` are **not** wrap flags here — they live on the app-owned
  `headroom proxy` start command (component 0). This keeps per-column wrap purely a
  *reuse* of the proxy plus the claude-side `--1m`.
- Fixed, deterministic order. Remains pure/deterministic, no I/O.

### 2. Global config (`renderer.js` + `main.js`)

- Add top-level booleans: `useHeadroom1m` (default `true`), `useHeadroomMemory`
  (`false`), `useHeadroomLearn` (`false`), `useHeadroomOutputShaper` (`false`).
- Add all four to `preserveManagedSettings` so `config:saveProjects` never clobbers
  them.
- Renderer reads/writes on toggle; persists via the existing save path.

### 3. Output shaper IPC (`main.js`)

- `headroom:setOutputShaper(on: boolean)`:
  - **on** → run `headroom learn --verbosity --apply` (learns verbosity + hot-enables
    via `/admin/runtime-env`). Best-effort; report success/failure to the renderer.
  - **off** → POST `{"HEADROOM_OUTPUT_SHAPER":"0"}` to
    `http://127.0.0.1:<port>/admin/runtime-env`.
- No proxy restart, no column interruption. Port resolved from the known default
  (8787) / `HEADROOM_PORT`.

### 4. Memory restart handling (`main.js` + `renderer.js`)

- `headroom:proxyHealth` → GET `http://127.0.0.1:<port>/health`, return the parsed
  `checks.memory` block.
- `headroom:restartProxy` → read the proxy PID from `/health` (or the wrap config
  endpoint) and kill it best-effort; return status.
- Renderer: when the user enables **Memory** and `proxyHealth` shows a running proxy
  with `memory.enabled === false`, show an actionable notice offering a one-click
  restart. The next wrapped spawn brings the proxy up with `--memory`. Columns already
  running keep the old proxy until they respawn.

### 5. HR badge (`renderer.js` + `index.html` + `styles.css`)

- Set a transient `col.headroomWrapped = true` when `applyHeadroomWrap` actually
  wraps (cmd became `headroom`); re-derive on respawn; **never persist** (mirrors the
  wrapped-args rule).
- Render an `HR ↗` pill next to the existing CLOUD/LOCAL conn tag in the column
  header, reusing conn-tag styling. Tooltip: "Routed through Headroom — open
  dashboard". Click → `shell.openExternal` the dashboard URL. Shown only when
  `headroomWrapped`.

### 6. Spawn integration (`renderer.js`)

- At the `applyHeadroomWrap` call sites (initial spawn + every respawn/fallback path
  that builds its own wire message), pass the four booleans derived from the live
  global config (never persisted into the column's stored `cmdArgs`/`cmd`).

### 7. UI (`index.html` + `renderer.js` + `styles.css`)

- Under the existing *Use Headroom* row in `#spawn-dropdown`, an indented sub-group:
  **1M context** (default on), **Memory**, **Learn**, **Output shaper**. Each with a
  `?` help. Disabled/greyed when Use Headroom is off or headroom isn't installed.
- Output shaper's checkbox calls `headroom:setOutputShaper` immediately on toggle
  (runtime); the wrap-flag checkboxes just persist config for the next spawn.
- Extend `updateSpawnButtonLabel` tags where useful (e.g. `1m`, `mem`).

### 8. Terminal cols-sync fix (`renderer.js` / `pty-server.js` / possibly `lib/`)

- **Instrument:** temporary logging of `xterm.cols`/`rows` and the last pty-resize
  cols/rows at each inbound `data` and each outbound `resize`, to pin mechanism A vs B.
- **Fix (shape TBD from instrumentation):** ensure cols propagation to the pty is
  reliable and that xterm does not process streamed writes under a size the pty
  hasn't acknowledged — e.g. flush the pending fit+resize synchronously before/at the
  moment cols change, or coalesce so `xterm.cols` and the pty width never diverge
  while data flows (the same invariant the drag-refit debouncer already protects).
- **Regression test:** if the fix distills to a pure decision (e.g. "should we hold
  writes while a resize is in flight?"), extract it to a `lib/` helper with unit
  tests, following the existing `lib/terminal-fit` / `WrapperRefit` convention.

## Data flow

```
spawn: addColumn -> applyHeadroomWrap({enabled: config.useHeadroom, oneM, memory,
        learn, cmd, args, hasEndpoint}) -> sendMsg{cmd,args}; set col.headroomWrapped
badge: col.headroomWrapped -> render HR pill (click -> openExternal dashboard)
memory toggle: set config.useHeadroomMemory -> saveConfig(preserved);
        if proxyHealth.memory.enabled===false -> offer headroom:restartProxy
shaper toggle: set config.useHeadroomOutputShaper -> headroom:setOutputShaper(on)
        (main: `headroom learn --verbosity --apply` / POST admin/runtime-env)
```

## Error handling

- `headroom learn` / admin POST failing → toast the failure; leave the config bool as
  the user set it but surface that it didn't take effect. No throw.
- `headroom:restartProxy` failing (no PID, port stays bound) → warn; instruct manual
  restart. Non-fatal.
- Local-endpoint spawn with any Headroom sub-toggle on → still unwrapped (endpoint
  wins, per the existing decision); sub-flags simply no-op.
- Bug fix must not regress the existing drag-refit / reattach paths.

## Testing

- `test/headroom-wrap.test.js` — extend the matrix: `--1m` only, `--memory` only,
  `--learn` only, all three (order `--1m --memory --learn` before `--`), none
  (identical to today), and passthrough cases (disabled / endpoint / arbitrary cmd)
  ignore the flags.
- Config persistence: the four keys survive a `config:saveProjects` round-trip
  (preserveManagedSettings).
- Output-shaper / restart / badge: driven via dev-app verification (relaunch after
  build). Pure helpers unit-tested where extracted.
- Bug: regression test at the `lib/` level if the fix distills to a pure helper.

## Out of scope (YAGNI)

- Per-project (non-global) Headroom overrides.
- Exposing the remaining wrap flags in the UI (`--no-tokensave`, `--no-mcp`,
  `--no-serena`, `--no-rtk`, `--code-graph`, `--no-proxy`, `--backend`, `--region`,
  `--port`, `--tool-search`, `--verbose`) — power users use the custom-args field.
- A GPU/CUDA embedding path for Headroom memory (requires upstream code changes;
  this build's ONNX sessions are CPU-pinned).
- Auto-starting `headroom proxy` independently of a wrapped spawn.
```
