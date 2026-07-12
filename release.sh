#!/usr/bin/env bash
set -e

# Release script for Claudes
# Usage: ./release.sh [major|minor|patch|x.y.z]
# Default: patch bump
#
# This bumps the version, commits, tags, and pushes.
# GitHub Actions builds Windows + macOS + Linux installers and creates the release.
# For local-only builds, use: npm run dist:win, dist:mac, or dist:linux

CURRENT=$(node -p "require('./package.json').version")
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

ARG="${1:-patch}"

case "$ARG" in
  major) VERSION="$((MAJOR + 1)).0.0" ;;
  minor) VERSION="${MAJOR}.$((MINOR + 1)).0" ;;
  patch) VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))" ;;
  *)
    if echo "$ARG" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
      VERSION="$ARG"
    else
      echo "Usage: ./release.sh [major|minor|patch|x.y.z]"
      echo "Current version: $CURRENT"
      exit 1
    fi
    ;;
esac

echo "==> Releasing Claudes v${VERSION} (was v${CURRENT})"

# Refuse to run on a dirty tree — commit or stash first.
# (The /release slash command commits outstanding changes before calling this script.)
CHANGES=$(git status --porcelain)
if [ -n "$CHANGES" ]; then
  echo "ERROR: working tree is dirty. Commit or stash your changes before releasing." >&2
  echo "$CHANGES" >&2
  exit 1
fi

echo "==> Running tests..."
npm test

# Update version in package.json
node -e "
  const pkg = require('./package.json');
  pkg.version = '${VERSION}';
  require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
git add package.json
echo "==> Updated package.json to v${VERSION}"

# Commit
git commit -m "v${VERSION}"
echo "==> Committed v${VERSION}"

# Push the branch first, then tag — a failed branch push never leaves an orphan tag.
git push
echo "==> Pushed branch to origin"

git tag "v${VERSION}"
git push origin "v${VERSION}" || { git tag -d "v${VERSION}"; echo "ERROR: failed to push tag v${VERSION}; local tag removed." >&2; exit 1; }
echo "==> Tagged and pushed v${VERSION}"

echo ""
echo "==> Tag v${VERSION} pushed. GitHub Actions will build and release for Windows + macOS + Linux."
echo "    Watch progress: https://github.com/paulallington/Claudes/actions"
echo "    Release will appear at: https://github.com/paulallington/Claudes/releases/tag/v${VERSION}"
