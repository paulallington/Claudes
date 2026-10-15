# Implementation workflow (AIDP)

Every source change goes through this workflow. The agents are defined in `.claude/agents/`.

## Agents

| Agent | Scope | Model |
|-------|-------|-------|
| implementer-electron | main.js, renderer.js, preload.js, pty-server.js, index.html, styles.css, scripts/, release.sh, package.json | sonnet |
| tester-node | test/ | sonnet |
| ux-reviewer | index.html, styles.css, renderer.js | sonnet |
| reviewer | (read-only) | opus |

## Steps

1. **Classify**: trivial (skip to 4), standard, or vague/complex (`EnterPlanMode`).
2. **Research**: Explore agent(s) to understand the affected areas.
3. **Plan**: decompose into agent-scoped subtasks.
4. **Sync master and branch**: `git checkout master && git pull --ff-only` (skip the pull if there
   is no remote; on divergence, escalate, do not auto-merge or rebase), then
   `git checkout -b work/<task-description>`.
5. **Create and enter a worktree**:
   `git worktree add -b worktree-<task-slug> .claude/worktrees/<task-slug>`, then
   `EnterWorktree(path: ".claude/worktrees/<task-slug>")`. Use `worktree add` so the branch is
   based on local HEAD, not `origin/<default>`. Run `npm install` in the worktree before
   `npm start`.
6. **TDD loop**: for each behaviour in the plan, delegate ONE `Agent()` without `isolation`, with
   a strict red-green cycle (one failing test, the minimum code to pass, stop). Commit per cycle
   (test and implementation in the same commit). For `## Behavior triplet:` blocks (cross-layer,
   plan mode only): dispatch front end and back end in parallel, then a seam test that waits on
   both. Non-behavioural tasks (config, dependency bumps, copy, pure styling): a single
   delegation, no cycle. Prompts include `## Constitution Rules` and `## Structure Snippet`; add
   `## Design Snippet` for ux-reviewer. Never write all the tests up front.
   implementer-electron, tester-node and ux-reviewer can run TDD cycles in parallel on
   non-overlapping behaviours.
7. **Refactor pass** (optional, only when every behaviour is green): same implementer agent,
   refactor prompt, run tests after each step, commit `refactor:` separately. Skip if already
   clean.
8. **Quality gate**: `npm test`. Everything must pass, pre-existing failures included. After 3
   failures, escalate.
9. **Review**: reviewer agent on `git diff master...HEAD`. Review-fix loop: Critical, fix,
   re-commit, re-gate, re-review (at most 2 cycles).
10. **Exit worktree**: `ExitWorktree(action: "keep")`.
11. **Merge and ship**: merge worktree branch into the work branch, then into master. Check for
    conflicts and verify after each merge; revert master on failure. Then clean up the worktree
    (unlock, remove, `branch -d`) and the work branch.
12. **Escalate** to the user only for architectural decisions or merge conflicts.

## Rules

No hooks enforce these; follow them yourself.

- Agent calls (except Explore, Plan, reviewer, plan-reviewer) run only with an active worktree.
- No Write, Edit or Bash file writes to files in subdirectories without an active worktree.
- Create worktrees only from master or a `work/*` branch.
- Offer a plan review (AskUserQuestion) before ExitPlanMode: the user chooses to finalise or
  review first.
- Do not exit the worktree until the reviewer has run on the latest commit (new commits need a
  re-review) and `npm test` passes with zero failures.

## Direct edits (orchestrator only, no worktree needed)

Root config: CLAUDE.md, README.md, .gitignore, package.json, `.claude/` (including memory), git
operations. Every other file, including one-line fixes: branch, worktree, delegate, commit, gate,
review, exit worktree.

## Agents and tasks

- Agents are one-shot. Spawn a fresh `Agent()` for remaining work. No `isolation` parameter:
  agents inherit the worktree cwd.
- Emit `TaskCreate` at step 3, one per phase: Implement (one per parallel agent), Refactor
  (optional), Quality gate, Review, Merge. Use `addBlockedBy` for ordering. Mark `in_progress` on
  entering each step and `completed` on pass. Never `completed` while tests fail or the reviewer
  flagged Critical. The orchestrator owns tasks; agents do not touch them. Skip for direct edits.
