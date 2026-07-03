# Headroom spawn option — design

**Date:** 2026-07-03
**Status:** Approved (pending spec review)

## Summary

Add a **"Use Headroom"** toggle to the spawn-options dropdown. When on, Claude
columns launch through Headroom's per-launch wrapper
(`headroom wrap claude -- <claude args>`), which starts Headroom's optimization
proxy, sets `ANTHROPIC_BASE_URL`, and launches Claude with terminal passthrough.
The setting is a single **global** toggle (on across all projects until turned
off). If the `headroom` binary is not installed, the toggle is disabled and the
UI reads **"Headroom Required"** with a link to the project's GitHub page. When
installed, a **"Dashboard ↗"** link opens `http://127.0.0.1:8787/dashboard`.

## Background — how Headroom wraps

`headroom wrap claude [CLAUDE_ARGS]...` (verified against headroom 0.29.0):

> Starts a Headroom proxy, configures the environment, and launches the target
> tool so all API calls route through Headroom automatically.
> Sets `ANTHROPIC_BASE_URL` to route all Anthropic API calls through Headroom.
> All unknown flags are passed through to claude (e.g. `--resume`, `--model`).

So it is a genuine per-launch subprocess wrapper (not a persistent config edit),
which fits this app's `cmd`/`args` spawn model. `--` cleanly separates our Claude
flags from Headroom's own options (`-p/--port`, `--memory`, `--1m`, …).

The dashboard is served by the proxy on its port (default 8787) at
`/dashboard`, reachable once a wrapped column (or a standalone `headroom proxy`)
is running.

## Decisions

- **Endpoint conflict:** Headroom and local endpoint presets both own
  `ANTHROPIC_BASE_URL`, so they are mutually exclusive. **Headroom wrapping is
  skipped for any spawn that carries a local endpoint** (endpoint wins). No UI
  block — the toggle stays available; it simply no-ops on local-endpoint spawns.
- **Persistence:** plain **global** toggle. `config.useHeadroom` starts `false`;
  ticking it keeps it on for every project/spawn until unticked. No
  auto-enable-on-first-use.

## Components

### 1. `lib/headroom-wrap.js` (new, pure, unit-tested)

Single responsibility: transform a spawn command into its Headroom-wrapped form.

```js
// applyHeadroomWrap({ enabled, cmd, args, hasEndpoint }) -> { cmd, args }
```

Rules:
- Passthrough unchanged (return original `cmd`/`args`) when **any** of:
  - `enabled` is falsy,
  - `hasEndpoint` is truthy (local endpoint active — skip per decision above),
  - `cmd` is a truthy non-`claude` value (an arbitrary-command column — never
    wrap those; only wrap the default Claude spawn where `cmd` is falsy).
- Otherwise return `{ cmd: 'headroom', args: ['wrap', 'claude', '--', ...args] }`.

Pure and deterministic — no I/O. Mirrors the `lib/permission-mode.js` /
`lib/spawn-session.js` convention (npm-tested).

### 2. Detection (`main.js`)

- At startup, probe once: `execFile('headroom', ['--version'])`. PATH is already
  normalized early in `main.js`, so `~/.local/bin/headroom` resolves.
- Cache `{ installed: boolean, version: string|null }`.
- Expose via IPC handler `headroom:status` → the cached object.
- Add a `shell.openExternal` passthrough for the dashboard URL if one is not
  already available (reuse the existing external-open IPC if present).

### 3. Global config

- `config.useHeadroom` (top-level boolean). Added to `preserveManagedSettings`
  so `config:saveProjects` never clobbers it.
- Renderer reads/writes it on toggle and persists via the existing save path.

### 4. Spawn integration (`renderer.js`)

- Apply `HeadroomWrap.applyHeadroomWrap` at the `sendMsg` construction point in
  `addColumn`, using `enabled = config.useHeadroom`, `hasEndpoint =
  !!(opts.endpointId || opts.env)`, and the column's `cmd`/`claudeArgs`.
- Re-apply on the auto-respawn / endpoint-fallback respawn paths that build their
  own wire message (so a wrapped column stays wrapped after respawn), deriving
  `enabled` from the live global flag — **never** persist the wrapped form into
  the column's stored `cmdArgs`/`cmd` (keeps popout/restore/resume/saved-layout
  operating on original args, exactly like the `--session-id` handling).

### 5. UI (`index.html` + `renderer.js` + `styles.css`)

- New `spawn-option` row at the top of `#spawn-dropdown`:
  - `<input type="checkbox" id="opt-use-headroom">` labelled **Use Headroom**
    with a help `?` describing the proxy/routing behavior.
  - A right-aligned **Dashboard ↗** link (opens the dashboard URL externally).
- On `headroom:status`:
  - **installed** → checkbox enabled, reflects `config.useHeadroom`; Dashboard
    link visible.
  - **not installed** → checkbox disabled; the row's label/help swaps to
    **"Headroom Required"** with a link to
    `https://github.com/headroomlabs-ai/headroom`; Dashboard link hidden.
- Add a `headroom` tag to `updateSpawnButtonLabel` when the toggle is active
  (consistent with `bare` / `no-mcp` / `worktree` / `custom`).

## Data flow

```
startup: main.js execFile('headroom --version') -> cache {installed,version}
renderer boot: ipc 'headroom:status' -> render checkbox state + dashboard link
toggle: set config.useHeadroom -> saveConfig (preserved) -> updateSpawnButtonLabel
spawn: addColumn -> applyHeadroomWrap({enabled: config.useHeadroom,
        cmd, args, hasEndpoint}) -> sendMsg{cmd,args} -> pty-server
respawn: same transform re-derived from live flag; stored cmdArgs unchanged
```

## Error handling

- `headroom --version` failing / binary absent → `{ installed:false }`; UI shows
  "Headroom Required". No throw; spawns proceed normally unwrapped.
- Dashboard link is best-effort: it opens the URL even if the proxy isn't up yet
  (browser shows connection-refused until a wrapped column starts) — acceptable;
  no pre-flight check.
- Local-endpoint spawn with the toggle on → silently unwrapped (by design).

## Testing

- `test/headroom-wrap.test.js` — pure `applyHeadroomWrap` matrix:
  - enabled + default claude spawn → wrapped (`headroom wrap claude -- …`),
    original args preserved and appended after `--`.
  - enabled + `hasEndpoint` → passthrough.
  - enabled + arbitrary `cmd` → passthrough.
  - disabled → passthrough.
  - empty args → `['wrap','claude','--']`.
- Detection and UI wiring verified by running the dev app (`npm start`)
  alongside the production app.

## Out of scope (YAGNI)

- Per-project Headroom overrides.
- Exposing Headroom's own flags (`--memory`, `--learn`, `--1m`) in the UI — a
  user who wants those can add them via the existing custom-args field as Claude
  args, or we add them later.
- Auto-starting `headroom proxy` independently of a wrapped spawn.
