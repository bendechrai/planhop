#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { choose, fmtHours, score } from "./choose.js";
import { hasAccount, isValidAccountName, listAccounts, loadConfig, saveConfig } from "./config.js";
import { accountEmail } from "./credentials.js";
import { collapseHome, defaultClaudeDir, home, isDefaultDir, normalizeDir } from "./paths.js";
import { askOnTerminal, pick } from "./pick.js";
import { findRealClaude, SHIM_MARKER } from "./realbin.js";
import { assertSeparateDir, seedClaudeJson, syncLinks } from "./share.js";
import { pickShell, shimScript } from "./shell.js";
import { refresh, renderStatusline } from "./statusline.js";
import { gatherUsage } from "./usage.js";

const HELP = `planhop - run Claude Code on whichever subscription's quota expires soonest

Usage:
  planhop add <name> [dir]     register an account (dir defaults to ~/.claude-<name>;
                               use ~/.claude for the one you're already logged into)
  planhop login <name>         log that account in (runs \`claude auth login\` for it)
  planhop remove <name>        unregister an account (its folder is left alone)
  planhop status               usage per account, and which one would be picked
  planhop run [claude args]    launch Claude Code on the picked account
  planhop shim [dir]           install a \`claude\` command that runs \`planhop run\`
                               (default dir ~/.local/share/planhop/bin)
  planhop statusline [--wrap "<cmd>"] [--usage-app-compat]
                               statusline command for Claude Code settings.json

Environment:
  PLANHOP_ACCOUNT=<name>       force an account
  PLANHOP_CLAUDE_BIN=<path>    the real Claude Code binary (default: found on PATH)
  CLAUDE_CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN or PLANHOP_ACTIVE (set inside a
  planhop session) already set: passed straight through
  \`claude auth\` and \`setup-token\` need PLANHOP_ACCOUNT, since they change one login
`;

function log(msg: string): void {
  process.stderr.write(`\x1b[2m[planhop] ${msg}\x1b[0m\n`);
}

function fail(msg: string, code = 1): never {
  process.stderr.write(`planhop: ${msg}\n`);
  process.exit(code);
}

function realClaude(): string {
  let found: string | undefined;
  try {
    found = findRealClaude();
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), 127);
  }
  return found ?? fail("can't find Claude Code. Install it, or set PLANHOP_CLAUDE_BIN.", 127);
}

function childEnv(dir: string | undefined, name?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (name !== undefined) env.PLANHOP_ACTIVE = name;
  if (dir === undefined) return env;
  if (isDefaultDir(dir)) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = dir;
  return env;
}

function runClaude(args: string[], env: NodeJS.ProcessEnv): void {
  const bin = realClaude();
  const child = spawn(bin, args, { stdio: "inherit", env });
  child.on("error", (e) => fail(`couldn't start Claude Code (${bin}): ${e.message}`, 127));
  // ^C and ^\ go to the whole foreground process group, so Claude Code already
  // gets them; planhop just mustn't die first. ^Z (SIGTSTP) is left alone so
  // planhop stops along with Claude Code and the shell gets the terminal back.
  const ignore = (): void => undefined;
  process.on("SIGINT", ignore);
  process.on("SIGQUIT", ignore);
  for (const sig of ["SIGTERM", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
  child.on("exit", (code, signal) => {
    if (signal) {
      // Exit the same way Claude Code did, so the shell sees the real signal
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

async function cmdStatus(): Promise<void> {
  const accounts = listAccounts(loadConfig());
  if (accounts.length === 0) fail("no accounts yet. Start with: planhop add main ~/.claude");
  const { ok, errors } = await gatherUsage(accounts);
  const now = Date.now();
  const scored = ok.map((u) => score(u, now));
  const chosen = choose(scored);
  const rows = [...scored].sort(
    (a, b) => Number(a.blocked) - Number(b.blocked) || (a.h7 ?? Infinity) - (b.h7 ?? Infinity),
  );
  const pad = (s: string, n: number): string => s.padStart(n);
  console.log(`   ${"account".padEnd(12)}${pad("5h used", 8)}${pad("resets", 9)}${pad("7d used", 9)}${pad("resets", 9)}  login`);
  for (const a of rows) {
    const notes = [accountEmail(a.dir) ?? "?"];
    if (a.blocked) notes.push(`AT LIMIT for ${fmtHours(a.unblockIn)}`);
    if (a.stale) notes.push(`cached ${fmtHours((now - a.fetchedAt) / 3_600_000)} ago`);
    console.log(
      `${a === chosen ? "-> " : "   "}${a.name.padEnd(12)}${pad(`${Math.round(a.u5 * 100)}%`, 7)}${pad(fmtHours(a.h5), 10)}` +
        `${pad(`${Math.round(a.u7 * 100)}%`, 8)}${pad(fmtHours(a.h7), 9)}  ${notes.join(", ")}`,
    );
  }
  for (const e of errors) console.log(`   ${e.name.padEnd(12)}ERROR: ${e.error}`);
}

function cmdAdd(name: string | undefined, dirArg: string | undefined): void {
  if (!name || !isValidAccountName(name)) fail("usage: planhop add <name> [dir]  (name: letters, digits, . _ -)");
  const cfg = loadConfig();
  if (hasAccount(cfg, name)) fail(`'${name}' is already registered; remove it first to point it somewhere else`);
  const dir = normalizeDir(dirArg ?? join(home(), `.claude-${name}`));
  if (Object.values(cfg.accounts).some((d) => normalizeDir(d) === dir)) fail(`${dir} is already registered`);
  try {
    assertSeparateDir(dir);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  cfg.accounts[name] = dir;
  if (!isDefaultDir(dir)) {
    for (const note of syncLinks(dir, process.env, askOnTerminal, cfg.keepSeparate)) log(note);
    seedClaudeJson(dir);
    const hasDefault = Object.values(cfg.accounts).some((d) => isDefaultDir(d));
    if (!hasDefault && existsSync(defaultClaudeDir())) {
      log(`note: your existing ~/.claude login isn't registered. Add it with: planhop add <name> ~/.claude`);
    }
  }
  saveConfig(cfg);
  console.log(`Registered '${name}' -> ${dir}`);
  if (!accountEmail(dir)) console.log(`Next: planhop login ${name}`);
}

function cmdRemove(name: string | undefined): void {
  const cfg = loadConfig();
  if (!name || !hasAccount(cfg, name)) fail(`unknown account '${name ?? ""}'`);
  cfg.accounts = Object.fromEntries(Object.entries(cfg.accounts).filter(([n]) => n !== name));
  saveConfig(cfg);
  console.log(`Removed '${name}' (its folder was left in place).`);
}

function cmdLogin(name: string | undefined): void {
  const account = listAccounts(loadConfig()).find((a) => a.name === name);
  if (!account) fail(`unknown account '${name ?? ""}'. Add it first: planhop add <name>`);
  runClaude(["auth", "login"], childEnv(account.dir, account.name));
}

function cmdShim(dirArg: string | undefined): void {
  const dir = normalizeDir(dirArg ?? join(home(), ".local", "share", "planhop", "bin"));
  const file = join(dir, "claude");
  if (existsSync(file) && !readFileSync(file, "utf8").includes(SHIM_MARKER)) {
    fail(`${file} exists and isn't a planhop shim; not overwriting it`);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, shimScript());
  chmodSync(file, 0o755);
  console.log(`Wrote ${file}`);
  console.log(`Make sure ${dir} comes before the real claude on your PATH, e.g. at the END of your shell rc:`);
  console.log(`  export PATH="${collapseHome(dir).replace(/^~/, "$HOME")}:$PATH"`);
}

/** Used by the shim: prints shell code that sets up the environment. */
async function cmdPick(args: string[]): Promise<void> {
  const real = realClaude();
  let result;
  try {
    result = await pick(args);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  for (const m of result.messages) log(m);
  const isDefault = result.dir !== undefined && isDefaultDir(result.dir);
  process.stdout.write(pickShell(real, { dir: result.dir, name: result.name, isDefault }) + "\n");
}

async function cmdRun(args: string[]): Promise<void> {
  let result;
  try {
    result = await pick(args);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  for (const m of result.messages) log(m);
  runClaude(args, childEnv(result.dir, result.name));
}

async function cmdStatusline(args: string[]): Promise<void> {
  let wrap: string | undefined;
  let usageAppCompat = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--wrap") wrap = args[++i];
    else if (args[i] === "--usage-app-compat") usageAppCompat = true;
  }
  const chunks: Buffer[] = [];
  if (!process.stdin.isTTY) for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  console.log(renderStatusline(Buffer.concat(chunks).toString("utf8"), { wrap, usageAppCompat }));
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const afterDashes = rest[0] === "--" ? rest.slice(1) : rest;
  switch (cmd) {
    case "add":
      cmdAdd(rest[0], rest[1]);
      return;
    case "remove":
      cmdRemove(rest[0]);
      return;
    case "login":
      cmdLogin(rest[0]);
      return;
    case "status":
      return cmdStatus();
    case "shim":
      cmdShim(rest[0]);
      return;
    case "pick":
      return cmdPick(afterDashes);
    case "run":
      return cmdRun(afterDashes);
    case "statusline":
      return cmdStatusline(rest);
    case "refresh":
      return rest[0] ? refresh(rest[0]) : fail("usage: planhop refresh <dir>");
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return;
    case "--version":
    case "-v": {
      const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
      console.log(pkg.version);
      return;
    }
    default:
      fail(`unknown command '${cmd}'. Run \`planhop help\`.`);
  }
}

main().catch((e: unknown) => {
  fail(e instanceof Error ? e.message : String(e));
});
