import { accessSync, closeSync, constants, openSync, readSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { home, type Env } from "./paths.js";

export const SHIM_MARKER = "planhop-shim";

function isExecutableFile(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isShim(p: string): boolean {
  try {
    const fd = openSync(p, "r");
    const buf = Buffer.alloc(512);
    const n = readSync(fd, buf, 0, 512, 0);
    closeSync(fd);
    return buf.subarray(0, n).toString("utf8").includes(SHIM_MARKER);
  } catch {
    return false;
  }
}

/**
 * The real Claude Code binary: $PLANHOP_CLAUDE_BIN, else the first `claude` on
 * PATH that isn't a planhop shim, else the native installer's usual locations.
 */
export function findRealClaude(env: Env = process.env): string | undefined {
  const override = env.PLANHOP_CLAUDE_BIN;
  if (override) {
    if (isShim(override)) throw new Error(`PLANHOP_CLAUDE_BIN points at a planhop shim (${override}); point it at the real Claude Code`);
    return override;
  }
  const candidates = [
    ...(env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => join(d, "claude")),
    join(home(env), ".local", "bin", "claude"),
    join(home(env), ".claude", "local", "claude"),
  ];
  return candidates.find((c) => isExecutableFile(c) && !isShim(c));
}
