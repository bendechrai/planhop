import { readJson, writeAtomic } from "./fsutil.js";
import { collapseHome, configFile, normalizeDir, type Env } from "./paths.js";

export interface Config {
  /** account name -> Claude Code config dir */
  accounts: Record<string, string>;
  /**
   * Items kept per account instead of shared: names of entries in ~/.claude
   * (e.g. "settings.json") and/or "mcpServers". Everything else is shared.
   */
  keepSeparate: string[];
}

export interface Account {
  name: string;
  dir: string;
}

const NAME = /^[A-Za-z0-9][\w.-]*$/;
const RESERVED = new Set(["__proto__", "constructor", "prototype", "hasOwnProperty", "toString", "valueOf"]);

export function isValidAccountName(name: string): boolean {
  return NAME.test(name) && !RESERVED.has(name);
}

export function loadConfig(env: Env = process.env): Config {
  const raw = readJson(configFile(env)) ?? {};
  const accounts: Record<string, string> = {};
  if (typeof raw.accounts === "object" && raw.accounts !== null) {
    for (const [name, dir] of Object.entries(raw.accounts)) {
      if (isValidAccountName(name) && typeof dir === "string") accounts[name] = dir;
    }
  }
  const keepSeparate = Array.isArray(raw.keepSeparate)
    ? raw.keepSeparate.filter((x): x is string => typeof x === "string")
    : [];
  return { accounts, keepSeparate };
}

export function saveConfig(cfg: Config, env: Env = process.env): void {
  const accounts = Object.fromEntries(Object.entries(cfg.accounts).map(([n, d]) => [n, collapseHome(d, env)]));
  const out: Record<string, unknown> = { accounts };
  if (cfg.keepSeparate.length > 0) out.keepSeparate = cfg.keepSeparate;
  writeAtomic(configFile(env), JSON.stringify(out, null, 2) + "\n", 0o644);
}

export function hasAccount(cfg: Config, name: string): boolean {
  return Object.hasOwn(cfg.accounts, name);
}

export function listAccounts(cfg: Config, env: Env = process.env): Account[] {
  return Object.entries(cfg.accounts).map(([name, dir]) => ({ name, dir: normalizeDir(dir, env) }));
}

/** The account whose config dir matches `dir`, if any. */
export function accountForDir(cfg: Config, dir: string, env: Env = process.env): Account | undefined {
  const target = normalizeDir(dir, env);
  return listAccounts(cfg, env).find((a) => a.dir === target);
}
