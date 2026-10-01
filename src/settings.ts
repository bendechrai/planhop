import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { listAccounts, type Config } from "./config.js";
import { createExclusive, isObj, modeOf, readJson, writeAtomic, type Json } from "./fsutil.js";
import { defaultClaudeDir, isDefaultDir, stateDir, type Env } from "./paths.js";
import { shellQuote } from "./shell.js";

/** How to combine planhop with a status line that's already set up. */
export type Combine = "append" | "wrap" | "replace";

const PLANHOP = "planhop statusline";
const MEMORY_HOOK = "planhop allow-memory";

/** ~/.claude/settings.json, which every planhop account shares through a symlink. */
export function settingsPath(env: Env = process.env): string {
  return join(defaultClaudeDir(env), "settings.json");
}

function previousFile(env: Env): string {
  return join(stateDir(env), "statusline-previous.json");
}

/** Parsed settings, {} when the file doesn't exist; throws if it exists but isn't valid JSON (never overwrite it then). */
function readSettings(path: string): Json {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") return {};
  const parsed: unknown = JSON.parse(text);
  if (!isObj(parsed)) throw new Error(`${path} isn't a JSON object`);
  return parsed;
}

function writeSettings(path: string, settings: Json): void {
  // Write through a symlinked settings file (dotfiles managers) instead of replacing the link
  const target = existsSync(path) ? realpathSync(path) : path;
  writeAtomic(target, JSON.stringify(settings, null, 2) + "\n", modeOf(target, 0o644));
}

/** The status line command Claude Code runs now, if any. */
export function currentStatusline(env: Env = process.env): string | undefined {
  const sl = readSettings(settingsPath(env)).statusLine;
  return isObj(sl) && typeof sl.command === "string" ? sl.command : undefined;
}

export function includesPlanhop(command: string | undefined): boolean {
  return command !== undefined && /\bplanhop['"]?\s+statusline\b/.test(command);
}

/** The command to install, given what's there now and how to combine with it. */
export function planStatusline(existing: string | undefined, how: Combine): string {
  if (!existing || how === "replace") return PLANHOP;
  return `${PLANHOP} --${how} ${shellQuote(existing)}`;
}

export type InstallResult = { result: "added" | "unchanged"; command: string };

/**
 * Point Claude Code's status line at planhop, keeping whatever was there as
 * `how` says. The previous setting is saved so uninstallStatusline can restore it.
 */
export function installStatusline(how: Combine, env: Env = process.env): InstallResult {
  const path = settingsPath(env);
  const settings = readSettings(path);
  const before = isObj(settings.statusLine) ? settings.statusLine : undefined;
  const existing = before && typeof before.command === "string" ? before.command : undefined;
  if (includesPlanhop(existing)) return { result: "unchanged", command: existing ?? PLANHOP };
  const command = planStatusline(existing, how);
  writeAtomic(previousFile(env), JSON.stringify({ previous: before ?? null, at: new Date().toISOString() }, null, 2));
  settings.statusLine = { ...(before ?? {}), type: "command", command };
  writeSettings(path, settings);
  return { result: "added", command };
}

/** Put back the status line from before installStatusline, or remove planhop's. */
export function uninstallStatusline(env: Env = process.env): "restored" | "removed" | "not-installed" {
  const path = settingsPath(env);
  const settings = readSettings(path);
  const sl = isObj(settings.statusLine) ? settings.statusLine : undefined;
  if (!sl || !includesPlanhop(typeof sl.command === "string" ? sl.command : undefined)) return "not-installed";
  const saved = readJson(previousFile(env));
  const previous = saved && isObj(saved.previous) ? saved.previous : undefined;
  if (previous) settings.statusLine = previous;
  else delete settings.statusLine;
  writeSettings(path, settings);
  return previous ? "restored" : "removed";
}

// ---- Memory hook: lets accounts other than ~/.claude save memories without Claude Code asking ----

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? (v as unknown[]) : [];
}

function isMemoryHook(hook: unknown): boolean {
  return isObj(hook) && typeof hook.command === "string" && /\bplanhop['"]?\s+allow-memory\b/.test(hook.command);
}

function hasMemoryHook(settings: Json): boolean {
  const entries = isObj(settings.hooks) ? asArray(settings.hooks.PermissionRequest) : [];
  return entries.some((entry) => isObj(entry) && asArray(entry.hooks).some(isMemoryHook));
}

/**
 * The settings files that need the memory hook: the ones read by accounts
 * whose projects/ is a symlink into ~/.claude. Normally that's the one shared
 * settings.json; accounts that keep their own settings.json each need it.
 * Empty when no account needs it.
 */
export function memoryHookSettings(cfg: Config, env: Env = process.env): string[] {
  if (cfg.keepSeparate.includes("projects")) return [];
  const others = listAccounts(cfg, env).filter((a) => !isDefaultDir(a.dir, env));
  if (others.length === 0) return [];
  return cfg.keepSeparate.includes("settings.json") ? others.map((a) => join(a.dir, "settings.json")) : [settingsPath(env)];
}

/** Whether the settings file at `path` already runs planhop's memory hook. */
export function memoryHookInstalled(path: string): boolean {
  return hasMemoryHook(readSettings(path));
}

/** True the first time planhop brings the memory hook up, so that launches mention it once and not again. */
export function firstMemoryHookMention(env: Env = process.env): boolean {
  return createExclusive(join(stateDir(env), "memory-hook-mentioned"));
}

/** Add planhop's memory hook to the settings file at `path`, keeping any other hooks. */
export function installMemoryHook(path: string): "added" | "unchanged" {
  const settings = readSettings(path);
  if (hasMemoryHook(settings)) return "unchanged";
  const hooks = isObj(settings.hooks) ? settings.hooks : {};
  const entry = { matcher: "Write|Edit", hooks: [{ type: "command", command: MEMORY_HOOK }] };
  settings.hooks = { ...hooks, PermissionRequest: [...asArray(hooks.PermissionRequest), entry] };
  writeSettings(path, settings);
  return "added";
}

/** Take planhop's memory hook out of the settings file at `path`, leaving any other hooks. */
export function uninstallMemoryHook(path: string): "removed" | "not-installed" {
  const settings = readSettings(path);
  if (!hasMemoryHook(settings)) return "not-installed";
  const hooks = isObj(settings.hooks) ? { ...settings.hooks } : {};
  const kept = asArray(hooks.PermissionRequest).flatMap((entry) => {
    if (!isObj(entry) || !asArray(entry.hooks).some(isMemoryHook)) return [entry];
    const others = asArray(entry.hooks).filter((h) => !isMemoryHook(h));
    return others.length > 0 ? [{ ...entry, hooks: others }] : [];
  });
  if (kept.length > 0) hooks.PermissionRequest = kept;
  else delete hooks.PermissionRequest;
  if (Object.keys(hooks).length > 0) settings.hooks = hooks;
  else delete settings.hooks;
  writeSettings(path, settings);
  return "removed";
}
