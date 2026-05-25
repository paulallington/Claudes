#!/usr/bin/env bash
set -e

# Release script for Claudes (single fork — mdrichardson/Claudes)
# Usage: ./release.sh [personal|patch|minor|major|x.y.z|x.y.z-personal.N]
# Default: personal (bumps the -personal.N suffix)
#
# Version scheme: X.Y.Z-personal.N
#   - Avoids colliding with upstream paulallington/Claudes tags
#   - `personal` bumps N (or starts at .1 if missing)
#   - `patch|minor|major` strip the suffix, bump the numeric part, reset to -personal.1
#   - Explicit X.Y.Z or X.Y.Z-personal.N is used as-is
#
# Pushes the master branch and the new tag to origin.
# GitHub Actions builds the Windows + macOS installers and creates the Release.

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "master" ]; then
  echo "ERROR: release.sh must be run from the 'master' branch."
  echo "       Current branch: ${BRANCH}"
  echo "       Run: git checkout master"
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: working tree has uncommitted changes."
  echo "       Commit or stash changes first, then rerun."
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "ERROR: git remote 'origin' is not configured."
  exit 1
fi

CURRENT=$(node -p "require('./package.json').version")
ARG="${1:-personal}"

# Split CURRENT into BASE (X.Y.Z) and PERSONAL_N (integer or empty).
if echo "$CURRENT" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+-personal\.[0-9]+$'; then
  BASE="${CURRENT%-personal.*}"
  PERSONAL_N="${CURRENT##*-personal.}"
elif echo "$CURRENT" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  BASE="$CURRENT"
  PERSONAL_N=""
else
  echo "ERROR: current package.json version '${CURRENT}' is not of the form X.Y.Z or X.Y.Z-personal.N"
  exit 1
fi

IFS='.' read -r MAJOR MINOR PATCH <<< "$BASE"

case "$ARG" in
  personal)
    if [ -z "$PERSONAL_N" ]; then
      VERSION="${BASE}-personal.1"
    else
      VERSION="${BASE}-personal.$((PERSONAL_N + 1))"
    fi
    ;;
  major)
    VERSION="$((MAJOR + 1)).0.0-personal.1"
    ;;
  minor)
    VERSION="${MAJOR}.$((MINOR + 1)).0-personal.1"
    ;;
  patch)
    VERSION="${MAJOR}.${MINOR}.$((PATCH + 1))-personal.1"
    ;;
  *)
    if echo "$ARG" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-personal\.[0-9]+)?$'; then
      VERSION="$ARG"
    else
      echo "Usage: ./release.sh [personal|patch|minor|major|x.y.z|x.y.z-personal.N]"
      echo "Current version: ${CURRENT}"
      exit 1
    fi
    ;;
esac

echo "==> Releasing Claudes v${VERSION} (was v${CURRENT})"

if git rev-parse -q --verify "refs/tags/v${VERSION}" >/dev/null; then
  echo "ERROR: tag v${VERSION} already exists locally. Aborting before mutation."
  echo "       Pick a different version or delete the existing tag first:"
  echo "         git tag -d v${VERSION}"
  exit 1
fi

# Update version in package.json (preserves trailing newline).
node -e "
  const pkg = require('./package.json');
  pkg.version = '${VERSION}';
  require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
git add package.json
echo "==> Updated package.json to v${VERSION}"

git commit -m "v${VERSION}"
git tag "v${VERSION}"
echo "==> Committed and tagged v${VERSION}"

if ! git push origin master; then
  echo ""
  echo "ERROR: push of master to origin failed."
  echo "       Commit and tag v${VERSION} are on your local master."
  echo "       Once the push issue is resolved, run manually:"
  echo "         git push origin master"
  echo "         git push origin v${VERSION}"
  exit 1
fi
if ! git push origin "v${VERSION}"; then
  echo ""
  echo "ERROR: tag push failed, but master pushed."
  echo "       Run manually: git push origin v${VERSION}"
  exit 1
fi
echo "==> Pushed master and v${VERSION} to origin"

echo ""
echo "==> Tag v${VERSION} pushed to mdrichardson/Claudes."
echo "    GitHub Actions will build Windows + macOS installers and create the release:"
echo "      https://github.com/mdrichardson/Claudes/actions"
echo "    Release URL: https://github.com/mdrichardson/Claudes/releases/tag/v${VERSION}"
