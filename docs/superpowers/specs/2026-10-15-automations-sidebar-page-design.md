# Automations in the sidebar, with a full-window page

Status: proposal. Written against `master` @ `b19d99f`.

## Problem

Automations live in a narrow tab in the right-hand explorer panel. Run output is a `<pre>` in
that column, so a long run is a very tall, very narrow scroll. Findings and decisions sit in the
same column, and nothing in the left sidebar says an automation needs you, apart from a small
error badge on the project name.

## Shape

1. Each automation is a row in the left sidebar, under its project.
2. Clicking it replaces the project's columns with a full-window automation page.
3. The right-hand Automations tab goes. Creating and editing stays in the existing modal.

### 1. Sidebar rows

Under each project, after its workspaces:

```
▾ ClubRight            ● 2  ! 3
    main
    feature-x
    ⚡ Nightly triage     ● 1
    ⚡ Insights check      !
    ⚡ PR watcher          ‖
▸ TaskBoard                 ! 1
```

- One row per automation: lightning icon, name, and a state marker: running (pulsing dot),
  failed or escalated (`!`), paused (`‖`), idle (nothing).
- A count badge for open findings plus unanswered decisions for that automation.
- A collapsed project rolls its automation badges into the project's own badge, the same way
  `updateSidebarActivity` already rolls up column attention.
- Order matches the automation list order. Disabled automations are dimmed, not hidden.
- Built by a new `buildAutomationItem` beside `buildWorkspaceItem` (renderer.js:2998).

**Adding an automation.** The project's right-click menu (renderer.js:3311) gains
"New automation…", which opens the existing modal for that project. The project row's hover
controls gain a lightning button that does the same. The conversational setup flow stays
reachable from the modal.

**Automation row right-click menu:** Run now, Pause / Resume, Edit…, Export…, Delete….

**Project-wide actions** from the old tab header (pause all, resume all, import, export all,
clear all) move to the project right-click menu under an "Automations" submenu. The global
scheduler pause and global run window already live in the toolbar flyout and stay there.

### 2. The automation page

Selecting an automation row hides the active project's `.project-columns` container and shows
one shared `#automation-page` in `#columns-container`. Selecting a project or workspace row
switches back. The project's terminals keep running underneath; only visibility changes.

```
⚡ Nightly triage   ● running · next 02:00 daily     [Run now] [Pause] [Edit] [⋯]
[ Agent: Triage ▾ ]  (only for multi-agent automations; includes "Manager")
┌──────────────────┬───────────────────────────────────────────────────────────┐
│ NEEDS YOU (2)    │ Run 02:14 · ✓ 4m 12s · exit 0              [Open in Claude] │
│ Kids Pass refund?│ SUMMARY                                                   │
│ [Chase][Cancel]  │ Archived 14, flagged 2                                     │
│ ──────────────── │ FINDINGS FROM THIS RUN                                     │
│ RUNS             │ • Kids Pass may still be billing                           │
│ ▶ Live      2m   │ OUTPUT                          [Find] [Copy] [Wrap]       │
│ ✓ 02:14  4m      │ ...full-height, monospace, scrolls independently...       │
│ ✗ Yesterday      │                                                           │
│ ✓ Mon 09:00      │                                                           │
└──────────────────┴───────────────────────────────────────────────────────────┘
```

- **Header:** name, state, schedule and next run, and actions. Edit opens the existing modal.
- **Agent picker:** shown only when the automation has more than one agent or a manager.
- **Left pane, top: Needs you.** Open findings and decisions for this automation, using the
  existing `renderFindingDecision` and acknowledge buttons. Collapses when empty.
- **Left pane, below: Runs.** History from `getAgentHistory` (or `getManagerHistory` for the
  manager), newest first, with a Live entry while running. Status, start time, duration.
  Loads more on scroll (the store keeps 50 per agent).
- **Right pane: the selected run.** Summary, that run's attention items, then the output
  filling the remaining height. Live runs stream through the existing
  `automations:agent-output` events and follow the tail unless the user has scrolled up.
  Find highlights matches in the output. Wrap toggles line wrapping.
- **Opening the page** selects the live run if there is one, otherwise the latest run.

### 3. Notifications

- Clicking a findings or manager OS notification selects that automation's row and opens its
  page with the relevant run (today it focuses the Automations tab).
- A newly opened finding or decision flashes the automation row, using the same
  `attention-flash` treatment as columns.
- The toolbar flyout and the always-on-top findings window stay. Clicking an automation in the
  flyout opens its page.

### 4. Removed

- The Automations tab in the explorer panel (index.html:84, 157-213) and its findings inbox.
- `updateAutomationSidebarBadges`' badge on the project name, replaced by the per-row markers.

## Build order

Each step is usable on its own.

1. `lib/automation-sidebar-view.js` (pure, tested): automations, last runs, live state and
   findings in; sidebar row models out (state marker, badge count, project roll-up).
2. Sidebar rows rendered from that model, with the right-click menus and "New automation…".
3. `#automation-page` shell: show and hide against project columns, header and actions.
4. Runs list and run viewer, including live streaming and the agent picker.
5. Needs-you pane, moving the findings inbox rendering out of the explorer tab.
6. Notification click-through and row flashing.
7. Remove the explorer tab and the project-name badge.

## Open questions

- Projects with many automations (ten or more) could make the sidebar long. Option: a
  collapsible "Automations" group under the project that remembers its state. Not built unless
  needed.
- Popout project windows (`?mode=popout`) get the same rows and page, since they reuse the
  renderer. To check during step 3.
