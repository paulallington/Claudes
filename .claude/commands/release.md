Release a new version of Claudes.

Steps:
1. Run `git status` and `git diff --stat` to see all outstanding changes
2. Stage ALL outstanding changes (tracked and untracked, excluding node_modules/ and dist/) with `git add -A`
3. Commit with message summarising the changes
4. Run `./release.sh $ARGUMENTS` which bumps the version, commits, tags, pushes, builds the NSIS installer, and creates the GitHub Release with artifacts. If $ARGUMENTS is empty, it defaults to a patch bump.
5. Run `node stats.js` to show current download stats before reporting the release
6. Report the release URL when done

$ARGUMENTS is optional. Accepts: `major`, `minor`, `patch` (default), or an explicit version like `2.1.0`.
