# Spawn-time Permission-Mode Selector — Design

**Date:** 2026-05-30
**Status:** Approved (design + decisions locked); building
**Scope:** Spawn-time only (no live mid-session switching, no automation-modal changes in v1)

## Problem

The spawn popover only exposes an all-or-nothing **Skip Permissions** checkbox, which maps to
`--dangerously-skip-permissions` (renderer.js:9147) — i.e. Claude Code's `bypassPermissions` mode.
Claude Code supports a spectrum of permission modes at launch via `--permission-mode`. Users who want
a *safer* launch (e.g. `plan` to scope work read-only first, or `acceptEdits` to auto-accept edits
but still gate bash) currently can't choose one without hand-typing into the Custom args box.

## Goal

Replace the checkbox with a **Permission:** dropdown offering every mode, set at spawn time,
persisted per-project, and replayed on respawn/resume exactly like the other spawn options — with
zero regression to the existing bypass behavior and transparent migration of saved settings.

## Non-goals (v1)

- Live mid-session mode switching (already available via Shift+Tab inside the terminal).
- Per-column live mode indicator / relaunch.
- New mode controls in the automation/manager modals or headless dock (they continue to inherit the
  global dropdown state through the shared `buildSpawnArgs()`, unchanged).

## Decisions (locked during brainstorming)

1. **Scope:** spawn-time only.
2. **Modes:** all six — `default`, `plan`, `acceptEdits`, `dontAsk`, `auto`, `bypassPermissions`.
3. **Old checkbox:** replaced (not kept alongside), with migration of `skipPermissions: true`.
4. **UI form:** a `<select>` row matching the existing Model / Cloud-effort / Local-effort selects.

## CLI ground truth (verified via `claude --help`, 2026-05-30)

```
--permission-mode <mode>   (choices: "acceptEdits", "auto", "dontAsk", "plan")
```

Consequences:
- Spellings `plan`, `acceptEdits`, `dontAsk`, `auto` are **confirmed exact** (camelCase as shown).
- `--permission-mode` does **not** accept `bypassPermissions` or `default`. Therefore:
  - `default` → emit **no flag** (the CLI default).
  - `bypassPermissions` → emit **`--dangerously-skip-permissions`** (this is *required*, not merely
    preferred — passing it through `--permission-mode` would be rejected as an invalid choice).

## UI

In the spawn dropdown (`index.html` ~243), remove the `Skip Permissions` `<label>`/checkbox and add,
just above the `Endpoint:` row, a select row consistent with the sibling selects:

```
Permission: [ Default ▾ ]
```

Options (value → visible label):

| value               | label                              |
|---------------------|------------------------------------|
| `default`           | Default · normal prompts           |
| `plan`              | Plan · read-only, plans first      |
| `acceptEdits`       | Accept Edits · auto-accept edits   |
| `dontAsk`           | Don't Ask · auto-approve safe ops  |
| `auto`              | Auto · classify per operation      |
| `bypassPermissions` | Bypass ⚠ · skip all (yolo)         |

Default selected value: `default`. A `?` help span (matching the existing pattern) summarizes the
modes and warns on Bypass.

## Integration architecture (renderer cannot `require()`)

`index.html` loads `renderer.js` and `lib/clawd-widget.js` as plain `<script src>` tags
(index.html:1325–1326); the renderer runs with `nodeIntegration: false, contextIsolation: true`
(main.js) and contains **no** `require`/`module.exports`. So renderer code cannot import a lib module
via `require()`.

The established pattern for a renderer-side helper that is also unit-tested (see `lib/clawd-widget.js`
lines 503–505) is **UMD via script tag**:

- `lib/permission-mode.js` defines the functions, exports them for Node tests with
  `if (typeof module !== 'undefined' && module.exports) module.exports = {...}`, and exposes them as
  browser globals (assigned to `window`) for the renderer.
- `index.html` loads `<script src="lib/permission-mode.js"></script>` **before** `renderer.js`.
- `renderer.js` calls the globals directly (e.g. `permissionModeToArgs(...)`).

This keeps a **single tested source of truth** — no logic duplicated between lib and renderer.

## `lib/permission-mode.js` (the pure, tested unit)

```js
'use strict';
var VALID_PERMISSION_MODES = ['default','plan','acceptEdits','dontAsk','auto','bypassPermissions'];

// mode -> CLI args (empty for default/unknown)
function permissionModeToArgs(mode) {
  if (mode === 'bypassPermissions') return ['--dangerously-skip-permissions'];
  if (mode === 'plan' || mode === 'acceptEdits' || mode === 'dontAsk' || mode === 'auto') {
    return ['--permission-mode', mode];
  }
  return []; // 'default' or anything unrecognized
}

// resolve persisted spawnOptions -> a valid mode string (handles legacy migration)
function migratePermissionMode(opts) {
  opts = opts || {};
  if (VALID_PERMISSION_MODES.indexOf(opts.permissionMode) !== -1) return opts.permissionMode;
  if (opts.skipPermissions === true) return 'bypassPermissions';
  return 'default';
}
// UMD: module.exports for tests + window globals for the renderer.
```

## Argument emission — `buildSpawnArgs()` (renderer.js:9145)

Replace:

```js
if (optSkipPermissions.checked) { args.push('--dangerously-skip-permissions'); }
```

with:

```js
Array.prototype.push.apply(args, permissionModeToArgs(optPermissionMode.value));
```

### Why bypass keeps the legacy flag (behavior preservation)

Beyond the CLI-rejection reason above:
1. The automation de-dupe guard checks for the literal string and re-pushes it if absent
   (renderer.js:12906–12907); other call sites (main.js:5869, 6544) also key on
   `--dangerously-skip-permissions`.
2. The proxy-auth `--bare` interaction and the `yolo` button tag are written against that flag.

So the only genuinely new runtime args are `--permission-mode plan|acceptEdits|dontAsk|auto`; the
bypass and default paths are byte-for-byte unchanged.

## Persistence & migration (renderer.js:9237–9264)

- `saveSpawnOptions()`: write `permissionMode: optPermissionMode.value`; stop writing `skipPermissions`.
- `loadSpawnOptions()`: `optPermissionMode.value = migratePermissionMode(opts)` (priority: valid
  `permissionMode` → legacy `skipPermissions:true` → `default`), so existing yolo users keep their
  setting.

**Downgrade caveat (accepted):** an older app build reading a config written by the new build sees no
`skipPermissions` key and falls back to `default`. Acceptable for a personal, auto-updating app.

## Button label (renderer.js:9219)

In `updateSpawnButtonLabel()`:

- `bypassPermissions` → keep the existing `yolo` tag.
- `plan` / `acceptEdits` / `dontAsk` / `auto` → push the mode name as a tag.
- `default` → no tag (mirrors how `model` tags only when non-default).

## Shared-call-site behavior (confirmed, unchanged)

`buildSpawnArgs()` is also invoked by layout restore (renderer.js:2775, 2795) and the
automation/manager/headless arg builders (12905, 13140, 15085). These already inherit the global
dropdown's model/bare/effort/etc.; they now also inherit `permissionMode` identically. No new
behavior is introduced at those sites — bypass still emits the same flag the automation guard expects.

## Testing — `test/permission-mode.test.js`

Follow the `node --test` pattern (the suite has 88 passing tests across 11 files):

- `permissionModeToArgs`: each of the 6 modes → expected args; `'default'`, `''`, `undefined`, and an
  unknown string → `[]`.
- `migratePermissionMode`: new `permissionMode` present (incl. an invalid value falling through);
  legacy `skipPermissions:true` → `'bypassPermissions'`; neither → `'default'`; `null`/`{}` input.
- `VALID_PERMISSION_MODES`: contains exactly the 6 expected values.

Renderer DOM wiring stays thin (it just reads `optPermissionMode.value` and calls the tested helper);
not unit-tested in v1 (consistent with the other DOM-bound spawn options).

## Risk assessment

Low. New runtime args are limited to four `--permission-mode` variants; bypass and default paths are
unchanged. Migration is additive. All branching logic lives in one isolated, fully unit-tested module.
