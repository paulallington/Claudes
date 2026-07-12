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

---

# Codex deep audit (GPT-5.6 Sol, max effort, 2026-07-12 against v1.9.49)

Independent read-only pass over first-party JS (`main.js`, `pty-server.js`, `preload.js`,
`lib/*.js`, high-risk `renderer.js` paths). Verdict: **BLOCKED**. Threat model for the security
items is a **compromised/malicious renderer** (XSS/RCE past the sandbox+CSP) — these are the
escalation paths if the first line fails, i.e. defense-in-depth, not drive-by RCE. Findings that
overlapped the tracked backlog above were excluded. The two Criticals were code-verified by Claude;
spot-check the rest against current line numbers before fixing (main.js/renderer.js drift).

## Codex — Critical

- [ ] **Renderer can self-authorize arbitrary FS roots.** `listAllowedRoots()` trusts every
  persisted `projects[].path`, and `config:saveProjects` accepts the renderer's whole project array
  without proving new paths came from the native picker — add `/` or `C:\`, let it persist, then
  fs/git IPC spans the account. *(Claude-verified: `main.js:407` pushes `p.path` unconditionally.)*
  `main.js:407`, `main.js:1295`, `preload.js:5`. **Fix:** main-owned root authorization; accept new
  roots only via a dedicated native-dialog flow; ignore renderer attempts to add path capabilities.
- [ ] **Automation updates reintroduce arbitrary recursive dir deletion.** `updateAgent`'s
  `safeFields` includes `isolation` (so the renderer sets `clonePath`), which `removeAgent` later
  passes to `rmSync`; manager updates reach `deleteAllForProject` the same way. `addAgent` does
  `Object.assign({id: generateAgentId(), …}, agentConfig)` so `agentConfig.id` **overrides** the
  generated id → `../` traversal in run-history deletion. *(Claude-verified at `main.js:5849,5865`.)*
  `main.js:5837,5849,5865,5896,5944`. **Fix:** generate IDs only in main; never accept `clonePath`
  from the renderer; realpath-check every recursive delete against the clone base immediately before.

## Codex — High

- [ ] **Endpoint secrets leave main, then get stored/logged in plaintext.** `endpoint:get` /
  `endpoint:getEnv` return decrypted creds to the renderer; saved layouts capture the resulting env
  into `projects.json`; endpoint save logs the plaintext form. `main.js:1471,1581,2048`,
  `renderer.js:1166,11890`. **Fix:** keep tokens main-owned, spawn/edit by opaque endpoint ID,
  persist only ID/model in layouts, keep a blank token on edit, drop credential logging.
- [ ] **`git:diff` arbitrary-file-read fallback.** When Git rejects `../../.ssh/id_rsa`, the catch
  path reads `path.join(projectPath, filePath)` uncontained and returns it as an "untracked diff."
  `main.js:2778`. **Fix:** realpath-check the fallback strictly beneath the validated repo root.
- [ ] **Env blocklist is case-sensitive on Windows.** Windows env names are case-insensitive but the
  filter rejects only exact spellings (`NODE_OPTIONS`, `PATH`, `LD_`/`DYLD_`), so `node_options`
  slips through to the spawned CLI. `pty-server.js:139,147,415`. **Fix:** uppercase-canonicalize keys
  before filtering; merge/dedupe env case-insensitively on win32.
- [ ] **`will-navigate` permits any local `file:` URL.** Blocks non-file schemes but allows nav to
  arbitrary local HTML, which keeps the preload bridge but loses the app CSP. `main.js:1014`.
  **Fix:** block all post-load navigation, or exact-match the packaged `index.html` URL + allowed query.
- [ ] **External-editor feature → command execution.** Renderer can set the editor command to e.g.
  `/bin/sh` and invoke it with a renderer-writable project file as arg1; Windows uses `shell:true`.
  `main.js:4917,4947,4984`. **Fix:** store only a main-validated editor exe from a trusted flow,
  reject shells/interpreters, never `shell:true`.
- [ ] **Sync settings = arbitrary transcript exfiltration.** `sync:setSettings` accepts any
  `sourcePath` (incl. UNC/network share); `sync:setProjectExport` copies project JSONLs there without
  tying to a picker selection. `main.js:1374,1398`, `lib/sync.js:143`. **Fix:** main-owned sync-root
  selection, reject UNC/network unless confirmed, accept only the persisted trusted root later.
- [ ] **Several FS/process IPC paths bypass `assertInsideAllowedRoots`.** Sticky-note load/save uses
  `projectPath` directly; `launch:getConfigs` reads under any supplied dir; headless handlers accept
  any existing dir as spawn/write location. `main.js:1939,1980,3280,6676,7194`. **Fix:** validate
  every supplied project path against an exact configured project capability before deriving children.
- [ ] **Debounced vs immediate config writers clobber each other.** Project saves hold a stale
  whole-config snapshot 400ms while sync/editor/update setters read-modify-write the file
  independently; a later flush erases the new setting (or a crash keeps stale projects).
  `main.js:479,494,1319,1374,4984`. **Fix:** serialize all config mutations through one main update
  queue that merges against latest pending state before a single atomic write.

## Codex — Medium

- [ ] **Snippet persistence non-atomic, no recovery.** A crash during `writeFileSync` truncates the
  snippet library; the reader treats it as empty and the next save cements the loss.
  `main.js:691,6709`. **Fix:** `atomicWriteJson` + `readJsonWithRecovery`.
- [ ] **Manager config silently dropped on automation create.** Renderer submits `managerConfig` but
  `automations:create` builds the object without a `manager` field; manager mode survives only later
  edits. `renderer.js:16883,16936`, `main.js:5822`. **Fix:** validate + persist a sanitized manager
  config at creation.
- [ ] **Concurrency/interactive-serialization races across isolated agents.** Slots are checked
  before `await preRunPull` but reserved only after pull+spawn, so concurrent runs all see spare
  capacity / a clear lock. `main.js:7672,7681,7705,7865,7923`. **Fix:** atomically reserve global +
  interactive slots before any async prep; release on every failure path.
- [ ] **Tail IPC can create unbounded 150ms intervals.** Each unique renderer `columnId` starts an
  interval with no per-sender/global cap and no cleanup when its `webContents` dies.
  `main.js:3791,3818`, `preload.js:248`. **Fix:** validate IDs, cap tails per-sender + globally, stop
  sender-owned tails on `destroyed`.

## Codex — Low

- [ ] **Interruption detection wrongly gated on prior input.** Outer condition includes
  `col.hasUserInput`, so the resumed-session-before-keystroke correction the comment promises never
  runs. `renderer.js:646`. **Fix:** move interruption detection outside the `hasUserInput` gate.
