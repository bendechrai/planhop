import { readSync } from "node:fs";
import { choose, fmtHours, pct, score } from "./choose.js";
import { listAccounts, loadConfig, type Config } from "./config.js";
import { accountEmail } from "./credentials.js";
import { isDefaultDir, type Env } from "./paths.js";
import { assertSeparateDir, seedClaudeJson, syncLinks, syncMcp, type Ask, type Conflict } from "./share.js";
import { gatherUsage } from "./usage.js";

/** Claude Code commands that act on shared things, or none: run them without picking an account. */
const PASSTHROUGH = new Set(["--version", "-v", "--help", "-h", "update", "install", "migrate-installer", "mcp", "config", "plugin", "doctor"]);
/** Claude Code commands that act on one account's login: the account must be named. */
const ACCOUNT_COMMANDS = new Set(["auth", "setup-token"]);

export interface Pick {
  /** Config dir to run with; undefined = leave the environment alone. */
  dir?: string;
  /** Account name, exported to the session as PLANHOP_ACTIVE so nested launches stay on it. */
  name?: string;
  messages: string[];
}

/** Ask on the terminal which copy to share; skip when there's no terminal to ask on. */
export const askOnTerminal: Ask = (c: Conflict) => {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return "skip";
  process.stderr.write(
    `\n[planhop] ${c.local} is a separate copy of ${c.shared}, so this account isn't sharing it.\n` +
      `  1) share ${c.shared} (this account's copy is moved aside, not deleted)\n` +
      `  2) share this account's copy (the current shared one is moved aside, not deleted)\n` +
      `  3) leave both as they are for now\n` +
      `Choose [3]: `,
  );
  const buf = Buffer.alloc(64);
  let line = "";
  try {
    while (!line.includes("\n")) {
      const n = readSync(0, buf, 0, buf.length, null);
      if (n <= 0) break;
      line += buf.subarray(0, n).toString("utf8");
    }
  } catch {
    return "skip";
  }
  const answer = line.trim();
  return answer === "1" ? "shared" : answer === "2" ? "local" : "skip";
};

function prepare(dir: string, env: Env, cfg: Config, ask: Ask): string[] {
  const notes: string[] = [];
  if (!isDefaultDir(dir, env)) {
    assertSeparateDir(dir, env);
    notes.push(...syncLinks(dir, env, ask, cfg.keepSeparate));
    seedClaudeJson(dir, env);
  }
  try {
    syncMcp(env, cfg);
  } catch (e) {
    notes.push(`couldn't sync MCP servers: ${e instanceof Error ? e.message : String(e)}`);
  }
  return notes;
}

export async function pick(args: string[], env: Env = process.env, ask: Ask = askOnTerminal): Promise<Pick> {
  const cmd = args[0] ?? "";
  // Already inside a planhop session (nested launch), or the account was chosen another way
  if (env.PLANHOP_ACTIVE || env.CLAUDE_CONFIG_DIR || env.CLAUDE_CODE_OAUTH_TOKEN || PASSTHROUGH.has(cmd)) {
    return { messages: [] };
  }
  const cfg = loadConfig(env);
  const accounts = listAccounts(cfg, env);
  if (accounts.length === 0) return { messages: [] };

  const forced = env.PLANHOP_ACCOUNT;
  if (ACCOUNT_COMMANDS.has(cmd) && !forced) {
    throw new Error(
      `\`claude ${cmd}\` changes one account's login, so name the account: ` +
        `PLANHOP_ACCOUNT=<name> claude ${cmd} (or planhop login <name>). Accounts: ${accounts.map((a) => a.name).join(", ")}`,
    );
  }
  if (forced) {
    const a = accounts.find((x) => x.name === forced);
    if (!a) throw new Error(`unknown account '${forced}' (known: ${accounts.map((x) => x.name).join(", ")})`);
    return { dir: a.dir, name: a.name, messages: [...prepare(a.dir, env, cfg, ask), `using ${a.name} (forced)`] };
  }
  if (accounts.length === 1 && accounts[0]) {
    const only = accounts[0];
    return { dir: only.dir, name: only.name, messages: prepare(only.dir, env, cfg, ask) };
  }

  const { ok, errors } = await gatherUsage(accounts, env);
  const messages = errors.map((e) => `${e.name}: ${e.error}`);
  const now = Date.now();
  const scored = ok.map((u) => score(u, now));
  const chosen = choose(scored);
  if (!chosen) {
    const first = accounts[0];
    messages.push("no usage data for any account, using the first one");
    return first ? { dir: first.dir, name: first.name, messages: [...messages, ...prepare(first.dir, env, cfg, ask)] } : { messages };
  }
  const why = chosen.blocked
    ? `at its limit, frees up in ${fmtHours(chosen.unblockIn)}`
    : `7d ${pct(chosen.u7)} resets ${fmtHours(chosen.h7)}, 5h ${pct(chosen.u5)} resets ${fmtHours(chosen.h5)}`;
  const others = scored
    .filter((a) => a !== chosen)
    .map((a) => `${a.name} 7d ${pct(a.u7)} resets ${fmtHours(a.h7)}`)
    .join(", ");
  const who = accountEmail(chosen.dir, env);
  messages.push(
    `using ${chosen.name}${who ? ` (${who})` : ""}: ${why}${chosen.stale ? " (cached)" : ""}${others ? ` | ${others}` : ""}`,
  );
  return { dir: chosen.dir, name: chosen.name, messages: [...prepare(chosen.dir, env, cfg, ask), ...messages] };
}
