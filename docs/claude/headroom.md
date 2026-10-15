# Headroom

Headroom is an app-managed local proxy that Claude columns route through for rate-limit headroom.
Code: `lib/headroom-env.js`, `lib/headroom-watchdog.js`, the `headroom:` handlers in `main.js`.
Design: `docs/superpowers/specs/2026-07-03-headroom-spawn-option-design.md` and
`2026-07-03-headroom-toggles-and-terminal-sync-design.md`.

## The binding

- `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`. Default port 8787, resolved from the live
  `headroom:serviceStatus` port (main honours `HEADROOM_PORT`).
- `ENABLE_TOOL_SEARCH=true`, **omitted when the column has MCP servers**. Headroom's
  `tool_search_deferral` optimiser swallows deferred `mcp__*` tools into a manifest the CLI's
  `tool_search_tool_regex` cannot load, so MCP-bearing columns keep tool schemas inlined.
  `buildHeadroomEnv` gates the flag on `hasMcp`, threaded from `resolveProjectMcpSpawn` and
  persisted on the column for respawns.
- Optional `ANTHROPIC_MODEL=<model>[1m]` to re-activate the 1M window (a custom base URL otherwise
  caps at 200k).

## Env alone is not enough, and the binding works both ways

- Claude Code's own settings files (`~/.claude/settings.json`, `<project>/.claude/settings*.json`)
  carry an `env` block that overrides inherited process env. An `ANTHROPIC_BASE_URL` pinned there
  silently defeated the Use Headroom toggle.
- Every plain Claude column therefore also gets the binding stamped into its spawn args as
  `--settings '{"env":{...}}'` (`applyBaseUrlSettingsArg`), which outranks those files.
- `--settings` is last-wins, not merged. The stamp merges into the last `--settings` in place.
  Appending a second one would discard, for example, ultracode's
  `--settings {"ultracode":true,...}` from `lib/effort-relaunch.js`.
- Only `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL` and `ENABLE_TOOL_SEARCH` are ever written into that
  block, and the allowlist is hard-coded on purpose: settings-env bypasses pty-server's
  renderer-env blocklist, so forwarding caller-supplied keys would reopen the `NODE_OPTIONS` RCE
  class.
- A `--settings <file>` that cannot be merged into makes the binding stand down to env-only, with
  a warning in the column.
- Turning Headroom **off** is explicit: `resolveBaseUrlBinding` returns `https://api.anthropic.com`,
  so a column cannot inherit a stale proxy URL.
- When the proxy cannot be started, `gatedWsSend` rewrites the spawn to that direct binding
  (restoring `--model`, which the Headroom path deliberately omits) instead of sending the column
  at a dead port.
- Endpoint-preset and arbitrary-`cmd` columns are untouched in both directions.
- Headless, scheduled and automation spawns are **not** covered by any of this and still inherit
  whatever `settings.json` says.

## The proxy process

- Spawned as `headroom proxy --port <p> --no-http2 [--memory] [--mode cache|token | --no-optimize]`.
- `--no-http2` is mandatory: shared-connection HTTP/2 corrupts TLS under the frequent stream
  cancels of multi-column use.
- Mode is start-time only: restart the proxy to change it. `cache` is the subscription-safe
  default.
- main probes the `headroom` binary at startup and can auto-start and auto-update it. A health
  watchdog auto-restarts a frozen ("up but silent") proxy that it owns and started.
- "API error · Retrying" in a column is a real upstream 429/5xx relayed through the proxy, not an
  app bug. Proxy logs: `~/.headroom/logs/proxy.log`.
- Codex columns never go through Headroom (see `codex-columns.md`).
