# Collaborative Automations

Extend the existing single-user Automations system so teams can share, edit, and trigger automations across machines via a user-configured MongoDB database. Owners retain full control over what runs on their machine and who can edit or trigger it.

## Problem

Automations today live in `~/.claudes/automations.json` on one machine and can only be managed or observed by the user who owns that machine. Teams that want to collaborate on automations — tweaking prompts, re-triggering runs, watching live output — have no way to do so short of screen-sharing. The owner of the host machine must preserve the ability to control what executes there, since every automation is effectively arbitrary code (Claude CLI has filesystem, git, and database access).

## Goals

- Shared automations stored in a team-owned MongoDB database (Cosmos DB for MongoDB vCore or Atlas).
- Colleagues can view, edit (where permitted), trigger (where permitted), and watch live output of shared automations.
- Per-automation trust flags let owners decide who can run and who can edit without approval.
- Org-scoped collaboration with invite-based membership.
- Handoff of automation ownership to another user when the original owner is unavailable.
- Local automations remain local — the feature is opt-in and additive.
- No new infrastructure beyond the user-provided Mongo database. No relay service.

## Non-goals (v1)

- Multi-host execution (automations run on one owner machine at a time).
- Real identity verification via OAuth / email. Identity is self-declared; connection string + invite code are the trust boundary.
- Email invite delivery. Invites are out-of-band (copy-paste blob over Slack / whatever).
- Timezone-aware scheduling. Existing wall-clock behavior unchanged.
- Catch-up of missed shared-automation runs after reconnection.
- End-to-end encryption of automation content. The owning team is trusted with its own DB.

## Key design decisions

| Decision | Choice |
|---|---|
| DB configuration | User-provided per-team. Default DB name `Claudes`. |
| Credential storage | Electron `safeStorage` in `~/.claudes/shared-creds.enc`. DPAPI on Windows, Keychain on macOS. |
| Collaboration unit | **Org**. One Mongo database can host many orgs, many users, many memberships. |
| Identity model | Self-declared display name + email per local install. Connection string + one-shot bearer invite blob is the trust boundary. |
| Run trust | Default: owner-approval. Per-automation `externallyRunnable` flag lets members trigger directly. |
| Edit trust | Per-automation `editingMode: "open" \| "reviewed"`. Reviewed drafts need owner approval. |
| Edit concurrency | Pessimistic lock, 5-min TTL, owner force-unlock. Optimistic version check as a second guard. |
| Live streaming | Mongo change streams on `runOutputs`. Fallback to 2s polling if unsupported. |
| Offline host | Visible host status; remote Run click queues a `runRequests` doc that drains on next startup. |
| Run history retention | Full chunks for recent N days (default 7, per-org). Metadata kept forever. |
| Host-side sync | 30s scheduler tick for config + heartbeat + request drain. Change streams for run requests + live output where latency matters. |

## Architecture

```
┌── OWNER MACHINE (Electron) ──────────────────┐          ┌── MongoDB (user-provided) ──┐
│                                               │          │                              │
│  renderer.js ──IPC──► main.js ──────────────┐ │          │  orgs                        │
│                         │                   │ │          │  users                       │
│                         ▼                   │ │          │  memberships                 │
│                    Scheduler tick (30s)    ─┼─┼──read───►│  automations (shared only)  │
│                         │                   │ │          │  runRequests                 │
│                    node-pty spawn ─ Claude  │ │          │  runs                        │
│                         │                   │ │          │  runOutputs                  │
│                    live chunks ─────────────┼─┼──write──►│  presence (TTL)              │
│                                             │ │          │  locks (TTL)                 │
│                    change stream watcher ◄──┼─┼──watch───│  invites (TTL)               │
│                                             │ │          │                              │
└──────────────────────────────────────────────┘ │          └──────────────────────────────┘
                                                 ▲                        ▲
                                                 │                        │
┌── COLLEAGUE MACHINE (Electron) ────────────────┴────────────────────────┘
│  renderer.js ──IPC──► main.js ──── reads/writes same Mongo ──── watches runOutputs ─── shows UI
└─────────────────────────────────────────────────────────────────────────
```

### Process model

- Mongo client lives in `main.js`, using the standard `mongodb` Node.js driver. Pure JS, no native bindings, no electron-rebuild exposure. Shipped in Electron's bundled Node runtime.
- `pty-server.js` is unchanged. Only `main.js` knows about Mongo.
- Two long-lived Mongo connections from the host: one for normal reads/writes, one dedicated to the change-stream watcher so reconnects on the stream don't stall the main connection.
- Colleague viewers open a change-stream connection to `runOutputs` only while actively watching a running automation. Closed on run completion or unwatch.

### Source of truth

- **Shared automations**: MongoDB is authoritative. Local file holds no shared-automation content.
- **Local automations**: `~/.claudes/automations.json` is authoritative. Existing schema unchanged.
- The renderer composes the visible list by merging local + shared-for-my-orgs, tagging each entry with its scope.

## Data model

All IDs are `"<type>_<timestamp>_<random>"` strings consistent with existing `auto_`, `agent_` conventions.

### `orgs`

```json
{
  "_id": "org_...",
  "name": "Websites Team",
  "createdAt": "...",
  "createdByUserId": "user_...",
  "retentionDays": 7,
  "schemaVersion": 1
}
```

### `users`

```json
{
  "_id": "user_...",
  "email": "paul@example.com",
  "displayName": "Paul",
  "createdAt": "...",
  "schemaVersion": 1
}
```

Unique index on `email`. Display names are not required to be unique — the email is the identity key. UIs that show names disambiguate with email on hover.

### `memberships`

```json
{
  "_id": "mem_...",
  "userId": "user_...",
  "orgId": "org_...",
  "role": "admin" | "member",
  "joinedAt": "..."
}
```

Unique compound index on `{ userId, orgId }`. Secondary index on `{ orgId, role }`.

### `automations`

Shape of an agent inside `agents[]` is unchanged from today's local automation agent (name, prompt, schedule, runMode, runAfter, runOnUpstreamFailure, isolation, enabled, skipPermissions, firstStartOnly, dbConnectionString, dbReadOnly, last* fields, currentRunStartedAt).

```json
{
  "_id": "auto_...",
  "orgId": "org_...",
  "name": "TaskBoard Pipeline",
  "projectPath": "D:/Git Repos/MyProject",
  "ownerUserId": "user_ashley",
  "ownerMachineId": "machine_...",
  "pendingOwnerUserId": null,
  "externallyRunnable": false,
  "editingMode": "reviewed",
  "enabled": true,
  "runWindow": { /* optional, same shape as today */ },
  "agents": [ /* same shape as today */ ],
  "version": 5,
  "updatedAt": "...",
  "updatedByUserId": "user_paul",
  "draft": {
    "config": {
      "name": "...",
      "agents": [ /* proposed agents config */ ]
    },
    "editedByUserId": "user_paul",
    "editedAt": "...",
    "baseVersion": 5
  },
  "schemaVersion": 1
}
```

- `version` increments on every save.
- `draft` is present only when `editingMode: "reviewed"` and a non-owner has a pending change. One draft at a time per automation, enforced by the edit lock.
- `pendingOwnerUserId` makes handoff explicit; scheduler pauses the automation while set.
- `projectPath` identifies the project on the owner's machine. Not meaningful to non-owner viewers except as metadata.

Indexes: `{ orgId }`, `{ ownerMachineId, enabled }`.

### `runRequests`

```json
{
  "_id": "req_...",
  "orgId": "org_...",
  "automationId": "auto_...",
  "agentId": "agent_...",
  "requestedByUserId": "user_paul",
  "status": "pending" | "claimed" | "completed" | "orphaned" | "cancelled",
  "createdAt": "...",
  "claimedAt": null,
  "runId": null
}
```

- On scheduler claim: `findOneAndUpdate({ _id, status: "pending" }, { $set: { status: "claimed", claimedAt: now, runId: <new> } })`.
- TTL on `createdAt`: 7 days. Stale queued requests expire quietly.

Indexes: `{ automationId, status }`, TTL on `createdAt`.

### `runs`

```json
{
  "_id": "run_...",
  "orgId": "org_...",
  "automationId": "auto_...",
  "agentId": "agent_...",
  "status": "running" | "completed" | "error" | "interrupted" | "skipped",
  "startedAt": "...",
  "completedAt": null,
  "summary": null,
  "attentionItems": null,
  "exitCode": null,
  "triggeredBy": { "userId": "user_paul", "via": "schedule" | "remote" | "local" | "handoff-resume" },
  "requestId": "req_..." | null
}
```

No TTL. Metadata kept forever.

Indexes: `{ automationId, startedAt: -1 }`.

### `runOutputs`

```json
{
  "_id": "chunk_...",
  "runId": "run_...",
  "seq": 0,
  "chunk": "…utf-8 text…",
  "createdAt": "..."
}
```

Append-only. TTL on `createdAt` = `org.retentionDays * 86400`. Chunks ordered by `seq` (host-monotonic), not `createdAt`.

Indexes: `{ runId, seq }`, TTL on `createdAt`.

### `presence`

```json
{
  "_id": "machine_...",
  "userId": "user_...",
  "orgIds": ["org_..."],
  "lastSeen": "...",
  "appVersion": "1.7.17"
}
```

Host upserts every 30s. TTL on `lastSeen` = 120s. Absent presence doc = machine offline.

### `locks`

```json
{
  "_id": "auto_...",
  "userId": "user_paul",
  "acquiredAt": "...",
  "expiresAt": "..."
}
```

TTL on `expiresAt`. One lock per automation. Renewed by the editor every 2min.

### `invites`

```json
{
  "_id": "CLAUDES-7F2K-A9JX",
  "orgId": "org_...",
  "role": "member" | "admin",
  "createdByUserId": "user_...",
  "createdAt": "...",
  "expiresAt": "...",
  "redeemed": false,
  "redeemedByUserId": null,
  "redeemedAt": null
}
```

TTL on `expiresAt`. Default 24h.

### Invite blob format

Base64-encoded JSON:

```json
{
  "v": 1,
  "connectionString": "mongodb+srv://...",
  "dbName": "Claudes",
  "orgId": "org_...",
  "orgName": "Websites Team",
  "inviteCode": "CLAUDES-7F2K-A9JX"
}
```

The blob is the full authorization. Owner copies it, delivers out-of-band. Redemption is one-shot.

## Roles and permissions

Two roles per org in v1:

| Action | Member | Admin |
|---|---|---|
| View automations in org | ✓ | ✓ |
| Watch live runs | ✓ | ✓ |
| Create automation (becomes owner) | ✓ | ✓ |
| Edit automation I own | ✓ | ✓ |
| Edit automation in `editingMode: "open"` | ✓ | ✓ |
| Submit draft on `editingMode: "reviewed"` | ✓ | ✓ |
| Approve/reject drafts on automations I own | own only | any |
| Trigger run on automation with `externallyRunnable: true` | ✓ | ✓ |
| Set trust flags (`externallyRunnable`, `editingMode`) | own only | own only |
| Initiate handoff | own only | any |
| Accept handoff | recipient only | recipient only |
| Invite users | ✗ | ✓ |
| Remove users | ✗ | ✓ |
| Change org settings | ✗ | ✓ |
| Force-unlock an edit lock | own only | any |

## Sync and execution

### Scheduler tick (every 30s on host)

1. **Refresh shared automations**: `db.automations.find({ ownerMachineId: me, enabled: true, pendingOwnerUserId: null })`. Merge any docs with `version` higher than the in-memory cache.
2. **Evaluate schedule** for local + shared automations together through the existing `shouldRunAgent` logic.
3. **Drain pending run requests**: `db.runRequests.find({ automationId: { $in: myOwnedIds }, status: "pending" })`. Claim atomically with `findOneAndUpdate`. Fire via the existing spawn path. `runRequests` bypass the run-window gate (manual trigger).
4. **Upsert presence**: `{ machineId, userId, orgIds, lastSeen: now, appVersion }`.

### Change-stream watcher (host)

Opens on app start, one persistent subscription:

```js
db.runRequests.watch([
  { $match: {
      "fullDocument.automationId": { $in: myOwnedIds },
      operationType: "insert"
  } }
])
```

On each event, wake the scheduler to drain immediately. Resume token persisted to `~/.claudes/change-stream-token.json` so reconnects across restarts don't miss events. The watcher also observes `automations` inserts/updates where `pendingOwnerUserId` targets the current user — used to surface handoff prompts in real-time.

### Change-stream watcher (viewer, only during active watch)

```js
db.runOutputs.watch([
  { $match: {
      "fullDocument.runId": <viewedRunId>,
      operationType: "insert"
  } }
])
```

Chunks pipe directly into the xterm in the run detail pane, ordered by `seq`. Watcher closes on run completion or when the viewer navigates away.

### Change-stream fallback

On first `watch()` attempt, if the server returns "not supported" (some constrained Mongo backends), flag the connection `streams: false` for the session. All would-be watchers become pollers:

- Run requests: 5s interval.
- Run outputs (viewer): 2s interval, `find({ runId, seq: { $gt: lastSeq } }).sort({ seq: 1 })`.

Rest of the code paths identical.

### Edit lock flow

```js
db.locks.findOneAndUpdate(
  { _id: automationId, $or: [ { expiresAt: { $lt: now } }, { _id: { $exists: false } } ] },
  { $set: { userId, acquiredAt: now, expiresAt: now + 5min } },
  { upsert: true, returnDocument: "after" }
)
```

If the returned `userId !== requestor`, show read-only banner with the holder's display name and the lock's expiry. Holder's app auto-renews every 2 min while the editor is open. Lock released explicitly on Save/Cancel/close of the editor.

### Save flow — `editingMode: "open"`

```js
db.automations.updateOne(
  { _id, version: expectedVersion },
  { $set: { ...changes, updatedAt: now, updatedByUserId: me }, $inc: { version: 1 } }
)
```

`matchedCount === 0` → conflict. UI shows a conflict modal with the newer version and `Discard my changes / Copy my changes to clipboard`.

### Save flow — `editingMode: "reviewed"` (non-owner)

```js
db.automations.updateOne(
  { _id, version: baseVersion },
  { $set: { draft: { config: proposedConfig, editedByUserId: me, editedAt: now, baseVersion } } }
)
```

Owner notified via change-stream. Owner opens diff modal, picks Approve or Reject.

- **Approve**: `{ $set: { ...draft.config, updatedAt: now, updatedByUserId: <submitter> }, $inc: { version: 1 }, $unset: { draft: "" } }` with `$match: { version: baseVersion }`. If the version moved (owner edited directly since), Approve fails with a conflict.
- **Reject**: `{ $unset: { draft: "" } }`. Submitter toasted.

Owners can also edit reviewed automations directly (they skip the draft mechanism; this is what `own` access implies).

### Remote run trigger flow

1. Colleague clicks Run on an `externallyRunnable: true` automation.
2. UI writes `runRequests { status: "pending", requestedByUserId: me, … }`.
3. UI opens a `runs.watch()` filtered to `{ fullDocument.requestId: this }` to catch the incipient `runs` doc. Displays `Queued — waiting for host` with the host's presence status.
4. Host's change-stream watcher wakes the scheduler. Scheduler claims the request (`status: "claimed", runId: <new>`), spawns the agent via existing path. `runs` doc written with `triggeredBy: { userId, via: "remote" }`, `requestId` set. Colleague's watcher picks up the new `runs` doc and flips the UI to live-watch mode.
5. If host offline: `presence` doc absent for `ownerMachineId`. UI shows `Host offline — queued` with a Cancel button. Request stays `pending`. When host's Claudes next starts, the startup routine drains queued requests just like the scheduler tick does.

### Handoff flow

1. Ashley: Edit modal → Transfer ownership → pick Paul → `$set: { pendingOwnerUserId: paul }`. Scheduler pauses the automation on all hosts (skips docs with `pendingOwnerUserId != null`).
2. Paul's change-stream watcher fires. Modal shown: automation name, summary, `Accept / Reject / Ask me later`.
3. **Accept**: `{ $set: { ownerUserId: paul, ownerMachineId: paul-machine, updatedAt: now, updatedByUserId: paul }, $unset: { pendingOwnerUserId: "" }, $inc: { version: 1 } }`. Paul's scheduler picks it up on next tick. If any agent has `isolation.enabled` and Paul's machine has no clone at the recorded path, the accept flow triggers the clone-setup wizard before activation.
4. **Reject**: `{ $unset: { pendingOwnerUserId: "" } }`. Ashley notified via change-stream.
5. **Admin force-reassign**: an admin can skip the accept step with `{ $set: { ownerUserId: X, ownerMachineId: null } }`. Automation is paused until that user's Claudes starts and sets `ownerMachineId = their machine`.

### Heartbeat + offline indicator

- Host upserts `presence` every 30s on scheduler tick.
- TTL expires `presence` after 120s of no updates.
- Colleague UIs render per-automation host status by looking up `presence` for `ownerMachineId`. `Online` (green dot) if doc exists, `Offline (last seen Nmin ago)` (gray) otherwise. Last-seen sourced from a locally-cached most-recent timestamp, since TTL deletes the doc once stale.

## UI

### Onboarding

**First time sharing (creating):**

- Triggered by clicking "Share..." on a local automation or "Set up shared automations" in Settings.
- Modal step 1: paste connection string + DB name (default `Claudes`). App runs a test query and `safeStorage.isEncryptionAvailable()`.
- Modal step 2: "Create your first org" — org name + display name + email. Writes `orgs`, `users` (if new email), `memberships` with role `admin`.

**First time joining (redeeming invite):**

- Triggered by "Join an org" from Settings.
- Modal: paste invite blob. App decodes, stores connection string encrypted, prompts for display name + email (pre-filled from email if invite pre-specified one).
- App writes `users` (if new), consumes the invite with `findOneAndUpdate({ _id: code, redeemed: false }, { $set: { redeemed: true, redeemedByUserId, redeemedAt: now } })`, writes `memberships`.

### Settings — new "Shared automations" section

- Connection status: `Connected to <dbName> on <host>` or `Not configured`.
- Org list rows: name, role, member count. Click opens Org Manager modal.
- **Change database** button with red-bordered confirmation: `Switching DB disconnects you from all current orgs. Continue?`
- **Leave org** link per row.

### Org Manager modal (admin view)

- Members table: display name, email, role, joined, last seen (from `presence`). Actions: promote / demote / remove. Removing a member with owned automations requires reassigning those automations first (list shown in the confirm dialog).
- **Invite a member**: role picker → Generate → blob shown in a textarea with Copy button and one-shot expiry note (default 24h).
- Pending invites list with Revoke action.
- Org settings: name, `retentionDays`.

### Automations tab (list)

Cards get three new visual elements:

- **Scope badge** (top-left): `Local` (subtle) or `Shared · <OrgName>` (colored chip).
- **Owner row** (shared only): `<OwnerName> · <Online dot> / <Offline, last seen Nmin ago>`.
- **Trust icon row** (shared only): small pill icons for `externally runnable` and `reviewed editing` with tooltips. Hidden if defaults (owner-only run, open edits).

Sort: local first, then grouped by org. Optional filter pills at top: `All / Local / <OrgName>`.

### Create/Edit modal — additions

- **Promote to shared** button (top-right, only for local automations when ≥ 1 org configured). Picker → choose org → confirm. Writes to Mongo with new `_id`. Irreversible in v1 (documented clearly). Original local entry deleted on success.
- **Sharing section** (shared automations only, above agents list):
  - `Allow members to trigger runs` (`externallyRunnable` checkbox).
  - `Editing mode`: radio `Open — members can edit directly` / `Reviewed — member edits need my approval`.
  - **Transfer ownership** button → member picker → triggers handoff flow.
- **Lock banner** at top when another user holds the lock: read-only mode, banner `<Name> is editing · lock expires in M:SS`. For owners/admins: `Force unlock` with confirmation.

### Draft review pane

For owners on `reviewed` automations with an active draft: a row at the top of the card — `Draft from <Name> · N changes · Review →`. Opens diff modal:

- Side-by-side field-level diff. Unchanged fields collapsed.
- `Approve` / `Reject` / `Reject with message` buttons.

### Handoff accept modal

Triggered by change-stream event on recipient's Claudes:

- `<Owner> has transferred "<Name>" to you.`
- Summary: name, agent count, run frequency, whether isolated clones need re-setup.
- `Accept` / `Reject` / `Ask me later`.

### Run detail view

- Live stream via change stream (same xterm pane as today).
- Status line: `Triggered by <Name> · <time> · Running on <HostName>'s machine`.
- Queued state (remote click, host offline): placeholder with `Cancel` / `Wait` controls.
- Retention-expired state: `Full output no longer retained (kept N days)` in place of the terminal; metadata and summary still shown.

### Flyout

- Grouped-by-project layout preserved.
- New grouping: Local first, then `Shared · <OrgName>` sections.
- Per-row online/offline dot for shared items.

## IPC API

### New renderer → main channels

| Channel | Purpose |
|---|---|
| `sharing:configureConnection` | Paste connection string; test + store via safeStorage |
| `sharing:clearConnection` | Disconnect from current DB |
| `sharing:getConnectionStatus` | Returns `{ connected, dbName, hostRedacted }` |
| `sharing:createOrg` | Create org, self as admin |
| `sharing:getMyOrgs` | List orgs the current user belongs to |
| `sharing:createInvite` | `{ orgId, role, expiresHours }` → returns blob |
| `sharing:redeemInvite` | `{ blob, displayName, email }` |
| `sharing:revokeInvite` | By invite id |
| `sharing:listMembers` | By orgId |
| `sharing:promoteMember` / `demoteMember` / `removeMember` | Admin actions |
| `sharing:updateOrgSettings` | `{ orgId, retentionDays, name }` |
| `automations:promoteToShared` | `{ localId, orgId }` → moves entry to Mongo |
| `automations:acquireLock` / `releaseLock` / `forceUnlock` | Lock operations |
| `automations:saveOpen` | Save in open mode (version-checked) |
| `automations:submitDraft` | Save as draft in reviewed mode |
| `automations:approveDraft` / `rejectDraft` | Owner/admin actions |
| `automations:transferOwnership` | `{ automationId, toUserId }` |
| `automations:acceptHandoff` / `rejectHandoff` | Recipient actions |
| `automations:adminReassign` | Admin force-reassign |
| `automations:requestRun` | `{ automationId, agentId }` — writes runRequest |
| `automations:cancelRequest` | Cancel a pending request |
| `automations:watchRun` | Open change stream for a run's outputs |
| `automations:unwatchRun` | Close it |
| `automations:listShared` | Returns shared automations for my orgs |
| `automations:getPresence` | `{ machineId }` → online status |

### New main → renderer events

| Event | Payload |
|---|---|
| `sharing:connection-state-changed` | `{ state, error? }` |
| `automations:shared-updated` | `{ automationId, version }` (from change stream or poll) |
| `automations:draft-submitted` | `{ automationId, draft }` |
| `automations:handoff-pending` | `{ automationId, fromUserName }` |
| `automations:handoff-resolved` | `{ automationId, resolution }` |
| `automations:remote-run-chunk` | `{ runId, seq, chunk }` |
| `automations:remote-run-status` | `{ runId, status }` |
| `automations:run-requested` | Fired on host when a remote request arrives |

## Error handling

| Scenario | Behavior |
|---|---|
| Mongo connection lost (host) | Scheduler keeps running local automations. Shared automations evaluate against last cached state; shared runs pause until reconnect. Exponential backoff reconnect (1s → 60s cap). UI toast: `Shared automations disconnected — retrying…` |
| Mongo connection lost (viewer) | Viewer UI grays shared-automation section, `Disconnected — retrying…`. Change-stream watchers auto-reconnect with stored resume token. |
| Invalid connection string in setup | Test query fails with clear error (`Authentication failed` / `Cannot reach host`). Nothing written to keychain. |
| `safeStorage.isEncryptionAvailable()` returns false | Sharing setup blocked: `This machine can't securely store credentials. Sharing disabled.` No plaintext fallback. |
| Change-stream resume token too old | Fall back to polling for the session. Log once. User sees no disruption. |
| Lock holder disappears mid-edit | TTL expires lock after 5 min. Other user's next attempt acquires. Unsaved changes on the original editor are lost (same semantics as closing an unsaved modal). |
| Two writes with same `expectedVersion` after lock TTL | Second write's `matchedCount: 0`. UI shows conflict dialog with newer version; `Discard my changes` / `Copy my changes to clipboard`. |
| Draft submitted while owner is mid-direct-edit | Draft write rejected by version check. Submitter toasted: `Owner edited this automation while your draft was pending — reload and try again.` |
| Handoff to user removed from org before accept | Pending state auto-cleared by scheduler when `pendingOwnerUserId` doesn't resolve to a current membership. Owner notified. |
| Handoff accepted, recipient has no clone for isolated agent | Accept flow prompts clone-setup before activation. Cancel → automation stays paused with `Needs setup on your machine` banner. |
| Admin force-reassign to offline/never-online user | Allowed; automation paused until recipient's Claudes starts. Clearly labeled. |
| Promote-to-shared while a local run is active | Blocked: `Finish or cancel the current run first`. |
| Removing a user who owns automations | Confirmation forces admin to reassign each owned automation first (list shown). Cannot orphan owners. |
| Invite code already redeemed | `findOneAndUpdate` returns null → `This invite has already been used`. |
| Invite code expired (TTL) | Same path → `This invite has expired. Ask the admin for a new one.` |
| TTL expires `runOutputs` during live view | Viewer sees chunks up to cutoff, then gap marker, then continued live chunks. Rare, only near retention boundary. |
| Clock skew between machines | No cross-machine clock comparisons. Locks use server-side `expiresAt` computed via Mongo `$$NOW`. Chunks ordered by `seq`, not timestamps. |
| DB switched while colleague connected | Next operation fails auth/not-found → `This org is no longer available. Remove?` |
| Run request for deleted automation | Scheduler marks request `status: "orphaned"`. Requester toasted. |
| `externallyRunnable` flipped off while request is queued | Scheduler cancels queued requests on next drain. Requester toasted: `Cancelled by owner`. |
| Two machines claim `ownerMachineId` for the same automation | v1 invariant: one owner machine. If a scheduler sees `ownerMachineId != me` for a doc it thinks it owns, back off and log a warning. Shouldn't happen absent a bug. |

## Migration and rollout

This feature is additive. No changes to existing `automations.json` schema or `loops → automations` migration path.

- Users opt in via Settings → Shared automations → Set up. No automatic migration.
- On first connect to a Mongo DB, app calls `createIndex` for each required index (idempotent, Mongo skips if present). Collections materialize on first write.
- Every top-level doc carries `schemaVersion: 1` for future migrations.
- Dev/beta gate: env var `CLAUDES_SHARING_ENABLED=1` or hidden setting keeps the UI behind a flag during rollout.

## Testing strategy

| Layer | What | How |
|---|---|---|
| Pure functions | `canEdit`, `canRun`, `canManageOrg`, lock acquisition logic, invite blob encode/decode, version conflict resolution, handoff state transitions | Node `--test` unit tests. Same pattern as existing `test/*.test.js`. |
| Mongo-backed flows | Org creation, invite redemption, lock acquire/release, draft submit/approve, run request flow, handoff flow, version-checked saves | Integration tests against `mongodb-memory-server` (new devDep). Spawns in-memory Mongo 7.0 replica set per test — required for change streams. |
| Change streams | Resume token persistence, polling fallback detection, watcher reconnect after kill | Integration tests against replica set. |
| Host-offline transitions | Queue drain on startup, stale TTL behavior | Integration tests — write request, restart host, assert drain. |
| UI flows | Manual test plan (no UI automation in this project). Covers: setup, invite, join, promote, edit under both modes, lock contention, handoff accept/reject, remote run online + offline, retention expiry display, DB switch warning. | Pre-release checklist. |

Add `test:integration` npm script. CI runs both unit and integration suites.

## Suggested implementation phases

This spec is large enough that implementing it as one plan is unwieldy. Suggested decomposition for the writing-plans step:

1. **Foundation**: `mongodb` dependency, connection lifecycle in `main.js`, `safeStorage` wrapper, index creation on first connect, Settings → Shared automations UI with connect/disconnect. No collaboration features yet — just "can we hold a credential and talk to Mongo."
2. **Orgs, users, invites**: `orgs` / `users` / `memberships` / `invites` collections, create-org flow, invite blob generation + redemption, Org Manager modal, member list, role transitions.
3. **Shared automations (read-only first)**: `automations` collection, promote-to-shared flow, list rendering with scope badges in Automations tab, scheduler-tick merge of shared automations for execution, presence heartbeat, online/offline indicator. Edits via Mongo happen but only the owner can edit in this phase.
4. **Edit concurrency**: `locks` collection, lock banner UI, open-mode save with version check, conflict dialog.
5. **Reviewed editing mode**: `draft` field, submit-draft flow, draft review pane with diff, approve/reject.
6. **Remote run triggering + run history in Mongo**: `runRequests` + `runs` + `runOutputs` collections, `externallyRunnable` flag, queued-run UI, scheduler drain path, run detail view with triggered-by info.
7. **Live streaming**: change-stream watchers for `runOutputs`, viewer-side xterm integration, polling fallback path, resume-token persistence.
8. **Handoff**: `pendingOwnerUserId` flow, transfer modal, accept/reject modal, admin force-reassign.
9. **Retention + cleanup**: TTL indexes on `runOutputs`, per-org `retentionDays` setting, retention-expired UI state.

Each phase produces working functionality and can be reviewed independently. Phase 1 alone is useful (connection health check), phases 1-2 alone give org setup even without automation sharing, and so on.

## Files to modify

- `main.js` — Mongo client lifecycle, collection initialization, change-stream watchers, scheduler-tick extensions, all new IPC handlers, safeStorage wrapper.
- `pty-server.js` — unchanged.
- `renderer.js` — Onboarding modals, Settings sharing section, Org Manager, automations list rendering (scope badges, owner rows, trust icons), create/edit modal sharing section + promote button + transfer + lock banner, draft review modal, handoff accept modal, run detail view updates (queued state, triggered-by, retention-expired), flyout grouping.
- `preload.js` — expose all new IPC channels and events.
- `index.html` — new modal markup, new Settings section, scope badges, filter pills.
- `styles.css` — scope badges, online/offline dots, lock banner, trust icons, draft diff, handoff modal.
- `package.json` — add `mongodb` dependency, `mongodb-memory-server` devDependency, `test:integration` script.
- `~/.claudes/shared-creds.enc` — new runtime file.
- `~/.claudes/change-stream-token.json` — new runtime file.

## Not in scope

- Multi-host execution (co-hosted automations).
- Email/OAuth identity verification.
- End-to-end encryption of automation content at rest in Mongo.
- Catch-up of missed runs after reconnection.
- Timezone support.
- Per-day time window overrides or multiple ranges (still the Q1 Automation Run Windows constraints).
- "Demote to local" after promotion.
- Dedicated top-level "Sharing" menu (housed in Settings for v1).
- Read-only "viewer" role (v1 has Admin + Member only).
- Org deletion. Admins can leave, remove members, and revoke invites. The org doc and its associated automations persist in the DB. A future migration can add soft-delete.
- Admin override of trust flags. `externallyRunnable` and `editingMode` are owner-only because only the owner knows the risk profile of what runs on their machine. Admins can reassign ownership first if they need to change these.
