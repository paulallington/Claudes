# Multi-subscription profiles

A column, project, workspace or automation can run under a secondary Claude account instead of
Primary, so one machine can spread work across several subscriptions' rate limits.
Code: `lib/profile-resolve.js`, the `profile:` handlers.
Design: `docs/superpowers/specs/2026-07-27-multi-subscription-profiles-design.md`.

## How a profile works

- A profile is a directory (`~/.claudes/profiles/pf_*`, allocated by the app, never supplied by
  the renderer) set as `CLAUDE_CONFIG_DIR`.
- Primary sets **no** env var at all, so single-subscription users see no change.
- `profile:resolve` in main is the single resolution entry point. It runs the
  column -> workspace -> project -> global-default cascade (`resolveProfile` in
  `lib/profile-resolve.js`) and returns `{ id, name, colour, isPrimary, env }`. The renderer never
  runs the cascade itself, only caches the result.
- `lib/profile-resolve.js` guards its own `require('path')` (`typeof require === 'function'`) so
  the same file loads in the sandboxed renderer via `window.ProfileResolve`, where `path` does not
  exist. `profileClaudeRoot` throws if called there (only main calls it). A `node:vm` test pins
  this contract (`test/profile-resolve.test.js`).
- Background session ids (`backgroundSessionIds` in main) are a `Map<id, profileId>`, not a plain
  set, because usage polling needs to know which subscription a headless run was under. Primary
  is canonicalised to `'primary'` there, although the renderer and cascade also accept `null` for
  it.

## Global config mirroring

- App-managed global config (hooks, permissions, the global `CLAUDE.md`) is Primary-authoritative
  and mirrored to every secondary profile's directory on write (`mirrorToProfiles`).
- Both places that write the global `CLAUDE.md` mirror it: the CLAUDE.md editor (`claudemd:save`)
  and the voice-personality upsert (`voice:setPersonality`).
- A failed mirror shows a `profiles:mirrorFailed` toast.

## UI

- The Subscriptions panel (global settings) creates, renames, recolours and deletes profiles, and
  reseeds a profile's config dir from Primary.
- Per-project and per-workspace assignment is through their sidebar right-click menus, which open
  a shared assign modal (there is no project-settings modal). There are also inline pickers on the
  spawn-options and automation-editor surfaces.
- The mini usage bar polls and shows every profile. The Usage modal's detailed breakdown is
  Primary-only (tracked follow-up).

## macOS

Guarded, not supported. `profile:create` refuses on `darwin` and the panel disables "Add
subscription" there, because it is unverified whether the CLI's keychain credential storage is
scoped per `CLAUDE_CONFIG_DIR`. The design spec lists the outstanding experiment.
