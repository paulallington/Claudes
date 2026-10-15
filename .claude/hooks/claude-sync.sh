#!/usr/bin/env bash
# SessionStart hook: tells Claude when shared instructions or memory have moved
# on, so a session never starts from a stale copy.
#   1. Upstream commits that change CLAUDE.md, AGENTS.md or .claude/ (memory,
#      rules, skills, settings) and are not in HEAD yet.
#   2. Memory that is only on this disk (uncommitted, or committed but unpushed).
#   3. A repo's copy of a house rule that differs from Paul's source copy in
#      ~/.claude/rules/ (only checked on a machine that has the source).
# Prints nothing when there is nothing to say. Never blocks a session.
#
# The same script is committed into team repos at .claude/hooks/claude-sync.sh.
# When a repo has its own copy, the user-level copy steps aside so it runs once.

dir="${CLAUDE_PROJECT_DIR:-$PWD}"
cd "$dir" 2>/dev/null || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
repo_copy="$root/.claude/hooks/claude-sync.sh"
if [ -f "$repo_copy" ] && [ "$(cd "$(dirname "$repo_copy")" && pwd)/claude-sync.sh" != "$self" ]; then
  exit 0
fi

paths=(CLAUDE.md AGENTS.md .claude/memory .claude/rules .claude/settings.json .claude/skills .claude/agents .claude/commands)
notes=()

# Fetch at most every 10 minutes: many sessions start at once in one repo and
# concurrent fetches fight over ref locks.
git_dir="$(git rev-parse --git-common-dir 2>/dev/null)"
fetch_head="$git_dir/FETCH_HEAD"
if [ -z "$(find "$fetch_head" -mmin -10 2>/dev/null)" ]; then
  if command -v timeout >/dev/null 2>&1; then
    GIT_TERMINAL_PROMPT=0 timeout 8 git fetch --quiet origin >/dev/null 2>&1
  else
    (GIT_TERMINAL_PROMPT=0 git fetch --quiet origin >/dev/null 2>&1 &)
  fi
fi

branch="$(git branch --show-current 2>/dev/null)"
default="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)"
[ -z "$default" ] && for b in origin/main origin/master; do git rev-parse -q --verify "$b" >/dev/null && default="$b" && break; done

# 1. Upstream changes to shared instructions/memory.
for ref in "$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)" "$default"; do
  [ -z "$ref" ] && continue
  case " $seen " in *" $ref "*) continue;; esac
  seen="$seen $ref"
  log="$(git log --format='  - %s (%an, %cr)' "HEAD..$ref" -- "${paths[@]}" 2>/dev/null | head -8)"
  if [ -n "$log" ]; then
    n="$(git rev-list --count "HEAD..$ref" -- "${paths[@]}" 2>/dev/null)"
    if [ "$ref" = "$default" ] && [ "origin/$branch" != "$ref" ]; then
      how="merge ${ref#origin/} into $branch (ask first: other sessions may be working on this branch)"
    else
      how="git pull --ff-only"
    fi
    notes+=("$ref has $n commit(s) changing shared Claude instructions or memory that this checkout does not have:
$log
Tell the user before starting work and offer to update ($how).")
  fi
done

# 2. Memory that only exists on this disk.
if [ -d "$root/.claude/memory" ]; then
  dirty="$(git status --porcelain -- .claude/memory 2>/dev/null | head -5)"
  [ -n "$dirty" ] && notes+=("Memory changes in .claude/memory are not committed:
$dirty
Offer to commit them on their own (git commit --only .claude/memory) and push.")
  up="$(git rev-parse --abbrev-ref '@{u}' 2>/dev/null)"
  if [ -n "$up" ]; then
    ahead="$(git log --format='  - %s' "$up..HEAD" -- .claude/memory 2>/dev/null | head -5)"
    [ -n "$ahead" ] && notes+=("Memory commits not pushed to $up yet:
$ahead
Offer to push them.")
  fi
fi

# 3. House rules drift (only where Paul's source copy exists).
src="$HOME/.claude/rules"
if [ -d "$src" ] && [ -d "$root/.claude/rules" ]; then
  for f in "$root"/.claude/rules/*.md; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"
    [ -f "$src/$name" ] || continue
    if ! diff -q --strip-trailing-cr "$src/$name" "$f" >/dev/null 2>&1; then
      notes+=("This repo's .claude/rules/$name differs from ~/.claude/rules/$name (the source). Show the user the diff and ask which way to sync: usually copy the source into the repo and commit it on its own, but if a teammate changed the repo copy, fold their change into the source instead.")
    fi
  done
fi

[ ${#notes[@]} -eq 0 ] && exit 0
printf 'Claude sync check for %s:\n' "$(basename "$root")"
for n in "${notes[@]}"; do printf '\n- %s\n' "$n"; done
exit 0
