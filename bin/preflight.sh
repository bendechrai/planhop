#!/usr/bin/env bash
#
# planhop preflight - run every Definition of Done gate locally, before a push.
#
# Hosted CI is manual-trigger only (see ~/Projects/CLAUDE.md, "Gates run
# locally, not in hosted CI"), so the pre-push hook (.githooks/pre-push)
# calls this script for every ref being pushed and refuses the push on a
# failure. Adapted from cal/bin/preflight.sh.
#
# It tests the COMMIT, not the working tree. `git archive` exports the
# commit into a temp dir, so gitignored artefacts - dist/, a stale
# node_modules - cannot mask a failure a fresh checkout would hit.
#
# planhop has no database and no browser suite, so there is no migration
# replay gate and no smoke marker: every gate is fast enough for every push.
#
# Usage:
#   bin/preflight.sh [<commit-ish>] [--only <gate>]
#
#   <commit-ish>    defaults to HEAD
#   --only <gate>   run one gate: install | verify | security.
#                   `install` is a prerequisite of verify, so it still
#                   runs for that (it is quick on a warm store).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ------------------------------------------------------------------
# Images, versions and rule sets, pinned. These are the part of the gates
# most likely to drift, so they live here where a reader looks first.
# ------------------------------------------------------------------
# package.json says node >=20; the old hosted CI matrix ran 20 and 24, so
# verify runs on both. Install runs on the newest.
NODE_VERSIONS=(20 24)
PNPM_VERSION="12.8.1"
OSV_IMAGE="ghcr.io/google/osv-scanner:v2.0.1"
SEMGREP_IMAGE="semgrep/semgrep:latest"
GITLEAKS_IMAGE="zricethezav/gitleaks:latest"
HELPER_IMAGE="alpine:3.22"
# Persistent npm cache and pnpm store, so a warm install takes seconds.
CACHE_VOLUME="planhop-preflight-cache"

SEMGREP_CONFIGS=(
  p/default
  p/typescript
  p/nodejs
  p/owasp-top-ten
  p/secrets
)

BOLD='\033[1m'
CYAN='\033[1;36m'
RED='\033[1;31m'
GRN='\033[1;32m'
DIM='\033[2m'
RST='\033[0m'

banner() { printf '\n%b==> %s%b\n' "$CYAN" "$1" "$RST"; }
note() { printf '    %b%s%b\n' "$DIM" "$1" "$RST"; }
die() { printf '%bpreflight: %s%b\n' "$RED" "$1" "$RST" >&2; exit 2; }

usage() {
  sed -n '3,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# ------------------------------------------------------------------
# Arguments
# ------------------------------------------------------------------
COMMITISH=""
ONLY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --only)
      shift
      [ $# -gt 0 ] || die "--only needs a gate name"
      ONLY="$1"
      ;;
    --only=*) ONLY="${1#--only=}" ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*) die "unknown option: $1" ;;
    *)
      [ -z "$COMMITISH" ] || die "only one commit-ish, got '$COMMITISH' and '$1'"
      COMMITISH="$1"
      ;;
  esac
  shift
done

COMMITISH="${COMMITISH:-HEAD}"

case "$ONLY" in
  "" | install | verify | security) ;;
  *) die "--only takes one of: install verify security" ;;
esac

command -v docker >/dev/null 2>&1 || die "docker is not on PATH"

SHA="$(git rev-parse --verify "${COMMITISH}^{commit}" 2>/dev/null)" ||
  die "not a commit: $COMMITISH"
SHORT="$(git rev-parse --short "$SHA")"

WORK="${TMPDIR:-/tmp}/planhop-preflight-${SHA}"

cleanup() {
  if [ -n "${WORK:-}" ] && [ -d "$WORK" ]; then
    rm -rf "$WORK"
  fi
  return 0
}
trap cleanup EXIT

# ------------------------------------------------------------------
# Gate bookkeeping
# ------------------------------------------------------------------
GATE_NAMES=()
GATE_STATUS=()
GATE_SECONDS=()

record() {
  GATE_NAMES+=("$1")
  GATE_STATUS+=("$2")
  GATE_SECONDS+=("$3")
}

hms() {
  local s="$1"
  printf '%dm%02ds' "$((s / 60))" "$((s % 60))"
}

summary() {
  printf '\n%b%s%b\n' "$BOLD" "Timing summary" "$RST"
  local i
  for i in "${!GATE_NAMES[@]}"; do
    printf '  %-12s %-8s %s\n' \
      "${GATE_NAMES[$i]}" "${GATE_STATUS[$i]}" "$(hms "${GATE_SECONDS[$i]}")"
  done
  printf '  %-12s %-8s %s\n' "TOTAL" "" "$(hms "$((SECONDS - START_TS))")"
}

fail_gate() {
  printf '\n%b%s%b\n' "$RED" "================================================================" "$RST"
  printf '%b  PREFLIGHT FAILED at gate: %s%b\n' "$RED" "$1" "$RST"
  printf '%b  commit %s is NOT safe to push%b\n' "$RED" "$SHORT" "$RST"
  printf '%b%s%b\n' "$RED" "================================================================" "$RST"
  summary
  exit 1
}

wants() {
  if [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; then
    return 0
  fi
  [ "$1" = "install" ] && [ "$ONLY" = "verify" ]
}

run_gate() {
  local name="$1" fn="$2" t0="$SECONDS"
  wants "$name" || return 0
  banner "gate: $name"
  if "$fn"; then
    record "$name" "ok" "$((SECONDS - t0))"
  else
    record "$name" "FAIL" "$((SECONDS - t0))"
    fail_gate "$name"
  fi
}

# ------------------------------------------------------------------
# Container helpers
#
# --user keeps everything the containers write owned by the caller, so the
# temp dir can be removed afterwards; npm and pnpm then need a writable
# HOME, cache and store, which live in the cache volume. The memory cap
# matters: an uncapped vitest run has been OOM-killed on this host.
# ------------------------------------------------------------------
node_run() {
  local node_version="$1"
  docker run --rm --memory 4g \
    --user "$(id -u):$(id -g)" \
    -e HOME=/tmp -e CI=true \
    -e npm_config_cache=/cache/npm \
    -e npm_config_store_dir=/cache/pnpm-store \
    -v "${WORK}:/app" -v "${CACHE_VOLUME}:/cache" \
    -w /app "node:${node_version}-bookworm" bash -euo pipefail -c "$2"
}

pnpm_cmd() {
  printf 'npx --yes pnpm@%s' "$PNPM_VERSION"
}

# ------------------------------------------------------------------
# Gates
# ------------------------------------------------------------------
gate_install() {
  docker volume create "$CACHE_VOLUME" >/dev/null || return 1
  docker run --rm -v "${CACHE_VOLUME}:/cache" "$HELPER_IMAGE" \
    chown "$(id -u):$(id -g)" /cache || return 1

  # --ignore-scripts blocks post-install shell exec, the commonest
  # supply-chain vector. planhop has no dependency that needs a build step.
  node_run "${NODE_VERSIONS[-1]}" "$(pnpm_cmd) install --frozen-lockfile --ignore-scripts" || return 1
}

gate_verify() {
  local before after v
  before="$(sha256sum "${WORK}/docs/choose.js" | cut -c1-64)" || return 1
  for v in "${NODE_VERSIONS[@]}"; do
    banner "  node ${v}: lint, typecheck, test, audit"
    node_run "$v" "$(pnpm_cmd) run verify" || return 1
  done

  # The test setup regenerates docs/choose.js from src/choose.ts; the
  # marketing page's simulator must not drift from the tool it describes.
  after="$(sha256sum "${WORK}/docs/choose.js" | cut -c1-64)" || return 1
  if [ "$before" != "$after" ]; then
    echo "docs/choose.js is stale: run 'pnpm run docs' and commit the result." >&2
    return 1
  fi
  note "docs/choose.js matches src/choose.ts"
}

gate_security() {
  banner "  gitleaks"
  if command -v gitleaks >/dev/null 2>&1; then
    gitleaks dir "$WORK" --redact --no-banner || return 1
  else
    docker run --rm -v "${WORK}:/src:ro" "$GITLEAKS_IMAGE" \
      dir /src --redact --no-banner || return 1
  fi

  banner "  osv-scanner"
  docker run --rm -v "${WORK}:/src:ro" "$OSV_IMAGE" \
    --lockfile=/src/pnpm-lock.yaml || return 1

  # ERROR severity is DEFINITION_OF_DONE.md gate 4's "no HIGH severity
  # findings". Drop --severity to see WARNING and INFO findings too.
  banner "  semgrep"
  local args=() cfg
  for cfg in "${SEMGREP_CONFIGS[@]}"; do
    args+=(--config "$cfg")
  done
  docker run --rm -v "${WORK}:/src:ro" -w /src "$SEMGREP_IMAGE" \
    semgrep scan --metrics=off --quiet --error --severity ERROR \
    --exclude node_modules --exclude dist \
    "${args[@]}" /src || return 1
}

# ------------------------------------------------------------------
# Run
# ------------------------------------------------------------------
START_TS="$SECONDS"

printf '%bplanhop preflight%b  commit %s\n' "$BOLD" "$RST" "$SHORT"
printf '  archive: %s\n' "$WORK"

banner "gate: archive"
ARCHIVE_T0="$SECONDS"
rm -rf "$WORK"
mkdir -p "$WORK"
git archive "$SHA" | tar -x -C "$WORK"
[ -f "${WORK}/package.json" ] || die "the archive has no package.json - wrong commit?"
! [ -e "${WORK}/node_modules" ] || die "node_modules is committed; preflight assumes it is not"
! [ -e "${WORK}/dist" ] || die "dist/ is committed; preflight assumes it is built"
note "exported, no node_modules / dist"
record "archive" "ok" "$((SECONDS - ARCHIVE_T0))"

run_gate install gate_install
run_gate verify gate_verify
run_gate security gate_security

printf '\n%b%s%b\n' "$GRN" "================================================================" "$RST"
printf '%b  PREFLIGHT PASSED - %s is safe to push%b\n' "$GRN" "$SHORT" "$RST"
printf '%b%s%b\n' "$GRN" "================================================================" "$RST"
summary
