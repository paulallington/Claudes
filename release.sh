#!/usr/bin/env bash
set -e

# Release script for Claudes
# Usage: ./release.sh [major|minor|patch|x.y.z]
# Default: patch bump

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

# Update version in package.json
node -e "
  const pkg = require('./package.json');
  pkg.version = '${VERSION}';
  require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
echo "==> Updated package.json to v${VERSION}"

# Commit and tag
git add package.json
git commit -m "v${VERSION}"
git tag "v${VERSION}"
echo "==> Committed and tagged v${VERSION}"

# Push
git push
git push --tags
echo "==> Pushed to origin"

# Build installer
echo "==> Building installer..."
npx electron-builder --win
echo "==> Build complete"

# Create GitHub release and upload artifacts
INSTALLER="dist/Claudes-Setup-${VERSION}.exe"
BLOCKMAP="dist/Claudes-Setup-${VERSION}.exe.blockmap"
LATEST_YML="dist/latest.yml"

echo "==> Creating GitHub release v${VERSION}..."
gh release create "v${VERSION}" \
  --title "Claudes v${VERSION}" \
  --generate-notes \
  "$INSTALLER" \
  "$BLOCKMAP" \
  "$LATEST_YML"

echo ""
echo "==> Released Claudes v${VERSION}"
echo "    https://github.com/paulallington/Claudes/releases/tag/v${VERSION}"
