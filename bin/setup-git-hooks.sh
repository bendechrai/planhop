#!/usr/bin/env bash
# One-shot setup: point git at .githooks/ so the pre-commit and pre-push
# hooks run.
#
# Idempotent - safe to run repeatedly. Each clone of this repo needs
# to run it once because core.hooksPath lives in .git/config, which
# git deliberately does not check into the repo.

set -euo pipefail

cd "$(dirname "$0")/.."

git config core.hooksPath .githooks
chmod +x .githooks/* bin/*.sh

echo "core.hooksPath -> .githooks"
echo "hooks marked executable"
echo
echo "  pre-commit  gitleaks on the staged diff, then 'pnpm run verify'."
echo "  pre-push    bin/preflight.sh for every ref being pushed: every"
echo "              gate, against the commit rather than the working"
echo "              tree. Hosted CI is manual-trigger only."
echo
echo "Test them without committing or pushing:"
echo "    .githooks/pre-commit"
echo "    bin/preflight.sh HEAD"
