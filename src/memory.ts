import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isObj, realPath } from "./fsutil.js";
import { defaultClaudeDir, isDefaultDir, normalizeDir, type Env } from "./paths.js";

/** What a PermissionRequest hook prints to approve the request, so Claude Code doesn't ask. */
export const ALLOW = JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });

/** True when `file` is in a memory folder under `projects`: <projects>/<project>/memory/... */
function inMemoryFolder(projects: string, file: string): boolean {
  const parts = relative(projects, file).split(sep);
  return parts.length >= 3 && parts[0] !== ".." && parts[1] === "memory";
}

/**
 * Whether a permission request is Claude Code saving a memory on an account
 * other than ~/.claude. That account's projects/ is a symlink into ~/.claude,
 * which Claude Code protects: it asks before every write that lands there
 * through a symlink, and allow rules in settings can't approve those. A
 * PermissionRequest hook can. ~/.claude's own account is never asked.
 */
export function isSharedMemoryWrite(input: unknown, env: Env = process.env): boolean {
  const dir = env.CLAUDE_CONFIG_DIR;
  if (!dir || isDefaultDir(dir, env)) return false;
  if (!isObj(input) || (input.tool_name !== "Write" && input.tool_name !== "Edit")) return false;
  const file = isObj(input.tool_input) ? input.tool_input.file_path : undefined;
  if (typeof file !== "string" || !isAbsolute(file)) return false;
  const requested = resolve(file);
  // Asked for in this account's memory folder, and really lands in ~/.claude's
  return (
    inMemoryFolder(join(normalizeDir(dir, env), "projects"), requested) &&
    inMemoryFolder(realPath(join(defaultClaudeDir(env), "projects")), realPath(requested))
  );
}
