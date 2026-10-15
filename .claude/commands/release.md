Release a new version of Claudes.

Steps:
1. Run `git status` and `git diff --stat` to see all outstanding changes
2. Stage ALL outstanding changes (tracked and untracked, excluding node_modules/ and dist/) with `git add -A`
3. Commit with message summarising the changes
4. Run `./release.sh $ARGUMENTS`, which runs `npm test`, bumps the version, commits, pushes, then tags and pushes the tag. If $ARGUMENTS is empty, it defaults to a patch bump. The tag push starts `.github/workflows/release.yml`, which builds the Windows, macOS and Linux installers and creates the GitHub Release; the release does not exist until that workflow finishes (https://github.com/paulallington/Claudes/actions).
5. Run `node stats.js` to show current download stats before reporting the release
6. Report the Actions run URL and the release URL (https://github.com/paulallington/Claudes/releases/tag/v<version>)

$ARGUMENTS is optional. Accepts: `major`, `minor`, `patch` (default), or an explicit version like `2.1.0`.
