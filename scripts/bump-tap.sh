#!/usr/bin/env bash
# Point the Homebrew formula at the published npm version and commit it.
# Usage: scripts/bump-tap.sh [version]   (default: version in package.json)
# TAP_DIR defaults to ~/Projects/homebrew-tap.
set -euo pipefail
version="${1:-$(node -p 'require("./package.json").version')}"
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  echo "not a version: $version" >&2
  exit 1
fi
tap="${TAP_DIR:-$HOME/Projects/homebrew-tap}"
formula="$tap/Formula/planhop.rb"
url="https://registry.npmjs.org/planhop/-/planhop-$version.tgz"

tarball=$(mktemp)
trap 'rm -f "$tarball"' EXIT
if ! curl -fsSL "$url" -o "$tarball" || [ ! -s "$tarball" ]; then
  echo "couldn't download $url - is $version published?" >&2
  exit 1
fi
sha=$(shasum -a 256 "$tarball" | cut -d' ' -f1)
sed -i.bak -e "s|^  url \".*\"|  url \"$url\"|" -e "s|^  sha256 \".*\"|  sha256 \"$sha\"|" "$formula"
rm -f "$formula.bak"
git -C "$tap" add Formula/planhop.rb
git -C "$tap" commit -q -m "Bump planhop formula to v$version"
echo "Committed planhop v$version ($sha) in $tap. Push with: git -C $tap push"
