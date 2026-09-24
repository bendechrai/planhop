import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const CLI = resolve("dist/cli.js");
let home: string;
let fake: string;

function run(args: string[], extra: Record<string, string> = {}): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { HOME: home, PATH: "/usr/bin:/bin", PLANHOP_CLAUDE_BIN: fake, ...extra },
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "planhop-e2e-"));
  mkdirSync(join(home, ".claude"));
  fake = join(home, "fake-claude");
  writeFileSync(fake, `#!/bin/sh
case "$1" in
  exit) exit "$2" ;;
  kill) kill -TERM $$ ;;
  *) printf '%s|%s|%s' "$*" "\${CLAUDE_CONFIG_DIR-unset}" "\${PLANHOP_ACTIVE-unset}" ;;
esac
`);
  chmodSync(fake, 0o755);
  mkdirSync(join(home, ".config", "planhop"), { recursive: true });
  writeFileSync(join(home, ".config", "planhop", "config.json"), JSON.stringify({ accounts: { a: "~/.claude" } }));
});

describe("planhop run", () => {
  it("runs Claude Code with the same arguments and marks the session", () => {
    const r = run(["run", "-c", "--model", "opus"]);
    expect(r.stdout).toBe("-c --model opus|unset|a");
  });

  it("passes Claude Code's exit code through", () => {
    expect(run(["run", "exit", "7"]).status).toBe(7);
  });

  it("exits by the same signal when Claude Code is killed", () => {
    const r = run(["run", "kill"]);
    expect(r.signal).toBe("SIGTERM");
  });

  it("explains a missing Claude Code instead of crashing", () => {
    const r = run(["run"], { PLANHOP_CLAUDE_BIN: join(home, "nope") });
    expect(r.status).toBe(127);
    expect(r.stderr).toMatch(/couldn't start Claude Code/);
  });
});

describe("planhop add", () => {
  it("refuses an account folder that is ~/.claude under another name", () => {
    const r = run(["add", "b", join(home, ".claude", "inner")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/inside/);
  });

  it("refuses names that aren't plain", () => {
    expect(run(["add", "__proto__"]).status).toBe(1);
    expect(run(["add", "a b"]).status).toBe(1);
  });

  it("refuses a name that's already registered", () => {
    const r = run(["add", "a", join(home, ".claude-x")]);
    expect(r.stderr).toMatch(/already registered/);
  });
});
