# Headroom toggles + terminal cols-sync fix — design

**Date:** 2026-07-03
**Status:** Draft (pending user review)
**Builds on:** [`2026-07-03-headroom-spawn-option-design.md`](2026-07-03-headroom-spawn-option-design.md)

## Summary

Three related pieces of work, shipped on one branch:

1. **More Headroom wrap toggles** — extend the existing "Use Headroom" spawn
   option with sub-toggles for **1M context (`--1m`)**, **persistent memory
   (`--memory`)**, and **live learning (`--learn`)**.
2. **Output shaper toggle** — a *runtime* (hot, no-restart) toggle that enables
   Headroom's output-token shaper via its `/admin/runtime-env` admin channel.
3. **Per-column Headroom badge** — a small `HR ↗` indicator showing which
   columns are actually routed through Headroom.
4. **Terminal garble bug fix** — a data-sync bug where a column's xterm buffer
   is corrupted when Claude streams a response, currently worked around by
   manually resizing the window.

The first three extend the shipped `lib/headroom-wrap.js` feature. The fourth is
an independent, investigation-led bug fix bundled into the same branch.

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
- One branch, sequenced: **bug fix + `--1m` + memory + badge first** (highest value),
  then **output-shaper + learn**.

## Components

### 1. `lib/headroom-wrap.js` (extend, pure, unit-tested)

Extend the signature to carry the wrap-flag booleans:

```js
// applyHeadroomWrap({ enabled, cmd, args, hasEndpoint, oneM, memory, learn }) -> { cmd, args }
```

- Passthrough rules unchanged (falsy `enabled`, truthy `hasEndpoint`, or a truthy
  non-`claude` `cmd` → return original).
- When wrapping, build the flag list deterministically in a fixed order and insert
  before `--`:
  `['wrap', 'claude', ...flags, '--', ...args]` where `flags` = the on-flags among
  `['--1m', '--memory', '--learn']` (that fixed order).
- Each flag is included only when its boolean is truthy. No flags on → identical to
  today (`['wrap','claude','--',...args]`).

Remains pure/deterministic, no I/O.

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
