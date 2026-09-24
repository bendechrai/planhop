import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { modeOf, readJson, writeAtomic, type Json } from "./fsutil.js";
import { defaultClaudeDir, stateDir, type Env } from "./paths.js";
import { shellQuote } from "./shell.js";

/** How to combine planhop with a status line that's already set up. */
export type Combine = "append" | "wrap" | "replace";

const PLANHOP = "planhop statusline";

/** ~/.claude/settings.json, which every planhop account shares through a symlink. */
export function settingsPath(env: Env = process.env): string {
  return join(defaultClaudeDir(env), "settings.json");
}

function previousFile(env: Env): string {
  return join(stateDir(env), "statusline-previous.json");
}

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
