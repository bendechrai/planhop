import { join } from "node:path";
import type { Account } from "./config.js";
import { accessToken } from "./credentials.js";
import { readJson, withLock, writeAtomic } from "./fsutil.js";
import { cacheDir, type Env } from "./paths.js";

export interface Usage {
  name: string;
  dir: string;
  /** 0..1 */
  u5: number;
  /** epoch ms, or null when no 5h window is active */
  r5: number | null;
  u7: number;
  r7: number | null;
  fetchedAt: number;
  stale: boolean;
}

export interface UsageError {
  name: string;
  dir: string;
  error: string;
}

/** Checked field by field; the endpoint is undocumented. */
interface Window {
  utilization?: unknown;
  resets_at?: unknown;
}

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

function toMs(iso: unknown): number | null {
  if (typeof iso !== "string" || !iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** A percentage from the API as a 0..1 fraction; anything non-numeric counts as 0. */
function toFraction(pctValue: unknown): number {
  const n = typeof pctValue === "number" ? pctValue : Number(pctValue);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n / 100)) : 0;
}

function isUsage(v: unknown): v is Usage {
  if (typeof v !== "object" || v === null) return false;
  const u = v as Record<string, unknown>;
  const num = (x: unknown): boolean => typeof x === "number" && Number.isFinite(x);
  const numOrNull = (x: unknown): boolean => x === null || num(x);
  return typeof u.name === "string" && num(u.u5) && num(u.u7) && numOrNull(u.r5) && numOrNull(u.r7) && num(u.fetchedAt);
}

/** Undocumented endpoint used by Claude Code's /usage. Free: no quota used, no window started. */
export async function fetchLiveUsage(token: string, timeoutMs = 8000): Promise<Omit<Usage, "name" | "dir" | "stale">> {
  const res = await fetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`usage endpoint returned HTTP ${res.status}`);
  const data = (await res.json()) as { five_hour?: Window | null; seven_day?: Window | null };
  const five = data.five_hour ?? {};
  const week = data.seven_day ?? {};
  return {
    u5: toFraction(five.utilization),
    r5: toMs(five.resets_at),
    u7: toFraction(week.utilization),
    r7: toMs(week.resets_at),
    fetchedAt: Date.now(),
  };
}

function cacheFile(env: Env): string {
  return join(cacheDir(env), "usage.json");
}

export function loadCache(env: Env = process.env): Record<string, Usage> {
  const raw = readJson(cacheFile(env)) ?? {};
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, Usage] => isUsage(e[1])));
}

/** Merge fresh readings into the cache under a lock, so concurrent refreshes don't drop each other's. */
export function saveCache(fresh: Usage[], env: Env = process.env): void {
  if (fresh.length === 0) return;
  withLock(join(cacheDir(env), "usage.lock"), () => {
    const merged = { ...loadCache(env), ...Object.fromEntries(fresh.map((u) => [u.name, { ...u, stale: false }])) };
    writeAtomic(cacheFile(env), JSON.stringify(merged, null, 2));
  });
}

/**
 * Live usage when the stored login is valid, otherwise the last reading. Logins
 * only renew while Claude Code runs on that account, and an idle account's
 * usage doesn't change (apart from claude.ai app use), so the cache stays useful.
 */
export async function getUsage(account: Account, env: Env = process.env): Promise<Usage | UsageError> {
  const token = accessToken(account.dir, env);
  let error = "login expired or missing (renews next time this account runs)";
  if (token) {
    try {
      return { ...account, ...(await fetchLiveUsage(token)), stale: false };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  const cached = loadCache(env)[account.name];
  return cached ? { ...cached, dir: account.dir, stale: true } : { ...account, error };
}

export async function gatherUsage(accounts: Account[], env: Env = process.env): Promise<{ ok: Usage[]; errors: UsageError[] }> {
  const results = await Promise.all(accounts.map((a) => getUsage(a, env)));
  const ok = results.filter((r): r is Usage => !("error" in r));
  saveCache(ok.filter((u) => !u.stale), env);
  return { ok, errors: results.filter((r): r is UsageError => "error" in r) };
}
