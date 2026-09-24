import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { listAccounts, loadConfig, type Config } from "./config.js";
import { modeOf, readJson, withLock, writeAtomic, type Json } from "./fsutil.js";
import { claudeJsonPath, defaultClaudeDir, home, isDefaultDir, normalizeDir, stateDir, type Env } from "./paths.js";

/** Items in ~/.claude that stay per-account; everything else is symlinked. */
export const NOT_SHARED = new Set([
  ".claude.json",
  ".credentials.json", // Linux login
  "cache",
  "backups",
  "debug",
  "telemetry",
  "state",
  "daemon",
  "daemon.log",
  "daemon-auth-cooldown",
  "daemon-auth-status.json",
  "stats-cache.json",
  "mcp-needs-auth-cache.json",
  ".statusline-usage-cache",
  ".last-cleanup",
  ".last-update-result.json",
]);

/** Account-specific keys never copied between accounts' .claude.json. */
const ACCOUNT_KEYS = new Set([
  "oauthAccount",
  "userID",
  "primaryApiKey",
  "customApiKeyResponses",
  "hasAvailableSubscription",
  "recommendedSubscription",
  "claudeAiMcpEverConnected",
  "cachedExtraUsageDisabledReason",
  "overageCreditGrantCache",
  "passesEligibilityCache",
  "passesLastSeenCampaign",
  "passesLastSeenRemaining",
  "s1mAccessCache",
  "modelAccessCache",
  "orgModelDefaultCache",
  "groveConfigCache",
  "cachedGrowthBookFeatures",
  "cachedGrowthBookFeaturesAt",
  "cachedStatsigGates",
  "cachedDynamicConfigs",
  "cachedExperimentData",
  "cachedExperimentFeatures",
  "additionalModelCostsCache",
  "additionalModelOptionsCache",
  "metricsStatusCache",
  "penguinModeOrgEnabled",
  "githubWebConnectionStatusCache",
  "subscriptionNoticeCount",
  "cachedArtifactRoster",
]);

function lstatOrUndefined(p: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(p);
  } catch {
    return undefined;
  }
}

function sameFileContents(a: string, b: string): boolean {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false;
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/**
 * Refuse to treat `dir` as a separate account if it is ~/.claude under another
 * name (symlink, different letter case) or sits inside it, or contains it.
 * Linking ~/.claude into itself would replace its real files with symlinks.
 */
export function assertSeparateDir(dir: string, env: Env = process.env): void {
  const src = defaultClaudeDir(env);
  const target = normalizeDir(dir, env);
  if (target === src) return; // the default account itself
  const caseless = process.platform === "darwin" || process.platform === "win32";
  const norm = (p: string): string => (caseless ? p.toLowerCase() : p);
  // Resolve symlinks in the deepest part of the path that exists, so a folder
  // that doesn't exist yet is still compared by where it would really live
  const real = (p: string): string => {
    const rest: string[] = [];
    let cur = p;
    for (;;) {
      try {
        return join(realpathSync(cur), ...rest.reverse());
      } catch {
        const parent = dirname(cur);
        if (parent === cur) return p;
        rest.push(basename(cur));
        cur = parent;
      }
    }
  };
  const a = norm(real(src));
  const b = norm(real(target));
  let sameInode = false;
  try {
    const sa = statSync(src);
    const sb = statSync(target);
    sameInode = sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    /* target doesn't exist yet */
  }
  if (sameInode || a === b) throw new Error(`${target} is the same folder as ${src}; pick a different folder for this account`);
  if (b.startsWith(a + sep)) throw new Error(`${target} is inside ${src}; pick a folder outside it`);
  if (a.startsWith(b + sep)) throw new Error(`${target} contains ${src}; pick a different folder`);
}

export type Conflict = {
  name: string;
  /** the shared item in ~/.claude */
  shared: string;
  /** the account's own copy that is in the way of the symlink */
  local: string;
  identical: boolean;
};

/** What to do about a conflict: share ~/.claude's copy, share the account's copy, or leave both alone. */
export type Resolution = "shared" | "local" | "skip";
export type Ask = (c: Conflict) => Resolution;

/** Where planhop moves files instead of deleting them. */
function movedDir(env: Env): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(stateDir(env), "moved", stamp);
}

function moveAside(path: string, label: string, env: Env): string {
  const dest = join(movedDir(env), label, basename(path));
  mkdirSync(join(dest, ".."), { recursive: true });
  renameSync(path, dest);
  return dest;
}

/**
 * Symlink every shared item of ~/.claude into `dir`. Nothing is ever deleted:
 * if the account already has its own copy of an item (Claude Code's atomic
 * writes can replace a symlink with a real file), `ask` decides which copy to
 * share and the other is moved to ~/.local/state/planhop/moved/. Identical
 * copies are moved without asking. Returns human-readable notes.
 */
export function syncLinks(dir: string, env: Env = process.env, ask: Ask = () => "skip", keepSeparate: string[] = []): string[] {
  assertSeparateDir(dir, env);
  const src = defaultClaudeDir(env);
  const notes: string[] = [];
  if (!existsSync(src)) return notes;
  mkdirSync(dir, { recursive: true });
  const account = basename(dir);
  for (const name of readdirSync(src)) {
    if (NOT_SHARED.has(name) || keepSeparate.includes(name)) continue;
    const shared = join(src, name);
    const local = join(dir, name);
    try {
      const localStat = lstatOrUndefined(local);
      if (localStat?.isSymbolicLink()) continue;
      if (!existsSync(shared)) continue; // dangling symlink in ~/.claude: nothing to share
      if (localStat) {
        const identical = sameFileContents(shared, local);
        const choice = identical ? "shared" : ask({ name, shared, local, identical });
        if (choice === "skip") {
          notes.push(`${local} is a separate copy from ${shared}, so it isn't shared; run planhop again in a terminal to choose which to keep`);
          continue;
        }
        if (choice === "local") {
          const movedShared = moveAside(shared, "claude", env);
          renameSync(local, shared);
          notes.push(`now sharing ${account}'s ${name}; the previous shared copy is in ${movedShared}`);
        } else {
          const movedLocal = moveAside(local, account, env);
          if (!identical) notes.push(`now sharing ${shared}; ${account}'s own copy is in ${movedLocal}`);
        }
      }
      symlinkSync(shared, local);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST") continue; // another launch linked it first
      notes.push(`couldn't share ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return notes;
}

/** Create `dir`/.claude.json from the default account's, minus login and account-specific keys. */
export function seedClaudeJson(dir: string, env: Env = process.env): void {
  const target = claudeJsonPath(dir, env);
  if (existsSync(target)) return;
  const srcPath = join(home(env), ".claude.json");
  const src = readJson(srcPath) ?? {};
  const seeded = Object.fromEntries(Object.entries(src).filter(([k]) => !ACCOUNT_KEYS.has(k)));
  writeAtomic(target, JSON.stringify(seeded, null, 2), Math.min(modeOf(srcPath), 0o600));
}

// ---- MCP servers: kept identical across accounts with a three-way merge ----

/** Flattened MCP definitions: "u\0<name>" or "p\0<project>\0<name>" -> JSON of the server config. */
type Flat = Record<string, string>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function flattenMcp(cfg: Json): Flat {
  const out: Flat = {};
  if (isObj(cfg.mcpServers)) for (const [n, v] of Object.entries(cfg.mcpServers)) out[`u\0${n}`] = JSON.stringify(v);
  if (isObj(cfg.projects)) {
    for (const [path, proj] of Object.entries(cfg.projects)) {
      if (!isObj(proj) || !isObj(proj.mcpServers)) continue;
      for (const [n, v] of Object.entries(proj.mcpServers)) out[`p\0${path}\0${n}`] = JSON.stringify(v);
    }
  }
  return out;
}

/** Write `flat` back into a .claude.json object, replacing its MCP definitions. */
export function applyMcp(cfg: Json, flat: Flat): Json {
  const next: Json = { ...cfg, mcpServers: {} };
  const user: Json = {};
  const projects: Record<string, Json> = {};
  if (isObj(cfg.projects)) {
    for (const [path, proj] of Object.entries(cfg.projects)) {
      projects[path] = isObj(proj) ? { ...proj } : {};
      if (isObj(proj) && "mcpServers" in proj) projects[path].mcpServers = {};
    }
  }
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split("\0");
    const parsed: unknown = JSON.parse(value);
    if (parts[0] === "u" && parts[1] !== undefined) user[parts[1]] = parsed;
    else if (parts[0] === "p" && parts[1] !== undefined && parts[2] !== undefined) {
      const proj = (projects[parts[1]] ??= {});
      const servers = isObj(proj.mcpServers) ? proj.mcpServers : {};
      servers[parts[2]] = parsed;
      proj.mcpServers = servers;
    }
  }
  next.mcpServers = user;
  if (Object.keys(projects).length > 0 || isObj(cfg.projects)) next.projects = projects;
  return next;
}

/**
 * Three-way merge. For each server, if any account changed it since the last
 * sync (`base`), that change wins (the first account listed wins a conflict,
 * so put the main account first). With no base yet, everything is unioned and
 * nothing is removed.
 */
export function mergeMcp(base: Flat | undefined, accounts: Flat[]): Flat {
  if (!base) {
    const merged: Flat = {};
    for (const flat of [...accounts].reverse()) Object.assign(merged, flat);
    return merged;
  }
  const keys = new Set([...Object.keys(base), ...accounts.flatMap((a) => Object.keys(a))]);
  const merged: Flat = {};
  for (const key of keys) {
    const was = base[key];
    const changed = accounts.find((a) => a[key] !== was);
    const value = changed ? changed[key] : was;
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

function mcpStateFile(env: Env): string {
  return join(stateDir(env), "mcp-sync.json");
}

/**
 * Make every account's MCP servers (user and project level) the same: whatever
 * was added, changed or removed on any account since the last sync is applied
 * to all of them. Skipped when "mcpServers" is in keepSeparate.
 */
export function syncMcp(env: Env = process.env, cfg: Config = loadConfig(env)): void {
  if (cfg.keepSeparate.includes("mcpServers")) return;
  const defaultDir = defaultClaudeDir(env);
  const dirs = [defaultDir, ...listAccounts(cfg, env).map((a) => a.dir).filter((d) => !isDefaultDir(d, env))];
  const paths = [...new Set(dirs.map((d) => claudeJsonPath(d, env)))].filter((p) => existsSync(p));
  if (paths.length < 2) return;
  withLock(join(stateDir(env), "mcp-sync.lock"), () => {
    const state = readJson(mcpStateFile(env));
    const base = isObj(state?.base) ? (state.base as Flat) : undefined;
    const known = new Set(Array.isArray(state?.paths) ? state.paths : []);
    const flats = paths.map((p) => flattenMcp(readJson(p) ?? {}));
    // An account that wasn't part of the last sync can only add servers: what
    // it lacks isn't a removal (it may never have had them).
    const inputs = paths.map((p, i) => (base && !known.has(p) ? { ...base, ...flats[i] } : (flats[i] ?? {})));
    const merged = mergeMcp(base, inputs);
    const mergedKey = JSON.stringify(Object.entries(merged).sort());
    paths.forEach((path, i) => {
      const current = flats[i] ?? {};
      if (JSON.stringify(Object.entries(current).sort()) === mergedKey) return;
      // Re-read just before writing to keep anything Claude Code wrote meanwhile
      const fresh = readJson(path);
      if (!fresh) return;
      writeAtomic(path, JSON.stringify(applyMcp(fresh, merged), null, 2), modeOf(path));
    });
    writeAtomic(mcpStateFile(env), JSON.stringify({ base: merged, paths, at: new Date().toISOString() }, null, 2));
  });
}

/** Stable short id for a config dir, for cache and lock file names. */
export function dirKey(dir: string, env: Env = process.env): string {
  const d = normalizeDir(dir, env);
  return `${basename(d).replace(/[^\w.-]/g, "_")}-${createHash("sha256").update(d).digest("hex").slice(0, 8)}`;
}
