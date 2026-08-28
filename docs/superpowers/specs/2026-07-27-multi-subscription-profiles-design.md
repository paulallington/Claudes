# Multi-subscription support (Claude profiles)

**Date:** 2026-07-27
**Status:** Design approved, ready for implementation planning

## Problem

Claudes assumes exactly one Claude Code subscription. `usage:getPlanLimits`
(`main.js:3600`) reads `~/.claude/.credentials.json` and polls
`api.anthropic.com/api/oauth/usage` once, globally. Every column, automation
and headless run spawns against that same account, and roughly twenty sites in
`main.js` plus `lib/sync.js` and `lib/voice-transcript-path.js` hardcode
`~/.claude` as the root for transcripts, history and settings.

The user holds multiple separate Anthropic accounts (separate emails, each with
its own subscription) and wants to assign specific projects and workspaces to
specific subscriptions, with the sidebar usage bar showing all of them.

## Mechanism

`CLAUDE_CONFIG_DIR` is the only supported way to run the Claude CLI against a
second account. Verified empirically on Windows 11 during design:

```
CLAUDE_CONFIG_DIR=<tmp> claude -p "say ok"
→ "Not logged in · Please run /login"
→ created: .claude.json, projects/D--Git-Repos-Claudes, sessions/, backups/
```

Three conclusions:

1. Credentials are genuinely per-directory — the CLI refused to reuse the
   primary login.
2. `.claude.json` (OAuth session, per-project trust, user/local MCP scopes)
   moves with the config dir.
3. The transcript path key scheme is **identical**, only re-rooted. So the
   transcript helpers need a root argument and nothing more.

**Still unverified on macOS — guarded, not tested.** No Mac with a second
Anthropic account was available during implementation, so the keychain
question below was never actually run; what shipped is the safe assumption,
not a finding.

Claude CLI stores credentials in the login keychain under service
`Claude Code-credentials` (`main.js`, `usage:getPlanLimits`). Whether that
service name is scoped per `CLAUDE_CONFIG_DIR` is unknown. Until someone runs
the experiment on a Mac with two accounts, the app assumes the worst case and:

- `profile:create` refuses unconditionally on `darwin` with an explanation,
  so no secondary profile can be created there at all.
- The Subscriptions panel disables "Add subscription" on `darwin` (detected
  via `document.documentElement.dataset.platform`, set by
  `platform-detect.js`) with the same message as a tooltip.
- `usage:getPlanLimits`'s existing `no-creds-macos` branch is preserved
  unchanged: a **secondary** profile with no `.credentials.json` on darwin
  returns an error rather than falling through to the keychain (which would
  read Primary's token and report it under the wrong profile's name — a wrong
  number that looks right).
- A `profiles.json` copied from Windows to a Mac still lists and allows
  assigning existing secondary profiles there (list/update/delete/setDefault
  are platform-agnostic); only *creation* of new ones is blocked.

**Outstanding experiment, still to be run on a Mac with two Anthropic
accounts:**

```
CLAUDE_CONFIG_DIR=<tmp1> claude  → /login account A
CLAUDE_CONFIG_DIR=<tmp2> claude  → /login account B
security find-generic-password -s "Claude Code-credentials" -a "$(whoami)" -w
```

Three possible findings, and what each implies for lifting the guard:

1. **The keychain entry is scoped per config dir** (e.g. account name/label
   includes the dir, or macOS Keychain Access shows two separate
   "Claude Code-credentials" items) — the guard can be lifted outright;
   `usage:getPlanLimits` would need a per-profile keychain read instead of
   the current Primary-only fallback.
2. **One shared entry, last login wins** — logging into account B silently
   invalidates account A's session. Secondary profiles would file-collide
   with Primary's keychain slot; the guard should stay, and the fix (if any)
   would need a distinct keychain service name per profile, not a bigger
   guard.
3. **The CLI errors or refuses a second concurrent login** — closer to the
   Linux/Windows file-based behaviour by accident; worth re-testing whether
   `.credentials.json` also appears under `$CLAUDE_CONFIG_DIR` on macOS (some
   CLI versions write both), in which case the guard could be relaxed to
   "keychain unScoped" only.

## Data model

Profiles live in their own file, `~/.claudes/profiles.json` (dev:
`profiles-dev.json`), for the same reason endpoints do (`main.js:559`): the
renderer round-trips `projects.json` wholesale on every project edit and would
clobber anything written outside its view.

```json
{
  "defaultProfileId": "primary",
  "profiles": [
    { "id": "primary",    "name": "Primary",  "configDir": null, "colour": "#d97757" },
    { "id": "pf_l2k9_a7", "name": "Personal",
      "configDir": "C:\\Users\\devel\\.claudes\\profiles\\pf_l2k9_a7",
      "colour": "#5b8def" }
  ]
}
```

- `configDir: null` is the sentinel for "use `~/.claude`, set no env var".
- Primary always exists and cannot be deleted; its name and colour are editable.
- Secondary config dirs are **always allocated by the app** under
  `~/.claudes/profiles/<id>/`. A user-supplied path is never accepted.

### Assignment levels

Most specific wins:

| Level | Field | Location | Default |
|---|---|---|---|
| Column | `profileId` | `sessions.json` session entry | inherit |
| Automation | `profileId` | `automations.json` entry | inherit from project |
| Workspace | `profileId` | `projects.json` `workspaces[]` entry | inherit from project |
| Project | `profileId` | `projects.json` project entry | global default |
| Global | `defaultProfileId` | `profiles.json` | `primary` |

Manager-mode workers inherit their manager's resolved profile. They must never
fall back to Primary independently, or a single manager run burns two
subscriptions at once.

### Resolution

`lib/profile-resolve.js` — pure, UMD, npm-tested — is the single decision point:

```js
resolveProfile({
  profiles, defaultProfileId,
  columnProfileId, workspaceProfileId, projectProfileId
})
// → { id, name, configDir, isPrimary, colour, env }
//   env = {} for Primary, { CLAUDE_CONFIG_DIR: configDir } otherwise
```

Every site that currently hardcodes `~/.claude` derives its root from this
instead of deciding for itself.

### Security invariant

A `profileId` read from `sessions.json`, `projects.json` or `automations.json`
is an **untrusted key, never a path**. It is looked up in the registry; an
unknown id resolves to Primary with a console warning. This carries forward the
principle established in commit `4abadb2` (sessions.json must never be able to
name a program) — here, no file outside `profiles.json` can name a directory.

`assertInsideAllowedRoots` (`main.js:433`) needs no change: profile dirs live
under `~/.claudes/profiles/`, already inside `CONFIG_DIR`. This holds *only*
because the app allocates the dirs.

## Spawn

`CLAUDE_CONFIG_DIR` merges into the existing env block alongside the Headroom
and endpoint variables. It passes `sanitiseEnv` (`pty-server.js:147`)
untouched — not on `ENV_BLOCKLIST`, not `LD_*`/`DYLD_*` — so pty-server
requires no change.

Orthogonality:

- **Headroom** binds `ANTHROPIC_BASE_URL`; profiles bind credentials. The proxy
  relays whatever bearer the CLI sends, so a profiled column can route through
  Headroom normally.
- **Endpoints** (`endpoint:getEnv`) set `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`
  and therefore bypass subscription auth entirely. A column with an endpoint
  preset ignores its profile for auth purposes but still uses the profile's
  config dir for transcripts.
- **Codex columns** ignore profiles entirely.

## Re-rooting the ~20 hardcoded sites

Four categories, four rules.

### 1. Per-session paths — use the owning column's profile root

`main.js:1817`, `1850`, `1863`, `1901` (session detection), `3771`, `3891`
(ctx meter / last turn), `lib/sync.js:93`, `lib/voice-transcript-path.js:20,35`.

The path key scheme is unchanged, so these take a `root` argument. The two
`lib/` modules already accept `homeDir`; it becomes `claudeRoot` and existing
tests extend rather than rewrite.

**Voice is the sharp edge.** `docs/voice.md` assumes a single root. A column on
a secondary profile whose transcript is looked up under Primary's root finds
nothing and fails *silently* — the column simply stops speaking. Add explicit
profile-aware tests for the wrong-root case in `voice-transcript-path` and
`session-target`.

### 2. Global aggregates — union across all profiles

`usage:getAll` (`main.js:3934`), `usage:getCosts` (`4081`), `history.jsonl`
(`4167`). These scan every profile's directory and merge, with profile
attribution surfaced in the Usage modal. The mtime+size cache stays valid; cache
keys gain the profile id.

### 3. App-managed config — Primary authoritative, mirrored on write

`settings.json` (`main.js:4527`, `4701`, `4809`), global `CLAUDE.md` (`5808`,
`5822`), the hooks and agents scanners (`2202`, `2220`, `2273`).

Reads always hit Primary. Writes hit Primary, then fan out to every secondary
profile via `atomicWriteJson`. A mirror failure surfaces as a toast — it must
never fail silently, or the result is "why isn't my hook running" bugs.

Consequence to accept: hand-edits made directly to a secondary profile's
`settings.json` outside the app are overwritten on the next mirror. Profiles are
clones that differ only in credentials and transcripts.

### 4. Credentials — per profile

`main.js:3619` reads `<configDir>/.credentials.json`, with the macOS keychain
fallback retained for Primary.

## Profile lifecycle

**Create** does three things:

1. `mkdir` the allocated directory.
2. Copy `settings.json`, `CLAUDE.md`, `agents/` and the plugins config from
   `~/.claude`.
3. Copy **only the per-project trust map** out of `~/.claude.json` — never the
   OAuth block, which is the credential and must come from a real login.

Step 3 is not optional: without it the first column on a new profile stops on
"do you trust this folder?", which is exactly the broken-feeling behaviour this
design exists to avoid.

The app then states plainly: *"Profile created. Run `/login` in a column on this
profile to sign in."* No attempt is made to automate the OAuth flow.

**Re-seed from Primary** is a button in the profile editor, for catching a
drifted profile up.

**Delete** removes the directory. Any project, workspace, column or automation
pointing at it falls back to Primary, with a warning listing what was
reassigned.

## Usage bar

### Polling

`usage:getPlanLimits` gains a `profileId` argument. The 30s cache
(`planUsageCache`) and the 429 cooldown (`planUsageRetryAtMs`) become
**per-profile maps** rather than module-level scalars — one account being
rate-limited must not blank another's bars. Polls are staggered a few hundred
milliseconds apart so N profiles do not burst simultaneously.

### Rendering

`renderPlanLimitsMini` loops over profiles instead of rendering once:

```
CODEX              Week    ▍               1%
CLAUDE · Primary   Session ████           13%
                   Week    ██████████     86%
CLAUDE · Personal  Session ██              4%
                   Week    ███            31%
```

All configured profiles are shown, always — the point of the feature is seeing
at a glance which subscription has headroom before deciding where to spawn.
Each profile carries a colour chip matching the one on its columns.

A profile whose OAuth token has gone stale (401) shows **"Sign in"** in place of
percentages, not an error. That is the honest state for an account that simply
has not been used lately.

### Notifications

Threshold crossing state is keyed by profile id, and notifications name the
account ("Personal: weekly limit at 90%"). The automation-pause prompt at 90%
offers to pause only the automations running on that profile.

`updateColumnDeltaPills` uses each column's own profile data.

## UI surfaces

1. **Global settings → Subscriptions panel** — list, add, rename, recolour,
   delete, set default, re-seed from Primary, per-profile sign-in status.
   Modelled on the existing endpoints manager.
2. **Project settings** — profile dropdown, default "Global default".
3. **Workspace row** — profile dropdown, default "Inherit from project".
4. **Spawn options** — profile picker beside the existing endpoint and model
   pickers, default "Inherit".
5. **Automation editor** — profile picker, default "Inherit from project".

Plus a small profile chip in the column header, shown **only when the column is
not on Primary**, so today's UI is visually unchanged for single-subscription
users.

Terminology follows the existing conventions: Spawn / Kill / Respawn; the
terminal background stays `#1a1a2e`.

## Migration

A genuine no-op. No existing config carries a `profileId`; everything resolves
to Primary, which sets no environment variable. Until a second profile is
created the feature is invisible and every code path behaves exactly as it does
today. This is the mechanical form of the "must not act funky" requirement.

## Testing

New pure-lib tests:

- `profile-resolve` — the cascade, unknown-id fallback to Primary, env shape for
  Primary vs secondary, manager-worker inheritance.
- profile-aware transcript paths — including the wrong-root silent-failure case.
- settings mirror — fan-out, partial-failure reporting.
- usage aggregation — merging digests across profiles, cache keying.

**A green suite is not sufficient here.** Per the repo's own rule, the
acceptance check is the running app:

- [ ] Two profiles configured; secondary signed in via `/login`.
- [ ] A column spawned on each; both usage blocks live in the sidebar.
- [ ] Voice speaks on a secondary-profile column.
- [ ] Session restore reattaches a secondary-profile column to the right
      transcript.
- [ ] An automation fires on its assigned profile.
- [ ] A hook enabled in the app fires on a secondary-profile column.
- [ ] macOS: verified keychain behaviour, or secondary profiles cleanly disabled.

Only the user can complete the second `/login`, so this checklist is handed over
rather than driven by the implementer.

## Review routing

This trips two Danger Triggers — credentials handling, and persistent state
across four config files (`profiles.json`, `projects.json`, `sessions.json`,
`automations.json`). The profile-resolution core and the credential-reading path
go through a lineage-diverse review before merge.

## Files touched

- New: `lib/profile-resolve.js`, `test/profile-resolve.test.js`
- Modify: `main.js` (profile IPC family, ~20 re-rooted sites, per-profile usage
  polling, settings mirror), `preload.js`, `renderer.js` (five UI surfaces,
  mini-bar loop), `index.html`, `styles.css`
- Modify: `lib/sync.js`, `lib/voice-transcript-path.js`, `lib/session-target.js`
- Update: `CLAUDE.md`, `docs/voice.md`, `EVALUATION-TASKS.md`
