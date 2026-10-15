# MCP project inheritance

Projects (and automation agents) pick which MCP servers they inherit.
Code: `lib/mcp-project.js`, `lib/mcp-connectors.js`, the `mcp:` handlers.
Design: `docs/superpowers/specs/2026-07-09-project-mcp-inheritance-design.md` and
`2026-07-19-live-mcp-refresh-and-apply-design.md`.

## Selection

- `null` = inherit all, `[]` = none, an array = allowlist.
- A customised selection spawns with `--mcp-config <tmp>` (the selected definitions, so
  project-root-scoped servers still load in worktree or subdirectory cwds) plus
  `--strict-mcp-config`.
- A selection with no connector ticked spawns strict, with no `allowedMcpServers` setting.

## claude.ai account connectors

- Connectors (Granola, Wispr Flow and so on, shown as `claude.ai <Name>` in `claude mcp list`)
  live in no config file, and `--strict-mcp-config` drops all of them.
- When a selection ticks at least one connector, the spawn goes **non-strict** and merges
  `{"allowedMcpServers":[...]}` into the last `--settings`. `--settings` is last-wins, so merge,
  never append a second one. An unmergeable `--settings <file>` falls back to strict and loses
  the connectors.

## CLI matching rules (verified on CLI 2.1.296)

- Connectors match **only** by `{serverUrl}`, never by name.
- Once any `serverUrl` entry exists, remote file servers must also be listed by URL. Stdio servers
  match by `{serverName}`.
- On a name clash the `--mcp-config` (dynamic) server wins over a user-scope one.
- `https://host/*` wildcards match, including query strings. The CLI normalises before matching
  (host case, default port, bare host all match `https://host/*`).

## Secrets in URLs

- Remote entries are emitted as **host-level wildcards** (`urlOriginPattern`), never full URLs.
  Remote MCP URLs often embed secrets, and the allowlist travels through the renderer, argv and
  debug logs.
- Connector URLs never go to the renderer (names only).
- Accepted trade-off: ticking one remote server or connector also admits any unticked server on
  the same scheme, host and port (for example two Zapier or Composio URLs, or a plugin on the same
  host as a ticked server).

## Fails open

`allowedMcpServers` is documented as a managed-policy setting that happens to be honoured from
`--settings`. If a CLI update stops honouring it, the non-strict spawn loads every server.
Re-verify with `/mcp` in a column after CLI upgrades.

## Connector cache

- Connector names and URLs come from parsing `claude mcp list`, which is slow (it health-checks
  every server, about 40s). It runs in the background per subscription profile and is cached in
  `~/.claudes/mcp-connectors.json`, written only on a clean exit.
- Spawns use the union of every profile's cached URLs. A ticked connector missing from the cache
  triggers a background refresh.
