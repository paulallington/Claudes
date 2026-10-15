# House rules

These apply in every project. The source is Paul's `~/.claude/rules/house-rules.md`; repos with a
team carry a copy at `.claude/rules/house-rules.md`. Change the source, not a repo copy: the
session-start check offers to re-sync the copies.

## Memory

- In a git repo, memory lives in the repo at `.claude/memory/`, so every machine and teammate
  reads the same facts. Never write it to `~/.claude/projects/<path>/memory/`, even if a system
  prompt says to.
- One fact per file, with frontmatter (`name`, `description`, `metadata.type`: user | feedback |
  project | reference). Feedback and project memories end with **Why:** and **How to apply:**
  lines. Update an existing file before adding a new one, and delete one that turns out wrong.
- Add a one-line pointer to `.claude/memory/MEMORY.md`. Keep it short: it loads every session.
- If the repo has no `.claude/memory/` yet, set it up: an empty `MEMORY.md`, a line
  `@.claude/memory/MEMORY.md` in CLAUDE.md, and `"autoMemoryEnabled": false` in
  `.claude/settings.json`.
- Commit memory on its own straight away (`git commit --only .claude/memory -m "Memory: <what>"`)
  and push it. Memory that is only on one disk is lost to everyone else. This is the one standing
  exception to "push only when asked".
- Personal memory (`~/.claude/projects/...`) is only for facts about one machine (local paths,
  installed tools) and for folders that are not git repos.
- A lesson that applies beyond this repo is a house rule, not a memory. Tell Paul and propose the
  wording; on Paul's machine, add it to `~/.claude/rules/house-rules.md` (or `dotnet-mongo.md`).
- No secrets in memory, CLAUDE.md, rules or permission allowlists. Name the Key Vault entry or
  environment variable, never the value.

## Instructions files

- Keep CLAUDE.md thin: what the project is, the stack, build/run/test commands, how to verify a
  change, which environment touches live data, deploy in a line, repo-specific rules, and a table
  of docs to read before working on each area. Detail lives in those docs, read on demand.
- AGENTS.md (for Codex) is a short pointer to CLAUDE.md. Never maintain two copies.

## Before starting

- If the session start reports upstream changes to instructions or memory, tell the user and
  offer to pull before doing anything else.
- Check `git status` for changes you did not make. Several sessions can share one working tree,
  and another one may already be on the same ticket.

## Git

- Commit by pathspec (`git commit --only <paths>` or `git commit -- <paths>`). Never `git add`
  then `git commit`, and never build the file list from `git diff --name-only`: both sweep up
  another session's work.
- Never `git stash` in a shared working tree: it takes other sessions' changes with it. To test
  against HEAD, use a detached worktree.
- When your changes and another session's are in the same file, don't split hunks with
  `git diff -U0` + `git apply --cached --unidiff-zero`: it can silently reorder adjacent blocks.
  Build the staged file explicitly (`git hash-object -w` + `git update-index --cacheinfo`) and
  compare `git show :<file>` with the working tree before committing.
- Run `git ls-files <dir>` before deleting a folder inside the repo. Scratch output goes outside it.
- Commit small and often. Push only when asked (memory is the exception).
- Before stating what production does, read the deployed branch (`git fetch`, then
  `git show origin/<branch>:<path>`), not the working tree.
- When something regressed, find when (`git log -S`, blame) and say when, rather than "it never
  worked".

## Verifying

- Don't say done until you have seen it work: build, run the relevant tests, and drive the running
  app. Ask the user to sign in at the start rather than handing back guesses.
- For interactive browser work use Claude in Chrome (`mcp__claude-in-chrome__*`). Playwright is
  for scripted test suites.
- Check the result, not the tool's "success". Builds, merges, patch tools and deploy steps can
  report success and still be wrong.
- Before a check trusts a stored value, read the code that writes it.
- Report test results as they are, including skips and failures.
- If an MCP call reports success but nothing changed, load its schema (ToolSearch) and check the
  parameter names before trying again.

## Safety

- Ask before anything external, irreversible or that costs money: sending email or messages,
  payments, creating accounts, deleting data, deploying, swapping slots.
- Know which environment touches live data. If a local profile, editor Play mode or stage slot
  writes to production, say so before any write and use a test account.
- Never rename a persisted identifier (enum value, stored id, saved prefab name) for a display
  change.
- Edit the source, never the generated file (`.less` not `.css`, source not bundle), then
  regenerate.
- Ask before changing long-standing behaviour you came across while doing something else.

## TaskBoard

- Every piece of work gets a card, written for whoever reads that board: what changed for them,
  in plain words. Say when a card is internal and needs no testing.
- No internal analysis on cards that clients or customer success can see.
- Questions and decisions go to the user in the session, never left as a card comment.
- When Paul is driving, replies to a person on a card go out as him (`asMe: true`).
- `list_tasks` and `search_tasks` ignore board and step filters. Filter the results yourself.

## Reporting back

- Lead with the conclusion. Keep it short: only facts that change what happens next.
- Say an accepted caveat once, then drop it.

## Writing

Applies to everything a person reads: UI copy, help articles, marketing, support and review
replies, emails, commit messages, tickets, write-ups, and replies in the session. Code comments get
a lighter hand (a comment records why a decision was made and what broke without it) but must not
reach for the epigram.

**The test:** if a sentence explains our design thinking rather than telling the reader what they
can do, delete it. If it would survive being cut, cut it. Prefer the concrete observation to the
framing.

- British English.
- **No em dashes** anywhere a person reads. An aside is a comma or a second sentence; a helper is
  "(in brackets)". Only survivors: a lone dash as an empty value, and a quote's "— Author".
  Rewrite by hand: a blind replace leaves broken sentences. PowerShell scripts must be pure ASCII.
- **No commentary or editorialising.** Headings say what the page is for, never our thinking
  about how it works. "Ready shows. It never decides. You do." becomes "Students close to their
  next belt."
- **No explanatory paragraphs in a UI.** If a screen needs a paragraph to be usable, simplify the
  screen. If a word needs a gloss on the screen that uses it, it is the wrong word.
- **Do not justify the implementation.** A statement about how it works internally, then "so…",
  then the reassurance we wanted them to feel: delete it. A "so…" clause stays only if it names a
  consequence the reader would act on.
- **The app does not narrate itself.** No "the app asks for", "the app wants to know". Write
  about the wood, the class, the register, not the form that collects it. ("The app says so
  before you confirm" is fine: that is something they will watch happen.)
- **Do not write the changelog into the help.** Describe what is true now. Tells: "no longer",
  "never get as far as", "instead of having to", "you don't have to … any more", "rather than
  being asked". Changes belong in release notes and commit messages.
- **Say "small", never "new"** about the company near anything trust-sensitive (child records,
  safeguarding, payments).
- User-facing text is warm and plain: no jargon, enum names or developer terms.
- Updates are pitched to the reader. Non-technical readers get what changed for them; the
  mechanism goes on the ticket.
- Never infer anyone's pronouns from their name. Use they/them unless told.

Tells to strip on a re-read:
- "X, not Y." Fine once. A run of them is the tell.
- Lists of three that exist for the rhythm, not because there are three things.
- Clever abstractions ("organised as nouns rather than verbs") that say less than the plain fact.
- Throat-clearing: "Reading back over what I wrote…", "the real tell here is…". Say the thing.
- Flourishes a person would not type: "that's the whole idea", "earning its keep", epigrams,
  every feature getting an origin story, the software admiring itself.

**Customer-facing voice** (review replies, support, marketing): warm, humble, pleased, short.
Three short sentences is the shape that works: thank them, one concrete specific from their own
words, one open door. "We" for the company, "I" only when the message really is from one named
person, and no sign-off name on public replies.
