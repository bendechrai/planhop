#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { choose, fmtHours, score } from "./choose.js";
import { hasAccount, isValidAccountName, listAccounts, loadConfig, saveConfig } from "./config.js";
import { accountEmail } from "./credentials.js";
import { collapseHome, defaultClaudeDir, home, isDefaultDir, normalizeDir } from "./paths.js";
import { askOnTerminal, pick } from "./pick.js";
import { findRealClaude, SHIM_MARKER } from "./realbin.js";
import { assertSeparateDir, seedClaudeJson, syncLinks } from "./share.js";
import { canAsk, ask } from "./prompt.js";
import { BEGIN, detectRc, END, installRcBlock, removeRcBlock } from "./rc.js";
import { currentStatusline, includesPlanhop, installStatusline, settingsPath, uninstallStatusline, type Combine } from "./settings.js";
import { pickShell, shimScript } from "./shell.js";
import { refresh, renderStatusline } from "./statusline.js";
import { formatTable } from "./table.js";
import { gatherUsage } from "./usage.js";

const HELP = `planhop - run Claude Code on whichever subscription's quota expires soonest

Usage:
  planhop add <name> [dir]     register an account (dir defaults to ~/.claude-<name>;
                               use ~/.claude for the one you're already logged into)
  planhop login <name>         log that account in (runs \`claude auth login\` for it)
  planhop remove <name>        unregister an account (its folder is left alone)
  planhop status               usage per account, and which one would be picked
  planhop run [claude args]    launch Claude Code on the picked account
  planhop shim [--yes]         make plain \`claude\` go through planhop: writes
                               ~/.local/share/planhop/bin/claude and (after asking)
                               adds it to your shell's startup file
  planhop shim --remove        undo that
  planhop statusline --install [--append|--wrap|--replace] [--yes]
                               show the account and its usage in Claude Code's status line,
                               keeping any status line you already have (asks how)
  planhop statusline --uninstall
                               put the previous status line back
  planhop statusline [--append "<cmd>"] [--wrap "<cmd>"] [--usage-app-compat]
                               the status line itself (what --install sets up)

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
  const pct = (x: number): string => `${Math.round(x * 100)}%`;
  const body = rows.map((a) => {
    const notes = [accountEmail(a.dir) ?? "?"];
    if (a.blocked) notes.push(`AT LIMIT for ${fmtHours(a.unblockIn)}`);
    if (a.stale) notes.push(`cached ${fmtHours((now - a.fetchedAt) / 3_600_000)} ago`);
    return [a === chosen ? "->" : "", a.name, pct(a.u5), fmtHours(a.h5), pct(a.u7), fmtHours(a.h7), notes.join(", ")];
  });
  for (const e of errors) body.push(["", e.name, "-", "-", "-", "-", `ERROR: ${e.error}`]);
  const lines = formatTable(
    ["", "account", "5h used", "resets", "7d used", "resets", "login"],
    body,
    ["left", "left", "right", "right", "right", "right", "left"],
  );
  for (const l of lines) console.log(l);
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

function verifyShim(file: string): void {
  const shell = process.env.SHELL;
  if (!shell) return;
  // Start a shell the way a new terminal would: macOS terminal apps open login
  // shells (bash reads ~/.bash_profile, zsh also runs ~/.zprofile and ~/.zlogin),
  // most Linux terminals open plain interactive ones (~/.bashrc)
  const args = process.platform === "darwin" ? ["-l", "-i", "-c", "command -v claude"] : ["-i", "-c", "command -v claude"];
  const r = spawnSync(shell, args, { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] });
  const found = r.stdout.trim().split("\n").pop()?.trim();
  if (!found) return;
  if (found === file) console.log(`Checked: a new shell runs ${collapseHome(file)} for \`claude\`.`);
  else {
    log(`warning: a new shell still runs ${found} for \`claude\`. Something later in your startup files puts its folder first;`);
    log(`move planhop's block (between "${BEGIN}" and "${END}") to the very end.`);
  }
}

function cmdShim(rest: string[]): void {
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const dirArg = rest.find((a) => !a.startsWith("--"));
  const dir = normalizeDir(dirArg ?? join(home(), ".local", "share", "planhop", "bin"));
  const file = join(dir, "claude");
  const rc = detectRc(dir);

  if (flags.has("--remove")) {
    if (existsSync(file) && readFileSync(file, "utf8").includes(SHIM_MARKER)) {
      unlinkSync(file); // planhop's own generated file
      console.log(`Removed ${collapseHome(file)}`);
    }
    if (rc && removeRcBlock(rc.path)) console.log(`Removed planhop's PATH line from ${collapseHome(rc.path)}`);
    console.log("`claude` runs Claude Code directly again in new terminals.");
    return;
  }

  if (existsSync(file) && !readFileSync(file, "utf8").includes(SHIM_MARKER)) {
    fail(`${file} exists and isn't a planhop shim; not overwriting it`);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, shimScript());
  chmodSync(file, 0o755);
  console.log(`Wrote ${collapseHome(file)}`);

  if (!rc) {
    console.log(`Add this at the END of your shell's startup file, so it comes before the real claude:`);
    console.log(`  export PATH="${collapseHome(dir).replace(/^~/, "$HOME")}:$PATH"`);
    return;
  }
  const where = collapseHome(rc.path);
  const yes = flags.has("--yes") || (canAsk() && ["", "y", "yes"].includes((ask(`Add planhop to ${where} so new terminals use it? [Y/n] `) ?? "n").toLowerCase()));
  if (!yes) {
    console.log(`Not changed. To do it yourself, add this at the END of ${where}:`);
    console.log(`  ${rc.line}`);
    return;
  }
  const result = installRcBlock(rc.path, rc.line);
  console.log(result === "unchanged" ? `${where} already has planhop's PATH line.` : `${result === "added" ? "Added" : "Updated"} planhop's PATH line at the end of ${where}.`);
  verifyShim(file);
  offerStatusline(flags);
  console.log(rc.shell === "fish" ? "Open a new terminal (or run: exec fish) to start using it." : `Open a new terminal (or run: source ${where}) to start using it.`);
}

/** At the end of setup, offer planhop's status line if it isn't there yet. */
function offerStatusline(flags: Set<string>): void {
  let existing: string | undefined;
  try {
    existing = currentStatusline();
  } catch {
    return;
  }
  if (includesPlanhop(existing)) return;
  const yes = flags.has("--yes") || (canAsk() && ["", "y", "yes"].includes((ask("Also show the account and its usage in Claude Code's status line? [Y/n] ") ?? "n").toLowerCase()));
  if (yes) installStatuslineFlow(flags);
  else console.log("Skipped. Add it later with: planhop statusline --install");
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

/** Ask how to combine with an existing status line, unless told already. */
function chooseCombine(existing: string, flags: Set<string>): Combine | undefined {
  if (flags.has("--append")) return "append";
  if (flags.has("--wrap")) return "wrap";
  if (flags.has("--replace")) return "replace";
  if (flags.has("--yes")) return "append";
  const answer = ask(
    `Claude Code already has a status line:\n  ${existing}\n` +
      `  1) show it after planhop's account and usage (good for short ones, like Meko's)\n` +
      `  2) keep it as it is, with just the account in front (good for full ones, like the Claude Usage app's)\n` +
      `  3) replace it with planhop's\n` +
      `Choose [1]: `,
  );
  if (answer === undefined) return undefined;
  return answer === "2" ? "wrap" : answer === "3" ? "replace" : "append";
}

/** Set up Claude Code's status line; true if it's (now) showing planhop. */
function installStatuslineFlow(flags: Set<string>): boolean {
  let existing: string | undefined;
  try {
    existing = currentStatusline();
  } catch (e) {
    log(`not changing ${collapseHome(settingsPath())}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  if (includesPlanhop(existing)) {
    console.log("Claude Code's status line already shows planhop.");
    return true;
  }
  const how = existing ? chooseCombine(existing, flags) : "replace";
  if (!how) {
    console.log(`Not changed. To choose non-interactively: planhop statusline --install --append|--wrap|--replace`);
    return false;
  }
  const { command } = installStatusline(how);
  console.log(`Claude Code's status line now runs: ${command}`);
  console.log(`(saved in ${collapseHome(settingsPath())}, shared by every account; planhop statusline --uninstall puts the old one back)`);
  return true;
}

async function cmdStatusline(args: string[]): Promise<void> {
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  if (flags.has("--install")) {
    installStatuslineFlow(flags);
    return;
  }
  if (flags.has("--uninstall")) {
    const r = uninstallStatusline();
    console.log(r === "restored" ? "Put back the status line from before planhop." : r === "removed" ? "Removed planhop's status line." : "planhop isn't in Claude Code's status line.");
    return;
  }
  let wrap: string | undefined;
  let append: string | undefined;
  let usageAppCompat = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--wrap") wrap = args[++i];
    else if (args[i] === "--append") append = args[++i];
    else if (args[i] === "--usage-app-compat") usageAppCompat = true;
  }
  const chunks: Buffer[] = [];
  if (!process.stdin.isTTY) for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  console.log(renderStatusline(Buffer.concat(chunks).toString("utf8"), { wrap, append, usageAppCompat }));
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
      cmdShim(rest);
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
