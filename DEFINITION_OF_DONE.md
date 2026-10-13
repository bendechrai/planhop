# Definition of Done

planhop's copy of the `~/Projects/DEFINITION_OF_DONE.md` template,
with this project's commands. planhop is a Node/TypeScript CLI built
with pnpm: no database, no server, and no rendered app beyond the
static marketing page in `docs/`.

This is the checklist to run before claiming any task complete. A task
is done when the change is proven safe to merge under the rules below.
If the task genuinely doesn't need one of the gates, say so in the
completion summary rather than silently skipping it.

## Gates

All must pass or be explicitly waived with a reason.

### 1. Code compiles cleanly
- `pnpm run typecheck` returns 0 errors.
- `pnpm run lint` returns 0 errors AND 0 warnings. Preexisting
  warnings get fixed as part of the change that trips them.
- No new use of `any`, `@ts-ignore`, or `eslint-disable` without a
  one-line comment naming the specific reason.

Always write `pnpm run <script>`, never `pnpm <script>`: pnpm 12 has
built-in commands (such as `pnpm docs`) that shadow scripts of the
same name.

### 2. Tests pass
- `pnpm run test` returns 0 failures, on Node 20 and 24 (`engines`
  says `>=20`; preflight runs both).
- Preexisting failures are NOT a waiver - they get fixed before
  claiming done, or get an explicit follow-up item flagged in the
  summary.
- New behaviour has at least one test that would have caught the bug
  the change fixes, or the feature the change adds.
- `docs/choose.js` is regenerated from `src/choose.ts` by the test
  setup and must match the committed copy, so the page's simulator
  never drifts from the tool.

### 3. UI works on desktop AND mobile
Not applicable to the CLI. The marketing page (`docs/index.html`) has
no Playwright suite; a change to it is checked by hand at desktop and
phone widths (`pnpm run docs:serve`) and reported as such in the
summary.

### 4. No secrets, no vulnerable deps, no risky patterns
- `gitleaks` finds no secrets.
- `osv-scanner` reports no unfixable HIGH/CRITICAL CVEs in
  `pnpm-lock.yaml`.
- `pnpm audit --audit-level high` passes (the end of `pnpm run verify`).
- `semgrep` reports no ERROR severity findings.

### 5. Migrations and data
Not applicable: planhop has no database.

### 6. Docs and comments
- README changed if the change alters how someone installs, sets up
  or uses planhop, or how a contributor works on it.
- Code comments only explain the WHY.

### 7. Commit hygiene
- Commit messages describe the WHY not the WHAT.
- No attribution lines.
- No `--no-verify` unless explicitly agreed.

## How the gates run

Install the hooks once per clone with `bin/setup-git-hooks.sh`.

- **pre-commit** (`.githooks/pre-commit`): gitleaks on the staged
  diff, then `pnpm run verify` (lint + typecheck + tests + audit) on
  the working tree.
- **pre-push** (`.githooks/pre-push`): `bin/preflight.sh <commit>`
  for every ref pushed. It exports the commit with `git archive` and
  runs, in Docker: install (`pnpm install --frozen-lockfile
  --ignore-scripts`), verify on Node 20 and 24 plus the
  `docs/choose.js` drift check, and security (gitleaks, osv-scanner,
  semgrep). Run it by hand with `bin/preflight.sh HEAD`.

There is no slow suite, so there is no certification marker: every
gate runs on every push. A successful push is the proof of green.

Hosted CI (`.github/workflows/ci.yml`) is manual-trigger only. It is
the one place macOS is tested, so trigger it by hand before a release
that touches platform-specific code (credentials, paths, the shim,
the terminal prompt). `.github/workflows/release.yml` still runs on a
`v*` tag push, because npm Trusted Publishing has to publish from
GitHub Actions.

## Waivers

If a gate is being skipped, the completion summary MUST include a
line like:

    Waived: <gate name> - <reason>

Never quietly skip.
