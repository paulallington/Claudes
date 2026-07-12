# Evaluation Tasks

Backlog derived from the full read-only application evaluation (Fable, 2026-07-12) against v1.9.46.
Grouped by severity. Check items off as they land. See the evaluation for verified-strong areas
not listed here (pty-server token auth, Electron sandbox/CSP, path containment, atomic writes).

## High

- [x] **Wire tests into the release pipeline.** Add `npm test` as a required job in
  `.github/workflows/release.yml` and run it in `release.sh` before tagging. *(fix first)*
- [x] **Harden `release.sh`.** Refuse dirty trees instead of blind `git add -A`; push the branch
  before tagging (or delete the tag on failure) so a failed build never leaves an orphan tag.
- [x] **Verify the macOS update chain (sha256 path).** `build-macos` now writes a `<dmg>.sha256`
  sidecar per DMG and ships it as a release artifact, and the darwin updater fetches + verifies it
  (`lib/update-checksum.js`) before setting `downloadedDmgPath`; a mismatch deletes the file and
  surfaces `update:error`, and releases without a sidecar still update (backward-compatible warning).
  Signing/notarization intentionally deferred (out of scope per maintainer) — the "at minimum verify
  a sha256" bar is met, but this is corruption/single-asset-tamper protection over the same TLS path,
  not a substitute for signing against a full release compromise.
- [x] **WS reconnect backoff + status.** Reconnect now backs off exponentially (`lib/reconnect-backoff.js`:
  1s→30s cap + jitter) instead of a fixed 2s, and after ~4 failed attempts surfaces a persistent
  "Terminal server is down — reconnecting…" toast with a Retry action that clears on reconnect
  (`renderer.js` ws.onclose). Live-port re-fetch + column reattach preserved.
- [ ] **Begin decomposing the monolith.** `renderer.js` (~19.9k lines) and `main.js` (~8.6k lines)
  have 0% direct test coverage. Plan a staged extraction of subsystems into testable modules
  (continue the lib/ pattern). Large effort — plan separately.

## Medium

- [ ] **Re-triage deferred security items** (open ~2 months): SSRF in `endpoint:fetchModels`
  (`main.js:1584`), plaintext `dbConnectionString` in automations.json (`main.js:5782`), pty
  `cmd`/`cwd` allow-list, per-connection `reattach` ownership, `hooks:configure` consent prompt.
- [ ] **Atomic write for endpoint presets.** `writeEndpoints` uses plain `writeFileSync`
  (`main.js:579-582`) — a crash mid-write loses all presets incl. encrypted tokens. Route through
  `atomicWriteJson`.
- [ ] **Fix READY-port race in `startPtyServer`.** Resolve only on `READY:<port>` (not the 5s
  timeout with stale `ptyActualPort`); buffer stdout line-wise (`main.js:982-987`, `:357`).
- [ ] **Validate cwd on Respawn.** Respawn path (`renderer.js:~4093`) skips the `pathExists` check
  the restore path has (`:3205`) — respawn into a deleted dir fails silently. Add the pre-flight.
- [ ] **Catch config-load / headless-panel IPC rejections.** Add `.catch` on `getProjects`
  (`renderer.js:~1792`), `getStartWithOS` (`:1016`), and headless list/get/run/delete chains
  (`:241-466`) so an IPC failure surfaces instead of silently corrupting the UI.
- [ ] **Voice scraper canary.** `lib/terminal-reply.js:26-31` returns `''` silently on any Claude
  Code TUI restyle. Log once when the parser finds zero blocks in a buffer that clearly has output.
- [ ] **Missing-Claude-CLI guidance.** A missing `claude` binary surfaces as `exit code 1`,
  indistinguishable from a crash. Detect and show install guidance.
- [ ] **Restore the e2e suite.** `e2e/merge-surface.spec.ts` references Playwright, which isn't a
  dependency, and no CI job runs it. Add the dep + a CI job, or remove the dead suite.
- [ ] **Test `lib/sync.js`.** The one lib module (315 lines of file mirroring) with no test file.

## Low

- [ ] **Delete duplicate `applyLayoutRatios`.** Defined twice, byte-identical
  (`renderer.js:1648` and `:1717`) — remove one before they diverge.
- [ ] **Reject duplicate pty `create` ids.** `pty-server.js:451` overwrites `ptys.set(id, p)`,
  leaking the old process until quit. Reject an already-existing id.
- [ ] **Tighten `assertInsideAllowedRoots` symlink edge.** Non-existent leaf falls back to a lexical
  containment check (`main.js:434-435`); a symlinked pre-existing parent could escape the roots.
- [ ] **fsync the `.bak` copy + directory** after rename in `lib/config-io.js` (`:10`, `:18`) to
  close the power-loss window on the app's config file.
- [ ] **De-dupe path-key logic** between `lib/voice-transcript-path.js:15` and `lib/sync.js:89`.
- [ ] **Repo cruft.** Remove/relocate `claudes.vbs`, `stats.js`, `screenshot.png`, `banner.png`;
  reconcile the two `before-quit` handlers (`main.js:2493`, `:8535`).
- [ ] **preload listener leaks.** `ipcRenderer.on` wrappers offer no unsubscribe; popout
  re-registration can accumulate listeners.
- [ ] **Document the system-Node requirement** for end users — the app is broken without Node and
  only says so at first terminal spawn.
