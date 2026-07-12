# Roadmap

Potential roadmap derived from a functional audit (2026-07-12) — feature/product perspective,
distinct from the engineering/security backlog in [`EVALUATION-TASKS.md`](EVALUATION-TASKS.md).
Items here are candidates, not commitments. See the README "Highlights" for the current feature
surface and `docs/superpowers/specs/` for what is already designed.

## Functional gaps (user-visible, broken or half-there)

- [ ] **"Terminal server is down" UX.** When pty-server dies the renderer retries every 2s forever
  with no surfaced state (`renderer.js:746`). Add a visible status state so a user whose columns
  all go dead knows why and whether it's recoverable. *(highest felt-reliability win)*
- [ ] **Missing-Claude-CLI guidance.** A missing `claude` binary — the one hard prerequisite —
  surfaces as `exit code 1`, indistinguishable from a crash. Detect and show install guidance.
- [ ] **Validate cwd on Respawn.** Respawn skips the `pathExists` pre-flight the restore path has
  (`renderer.js:~4093` vs `:3205`); respawn into a deleted worktree fails silently. Add the check
  and surface the error.
- [ ] **Voice scraper canary.** `lib/terminal-reply.js:26` returns `''` silently on any Claude Code
  TUI restyle, so voice goes mute with zero signal. Log/surface once when the parser finds zero
  blocks in a buffer that clearly has output.
- [ ] **macOS update integrity.** The custom updater downloads and opens the DMG unsigned and
  unverified (`main.js:4190-4333`). Sign + notarize, or at minimum verify a pinned sha256.

## Missed opportunities (adjacencies the architecture already enables)

- [ ] **Codex usage/cost in the shared surfaces.** Codex limits are already scraped from the rollout
  JSONL, but the Usage/Cost modal is Claude-only. Surface Codex rate-limit state in the same
  sidebar/usage surface — mostly plumbing.
- [ ] **Smarter session search.** Full-text search already reads every transcript on disk. Add
  semantic/recency ranking and "resume where I left off across all projects" to turn the grep box
  into a memory layer over data that's already indexed.
- [ ] **Broadcast comparison view.** Broadcast is fire-and-forget. Add a "diff the N replies" /
  pick-the-winner surface so running the same prompt across columns or models produces a comparison,
  not just parallel output.
- [ ] **Automation trends.** Run history logs cost, duration, and status per run but has no
  aggregate view. Add per-agent success-rate / spend-over-time rollups from data that already
  exists.
- [ ] **Lightweight cross-column handoff.** Manager mode coordinates via a Mongo DB. Add an in-app
  "column A finished → trigger column B" primitive that doesn't require standing up a database, to
  make multi-agent flows accessible without the Mongo overhead.
- [ ] **Endpoint fail-back / load-balance.** Failover swaps on disconnect but never fails back or
  balances across healthy local LLMs — a small extension of logic that already exists.

## Verified-strong (context, not roadmap)

The parallel-column model, workspaces, plan-limit / context-window awareness, the Headroom proxy,
voice live-scraping, and the pure-`lib/` testable-core discipline are foundationally solid. The
items above are edges and adjacencies, not structural holes.
