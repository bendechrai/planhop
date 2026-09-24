import { SHIM_MARKER } from "./realbin.js";

/** First line of `planhop pick` output; the shim only evals output that starts with it. */
export const PICK_HEADER = "# planhop-pick";

/** POSIX single-quote a string for safe use in shell code. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Shell code the shim evals: the real binary, the config dir (or unset for the
 * default account) and PLANHOP_ACTIVE so nested launches stay on this account.
 */
export function pickShell(real: string, pick: { dir?: string; name?: string; isDefault: boolean }): string {
  const lines = [PICK_HEADER, `PLANHOP_REAL_CLAUDE=${shellQuote(real)}`];
  if (pick.dir !== undefined) {
    lines.push(pick.isDefault ? "unset CLAUDE_CONFIG_DIR" : `export CLAUDE_CONFIG_DIR=${shellQuote(pick.dir)}`);
  }
  if (pick.name !== undefined) lines.push(`export PLANHOP_ACTIVE=${shellQuote(pick.name)}`);
  return lines.join("\n");
}

export function shimScript(): string {
  return `#!/bin/sh
# ${SHIM_MARKER}: runs Claude Code on the account planhop picks. Delete this file to stop.
out=$(planhop pick -- "$@") || exit $?
case "$out" in
  "${PICK_HEADER}"*) eval "$out" ;;
  *) echo "planhop: unexpected output from 'planhop pick'; not running it" >&2; exit 1 ;;
esac
exec "$PLANHOP_REAL_CLAUDE" "$@"
`;
}
