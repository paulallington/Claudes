# Decisions pane — turning the findings inbox into a two-way channel

Status: proposal. Written against `master` @ `b32b083`
("merge: give automation findings a way to reach the user").

Not an email feature. A generic Claudes primitive: **any automation can ask the
user a question and get a structured answer back.** Email triage is consumer #1.

---

## What already exists

Nearly all of the substrate is built. Worth being explicit, because the
remaining work is much smaller than it looks.

**Reporting channel** — `AGENT_PROMPT_SUFFIX` (main.js:7905) already makes every
automation emit:

```json
{"summary": "...", "attentionItems": [{"summary": "...", "detail": "...", "key": "optional-stable-slug"}]}
```

**Durable store** — `lib/findings-store.js` (344 lines, pure, no fs/Electron/DOM):

- `fingerprintFinding` — `automationId:agentId:key`, falling back to an FNV-1a
  hash of a normalised summary, so "expiring in 12 days" and "in 11 days"
  collapse to one entry
- `upsertFindings` — bumps `occurrences`, preserves `firstSeenAt` /
  `acknowledgedAt`
- `acknowledgeFinding` / `acknowledgeAll`
- `pruneFindings` — per-automation cap 100, global 500, acknowledged expire at
  30 days; **unacknowledged findings are never pruned**
- `listFindings`

Persisted at `~/.claudes/findings.json` (`findings-dev.json` in dev).

**View model** — `lib/findings-inbox-view.js`: grouping by automation, relative
time, "Seen N times", per-finding action, unacknowledged badge count.

**Surfaces** — an inbox in the Automations tab with a count badge, plus an
always-on-top frameless sticky window (`findings-sticky.html`).

**IPC** — `findings:list`, `findings:acknowledge`, `findings:acknowledgeAll`,
`findings:openConversation`, and a `findings:updated` push to both surfaces.
Notifications are debounced per automation so a multi-agent run fires once.

## What is missing

Exactly one thing, in two directions:

1. **A finding cannot ask anything.** It carries `summary` + `detail`. There is
   no way to say "here are your options."
2. **An answer cannot get back.** The only verbs are *acknowledge* (silences the
   badge) and *discuss* (spawns a column via `--append-system-prompt`). Whatever
   is decided in that column is lost to the store — the automation's next run
   has no idea what was chosen.

That gap — **options in, choice out** — is the whole build.

---

## Proposal

### 1. Extend the reported item (backwards compatible)

```json
{
  "summary": "Kids Pass may still be billing £3.99",
  "detail": "Cancelled in July 2024 but marketing continues...",
  "key": "kidspass-membership",
  "decision": {
    "prompt": "How should I handle this?",
    "options": [
      { "id": "chase",  "label": "Chase them",   "hint": "Draft an email asking for a refund" },
      { "id": "cancel", "label": "Just cancel",  "hint": "No refund attempt" },
      { "id": "ignore", "label": "Leave it" }
    ],
    "freeText": true
  }
}
```

An item with no `decision` behaves exactly as today. Nothing regresses.

**Make `key` required when `decision` is present.** Without it the fingerprint
is a hash of the summary, so an agent rewording its own text on the next run
orphans the answer and re-asks. This is the single most likely way the feature
rots in practice.

### 2. Store: add a resolution

Two new fields on a finding:

```js
decision:   { prompt, options: [{id, label, hint}], freeText } | null
resolution: { choiceId, text, resolvedAt } | null
```

One new pure function alongside `acknowledgeFinding`:

```js
resolveFinding(store, id, { choiceId, text }, now)
```

Two rules that matter:

- **Never prune an unresolved decision.** Extends the existing
  "unacknowledged findings are never pruned" rule — an unanswered question is
  strictly more important than an unread notice.
- **On recurrence, keep the resolution and bump `occurrences`** rather than
  clearing it. For triage, "you already said bin this sender" is precisely the
  thing worth persisting. Consumers compare `resolvedAt` against `lastSeenAt`
  to decide whether an old answer still applies. This is the one genuinely
  load-bearing choice in the design — the alternative (clear on recurrence,
  always re-ask) is safer but turns every recurring decision into nagging,
  which is the failure mode that killed the TaskBoard approach.

### 3. Getting answers back to the automation

The elegant version: **answers arrive the same way questions were asked — in
the prompt.** At spawn time, inject a block listing this automation's
resolutions since its last run:

```
--- RESOLUTIONS SINCE YOUR LAST RUN ---
kidspass-membership: chase — "get the refund if you can, otherwise just kill it"
--- END RESOLUTIONS ---
```

No new tool, no file reading, no MCP surface. The agent already knows how to
read its own prompt. Mirrors `AGENT_PROMPT_SUFFIX` and `findingsInboxDiscuss`,
both of which already work this way.

### 4. UI

The inbox and sticky window already render findings. Add, where `decision` is
present:

- option buttons (`label`, with `hint` as title text)
- a free-text box when `freeText` is true
- a resolved state showing the choice and when

The sticky window getting the same buttons *is* the decisions pane — an
always-on-top list of open questions, answerable without switching context.

`findingConversationAction` stays as-is: "Open conversation" remains the escape
hatch when the offered options aren't right.

---

## Why generic beats email-specific

Nothing above mentions mail. Other consumers already running here fall out free:

- **insights-check** — "this exception has fired 400 times, raise a ticket?"
- a deploy automation — "promote to prod?"
- a PR watcher — "merge, comment, or leave?"
- **triage** — "bin, archive, draft a reply, or remind me Monday?"

Triage stops needing a TaskBoard, two identities, `asMe: true`, lane semantics,
and the "comment outranks the lane" rule. All of that machinery exists only
because the decision and the execution happened in different places at
different times. Here they don't.

## Deliberately out of scope

- **Mobile.** The store is local to the machine. For triage, the answer is that
  decision state lives in the *mailbox* (folders/flags), so Outlook mobile keeps
  working for quick gestures and the pane is the desk surface. Other automations
  can rely on the existing notification path.
- **Multi-user.** Single-user, single-machine, like the rest of the store.

## Build order

1. `resolveFinding` + `decision`/`resolution` fields in `findings-store.js`,
   with tests (the store is pure — this is the cheap, high-value half)
2. `findings:resolve` IPC + persistence, mirroring `findings:acknowledge`
3. Resolution-injection at automation spawn
4. Option buttons in the inbox view model + renderer
5. Same in the sticky window
6. Extend `AGENT_PROMPT_SUFFIX` to document the `decision` field so automations
   know they can ask

Steps 1–3 are usable on their own: an automation could ask, and you could
answer via the existing "Discuss" column, before any button is drawn.
