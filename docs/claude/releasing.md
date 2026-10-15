# Releasing and auto-update

## Release

`/release [major|minor|patch|x.y.z]` (default patch) commits outstanding changes, then runs
`./release.sh` (which can also be run by hand):

1. Refuses to run on a dirty tree.
2. Runs `npm test` and aborts on failure.
3. Bumps `package.json`, commits `v<version>`, pushes the branch, then tags and pushes the tag.

The tag push triggers `.github/workflows/release.yml`, which runs `npm test` again, builds the
Windows (NSIS), macOS (dmg/zip, with `.sha256` files) and Linux (AppImage/deb) installers, and
creates the GitHub Release with generated notes. The installers do not exist until that workflow
finishes: watch https://github.com/paulallington/Claudes/actions.

For a local build only: `npm run dist:win`, `dist:mac` or `dist:linux`.

## Auto-update

- **Windows and Linux** use `electron-updater` against the GitHub Release (NSIS blockmaps plus
  `latest.yml`, SHA512-verified).
- **macOS** uses a custom GitHub-polling updater (`darwinCheckForUpdates` in `main.js`).
  Squirrel.Mac refuses to apply unsigned updates and the builds are unsigned, so the updater
  downloads the `-mac-<arch>.dmg` release asset directly and opens it. That path does no checksum
  or signature verification (tracked in `EVALUATION-TASKS.md`).
