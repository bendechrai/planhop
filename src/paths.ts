import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Env {
  readonly [key: string]: string | undefined;
}

export function home(env: Env = process.env): string {
  return env.HOME ?? homedir();
}

/** Claude Code's default config dir. */
export function defaultClaudeDir(env: Env = process.env): string {
  return join(home(env), ".claude");
}

export function expandHome(p: string, env: Env = process.env): string {
  if (p === "~") return home(env);
  if (p.startsWith("~/")) return join(home(env), p.slice(2));
  return p;
}

export function collapseHome(p: string, env: Env = process.env): string {
  const h = home(env);
  return p === h ? "~" : p.startsWith(h + "/") ? "~" + p.slice(h.length) : p;
}

/** Absolute, no trailing slash. Claude Code derives its Keychain entry name from this string. */
export function normalizeDir(p: string, env: Env = process.env): string {
  return resolve(expandHome(p, env));
}

export function isDefaultDir(dir: string, env: Env = process.env): boolean {
  return normalizeDir(dir, env) === defaultClaudeDir(env);
}

/** Where Claude Code keeps .claude.json (login profile, MCP servers, project state) for a config dir. */
export function claudeJsonPath(dir: string, env: Env = process.env): string {
  return isDefaultDir(dir, env) ? join(home(env), ".claude.json") : join(normalizeDir(dir, env), ".claude.json");
}

export function configFile(env: Env = process.env): string {
  return join(env.XDG_CONFIG_HOME ?? join(home(env), ".config"), "planhop", "config.json");
}

export function cacheDir(env: Env = process.env): string {
  return join(env.XDG_CACHE_HOME ?? join(home(env), ".cache"), "planhop");
}

/** Durable state: the MCP sync record, and files planhop moved aside instead of deleting. */
export function stateDir(env: Env = process.env): string {
  return join(env.XDG_STATE_HOME ?? join(home(env), ".local", "state"), "planhop");
}
