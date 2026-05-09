#!/usr/bin/env bash
set -e

# Release script for Claudes
# Usage: ./release.sh [major|minor|patch|x.y.z]
# Default: patch bump
#
# This bumps the version, commits, tags, and pushes.
# GitHub Actions builds Windows + macOS installers and creates the release.
# For local-only builds, use: npm run dist:win or npm run dist:mac

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

# Stage all outstanding changes first
CHANGES=$(git status --porcelain)
if [ -n "$CHANGES" ]; then
  echo "==> Staging outstanding changes..."
  git add -A
fi

# Update version in package.json
node -e "
  const pkg = require('./package.json');
  pkg.version = '${VERSION}';
  require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
git add package.json
echo "==> Updated package.json to v${VERSION}"

# Commit and tag
git commit -m "v${VERSION}"
git tag "v${VERSION}"
echo "==> Committed and tagged v${VERSION}"

# Push
git push
git push --tags
echo "==> Pushed to origin"

echo ""
echo "==> Tag v${VERSION} pushed. GitHub Actions will build and release for Windows + macOS."
echo "    Watch progress: https://github.com/paulallington/Claudes/actions"
echo "    Release will appear at: https://github.com/paulallington/Claudes/releases/tag/v${VERSION}"
