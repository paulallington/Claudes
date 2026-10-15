# Codex columns

A Codex column runs the normal Codex TUI while Electron main owns a loopback `codex app-server`
used for native thread state.
Code: `lib/codex-app-server.js`, `lib/codex-thread-state.js`, `lib/codex-spawn-ticket.js`,
`lib/codex-spawn.js`, `lib/codex-limits.js`, the `codex:` handlers and the spawn path.
Design: `docs/superpowers/specs/2026-07-12-spawn-codex-design.md` and
`2026-07-12-codex-approval-preset-design.md`.

## Fresh columns

- A fresh managed column attaches as `codex -C <project> --remote ...` and lets the TUI create its
  thread. `-C` is required: a remote app-server otherwise creates the thread under the wrapper's
  cwd, and the cwd-bound claim cannot safely adopt it.
- On Windows the managed TUI runs through the installed Codex Node entrypoint, not `cmd.exe`, so
  shell-active characters that are legal in a project path stay literal.
- Do not pre-create an empty app-server thread and launch `codex resume`: no rollout exists yet.
- A matching fresh `thread/started` must be claimed directly. Do not call `thread/resume` for that
  already-live thread: its rollout does not exist yet, and a transient `no rollout found` response
  must never disable the whole bridge.
- Main registers a short-lived cwd-bound claim, serialises fresh launches for the same normalised
  cwd, adopts the UUID from the broadcast `thread/started` event, and persists it as resume intent.
- Claim timeout or bridge loss is pushed to the renderer and must leave the loading state with an
  explicit retryable warning.

## Resumed columns

- Persisted threads verify that `thread/read` belongs to the expected cwd before attaching with
  `resume`.
- A stale empty UUID that reports `thread not loaded` or `no rollout found` becomes a fresh
  claimed attach.

## Header data and fallback

- Token usage, context-window size, thread status, settings, compaction events and the live
  model/effort/service-tier catalogue stream into the session header.
- If app-server is unavailable, the static model catalogue and an ordinary direct CLI spawn are
  the fallback. Direct fallback is visibly degraded and clears stale managed-thread state.
- Approval presets map to Codex flags (`-a` approval, `-s` sandbox, plus a bypass flag).
- Account rate-limit usage is scraped from `rate_limits` in the `~/.codex/sessions` rollout JSONL.

## Headroom

Codex always runs direct, never through Headroom. ChatGPT-subscription Codex ignores
`OPENAI_BASE_URL`, so Headroom is Claude-only.

## Security

- The app-server WebSocket is bound to 127.0.0.1 and bearer-authenticated.
- The raw bearer stays in main. Each PTY receives it over its private stdin control channel, only
  after consuming a short-lived, single-use spawn ticket bound to either the fresh claim or the
  exact resumed thread UUID, plus the normalised cwd and bridge endpoint.
- Never expose or persist the bearer or the fresh claim in renderer, preload or session state.
