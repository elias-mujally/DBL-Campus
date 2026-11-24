#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: bash scripts/release-mobile.sh <MAJOR.MINOR.PATCH>" >&2
  exit 1
fi

VERSION="$1"
IFS='.' read -r MAJ MIN PAT <<< "$VERSION"
VERSION_CODE=$((10#$MAJ * 10000 + 10#$MIN * 100 + 10#$PAT))
TAG="v${VERSION}"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Error: tag $TAG already exists." >&2
  exit 1
fi

node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.version = process.argv[1];
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
' "$VERSION"

sed -i.bak -E "s/dblVersionCode[^\)]*\)/dblVersionCode') ? project.property('dblVersionCode').toInteger() : ${VERSION_CODE})/; s/dblVersionName[^\)]*\)/dblVersionName') ? project.property('dblVersionName').toString() : \"${VERSION}\")/" android/app/build.gradle
rm -f android/app/build.gradle.bak

sed -i.bak -E "s/MARKETING_VERSION = [0-9]+\.[0-9]+\.[0-9]+;/MARKETING_VERSION = ${VERSION};/g; s/CURRENT_PROJECT_VERSION = [0-9]+;/CURRENT_PROJECT_VERSION = ${VERSION_CODE};/g" ios/App/App.xcodeproj/project.pbxproj
rm -f ios/App/App.xcodeproj/project.pbxproj.bak

git add package.json android/app/build.gradle ios/App/App.xcodeproj/project.pbxproj
git commit -m "release: bump mobile apps to ${TAG} (${VERSION_CODE})"
git tag -a "$TAG" -m "Release DBL Campus Mobile ${TAG}"

echo "Prepared ${TAG} (versionCode ${VERSION_CODE})."
echo "Push to trigger automated GitHub Actions build & release:"
echo "  git push origin main --follow-tags"
