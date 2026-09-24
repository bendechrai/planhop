import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { accountForDir, loadConfig } from "./config.js";
import { accountEmail } from "./credentials.js";
import { createExclusive, writeAtomic } from "./fsutil.js";
import { cacheDir, defaultClaudeDir, home, isDefaultDir, normalizeDir, type Env } from "./paths.js";
import { dirKey } from "./share.js";
import { getUsage, loadCache, saveCache, type Usage } from "./usage.js";

const REFRESH_AFTER_MS = 60_000;
/** A refresh holds its lock until it finishes; a failed one keeps it, so retries wait this long. */
const LOCK_STALE_MS = 120_000;

const c = {
  reset: "\x1b[0m",
  dim: "\x1b[90m",
  blue: "\x1b[34m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
};

interface StatusInput {
  cwd?: string;
  workspace?: { current_dir?: string };
  model?: { display_name?: string };
  context_window?: {
    used_percentage?: number;
    context_window_size?: number;
    current_usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | null;
  };
}

export interface StatuslineOptions {
  /** Shell command whose output follows the account label, instead of the built-in line. */
  wrap?: string;
  /** Run `wrap` against a private HOME holding this account's usage in the Claude Usage app's cache format. */
  usageAppCompat?: boolean;
  /** Shell command whose output goes after planhop's full built-in line (e.g. another tool's status line). */
  append?: string;
}

function mtime(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function levelColor(u: number): string {
  return u < 0.5 ? c.green : u < 0.8 ? c.yellow : c.red;
}

function clock(ms: number, withDay: boolean): string {
  const d = new Date(ms);
  const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return withDay ? `${d.toLocaleDateString([], { weekday: "short" })} ${t}` : t;
}

function gitBranch(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, "branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function contextPct(input: StatusInput): number | undefined {
  const cw = input.context_window;
  if (!cw) return undefined;
  if (typeof cw.used_percentage === "number") return cw.used_percentage / 100;
  const u = cw.current_usage;
  if (!u || !cw.context_window_size) return undefined;
  const used = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  return used / cw.context_window_size;
}

function lockFile(dir: string, env: Env): string {
  return join(cacheDir(env), `refresh-${dirKey(dir, env)}.lock`);
}

/** Kick off a background usage refresh for `dir` if the cached reading is old. */
function maybeRefresh(dir: string, name: string, env: Env): void {
  const cached = loadCache(env)[name];
  if (cached && Date.now() - cached.fetchedAt < REFRESH_AFTER_MS) return;
  const lock = lockFile(dir, env);
  if (existsSync(lock) && Date.now() - mtime(lock) >= LOCK_STALE_MS) {
    try {
      unlinkSync(lock);
    } catch {
      /* another statusline took it over */
    }
  }
  if (!createExclusive(lock)) return; // a refresh is running, or failed recently
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  spawn(process.execPath, [cli, "refresh", dir], { detached: true, stdio: "ignore", env: { ...process.env } }).unref();
}

/** Fetch and cache one account's usage (the background half of maybeRefresh). */
export async function refresh(dir: string, env: Env = process.env): Promise<void> {
  const d = normalizeDir(dir, env);
  const name = accountForDir(loadConfig(env), d, env)?.name ?? dirKey(d, env);
  const u = await getUsage({ name, dir: d }, env);
  if ("error" in u || u.stale) return; // keep the lock: the next attempt waits LOCK_STALE_MS
  saveCache([u], env);
  writeUsageAppCache(d, u, env);
  try {
    unlinkSync(lockFile(d, env));
  } catch {
    /* already gone */
  }
}

function usageAppHome(dir: string, env: Env): string {
  return join(cacheDir(env), "statusline-home", dirKey(dir, env));
}

/** The Claude Usage app's cache format, for running its statusline script against another account. */
function writeUsageAppCache(dir: string, u: Usage, env: Env): void {
  if (isDefaultDir(dir, env)) return;
  const iso = (ms: number | null): string => (ms ? new Date(ms).toISOString().replace(/\.\d+Z$/, "Z") : "null");
  const target = join(usageAppHome(dir, env), ".claude", ".statusline-usage-cache");
  mkdirSync(join(usageAppHome(dir, env), ".claude"), { recursive: true });
  const body =
    `UTILIZATION=${Math.round(u.u5 * 100)}\nRESETS_AT=${iso(u.r5)}\n` +
    `TIMESTAMP=${Math.floor(u.fetchedAt / 1000)}\nPROFILE_NAME=${u.name.replace(/[^\w.-]/g, "_")}\n` +
    `WEEKLY_UTILIZATION=${Math.round(u.u7 * 100)}\nWEEKLY_RESETS_AT=${iso(u.r7)}\n`;
  writeAtomic(target, body);
}

function prepareUsageAppHome(dir: string, env: Env): string {
  const fake = usageAppHome(dir, env);
  mkdirSync(join(fake, ".claude"), { recursive: true });
  const link = join(fake, ".claude", "statusline-config.txt");
  const real = join(defaultClaudeDir(env), "statusline-config.txt");
  let present = false;
  try {
    lstatSync(link); // a link that points nowhere still counts; don't try to recreate it
    present = true;
  } catch {
    /* not there yet */
  }
  if (existsSync(real) && !present) symlinkSync(real, link);
  return fake;
}

export function renderStatusline(raw: string, opts: StatuslineOptions = {}, env: Env = process.env): string {
  let input: StatusInput = {};
  try {
    input = JSON.parse(raw) as StatusInput;
  } catch {
    /* render what we can */
  }
  const dir = normalizeDir(env.CLAUDE_CONFIG_DIR || defaultClaudeDir(env), env);
  const account = accountForDir(loadConfig(env), dir, env);
  const name = account?.name ?? dirKey(dir, env);
  const label = accountEmail(dir, env) ?? (env.CLAUDE_CODE_OAUTH_TOKEN ? "token" : (account?.name ?? "not logged in"));
  const sep = `${c.dim} | ${c.reset}`;
  const head = `${c.magenta}${label}${c.reset}`;

  maybeRefresh(dir, name, env);
  const usage = loadCache(env)[name];

  const usageEnv: Record<string, string> = { PLANHOP_ACCOUNT: name, PLANHOP_EMAIL: label };
  if (usage) {
    usageEnv.PLANHOP_5H_PCT = String(Math.round(usage.u5 * 100));
    usageEnv.PLANHOP_7D_PCT = String(Math.round(usage.u7 * 100));
    if (usage.r5) usageEnv.PLANHOP_5H_RESET = String(Math.floor(usage.r5 / 1000));
    if (usage.r7) usageEnv.PLANHOP_7D_RESET = String(Math.floor(usage.r7 / 1000));
  }
  /** Run another status line command with Claude Code's input and planhop's usage in its environment. */
  const runOther = (cmd: string, extraEnv: Record<string, string> = {}): string => {
    const r = spawnSync("/bin/sh", ["-c", cmd], { input: raw, encoding: "utf8", env: { ...process.env, ...usageEnv, ...extraEnv }, timeout: 5000 });
    return (r.stdout || "").replace(/\n+$/, "");
  };

  if (opts.wrap) {
    const compatHome = opts.usageAppCompat && !isDefaultDir(dir, env) ? prepareUsageAppHome(dir, env) : undefined;
    if (compatHome && usage) writeUsageAppCache(dir, usage, env);
    const rest = runOther(opts.wrap, compatHome ? { HOME: compatHome, PLANHOP_REAL_HOME: home(env) } : {});
    return rest ? `${head}${sep}${rest}` : head;
  }

  const parts = [head];
  const cwd = input.workspace?.current_dir ?? input.cwd;
  if (cwd) {
    parts.push(`${c.blue}${basename(cwd)}${c.reset}`);
    const branch = gitBranch(cwd);
    if (branch) parts.push(`${c.green}${branch}${c.reset}`);
  }
  if (input.model?.display_name) parts.push(`${c.yellow}${input.model.display_name}${c.reset}`);
  const ctx = contextPct(input);
  if (ctx !== undefined) parts.push(`${c.cyan}ctx ${Math.round(ctx * 100)}%${c.reset}`);
  if (usage) {
    const now = Date.now();
    const five = usage.r5 && usage.r5 > now ? usage.u5 : 0;
    const week = usage.r7 && usage.r7 > now ? usage.u7 : 0;
    const fiveReset = usage.r5 && usage.r5 > now ? ` > ${clock(usage.r5, false)}` : "";
    const weekReset = usage.r7 && usage.r7 > now ? ` > ${clock(usage.r7, true)}` : "";
    parts.push(`${levelColor(five)}5h ${Math.round(five * 100)}%${fiveReset}${c.reset}`);
    parts.push(`${levelColor(week)}7d ${Math.round(week * 100)}%${weekReset}${c.reset}`);
  } else {
    parts.push(`${c.dim}usage ~${c.reset}`);
  }
  if (opts.append) {
    const extra = runOther(opts.append);
    if (extra) parts.push(extra);
  }
  return parts.join(sep);
}

export interface Preview {
  /** what each way of combining would look like, rendered with sample input */
  append: string;
  wrap: string;
  replace: string;
  /** "wrap" when the existing line already shows the folder, model or usage itself */
  suggested: "append" | "wrap";
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
export const stripAnsi = (s: string): string => s.replace(ANSI, "");

/**
 * Render every way of combining planhop with `existing`, using sample input
 * like Claude Code's, so the installer can show real results instead of
 * describing them. Runs the existing command (it's what the status line will run).
 */
export function previewCombinations(existing: string, env: Env = process.env, cwd: string = process.cwd()): Preview {
  const sample = JSON.stringify({
    session_id: "planhop-preview",
    cwd,
    workspace: { current_dir: cwd, project_dir: cwd },
    model: { id: "claude-opus", display_name: "Opus" },
    context_window: { used_percentage: 12, context_window_size: 200000 },
  });
  const wrap = renderStatusline(sample, { wrap: existing }, env);
  // The existing line on its own: the wrap preview minus planhop's account label in front
  const own = stripAnsi(wrap).split(" | ").slice(1).join(" | ");
  const full = own.includes(basename(cwd)) || /\bOpus\b/.test(own) || /\d+(\.\d+)?%/.test(own);
  return {
    append: renderStatusline(sample, { append: existing }, env),
    wrap,
    replace: renderStatusline(sample, {}, env),
    suggested: full ? "wrap" : "append",
  };
}
