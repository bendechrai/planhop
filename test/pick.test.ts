import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "../src/config.js";
import { installMemoryHook } from "../src/settings.js";
import type { Usage } from "../src/usage.js";

const H = 3_600_000;
const readings: Record<string, Partial<Usage>> = {};

vi.mock("../src/usage.js", () => ({
  gatherUsage: (accounts: Account[]) =>
    Promise.resolve({
      ok: accounts.map((a) => ({ name: a.name, dir: a.dir, u5: 0, r5: null, u7: 0, r7: null, fetchedAt: Date.now(), stale: false, ...readings[a.name] })),
      errors: [],
    }),
}));

const { pick } = await import("../src/pick.js");

let home: string;
let env: Record<string, string>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "planhop-pick-"));
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, ".config", "planhop"), { recursive: true });
  writeFileSync(join(home, ".config", "planhop", "config.json"), JSON.stringify({ accounts: { a: "~/.claude", b: "~/.claude-b" } }));
  env = { HOME: home, PATH: "" };
  for (const k of Object.keys(readings)) Reflect.deleteProperty(readings, k);
});

describe("pick", () => {
  it("picks the account whose week resets first", async () => {
    readings.a = { u7: 0.3, r7: Date.now() + 100 * H };
    readings.b = { u7: 0.6, r7: Date.now() + 40 * H };
    const p = await pick([], env);
    expect(p.name).toBe("b");
    expect(p.dir).toBe(join(home, ".claude-b"));
  });

  it("passes straight through inside a planhop session, so nested launches stay put", async () => {
    expect(await pick([], { ...env, PLANHOP_ACTIVE: "a" })).toEqual({ messages: [] });
    expect(await pick([], { ...env, CLAUDE_CONFIG_DIR: join(home, ".claude-b") })).toEqual({ messages: [] });
  });

  it("passes shared commands through without picking", async () => {
    for (const cmd of ["mcp", "config", "update", "--version", "plugin"]) {
      expect((await pick([cmd], env)).dir).toBeUndefined();
    }
  });

  it("makes you name the account for login commands", async () => {
    await expect(pick(["auth", "login"], env)).rejects.toThrow(/PLANHOP_ACCOUNT/);
    const p = await pick(["auth", "login"], { ...env, PLANHOP_ACCOUNT: "b" });
    expect(p.name).toBe("b");
  });

  it("honours a forced account and rejects unknown ones", async () => {
    expect((await pick([], { ...env, PLANHOP_ACCOUNT: "a" })).name).toBe("a");
    await expect(pick([], { ...env, PLANHOP_ACCOUNT: "nope" })).rejects.toThrow(/unknown account/);
  });

  it("mentions the memory hook once on an account that needs it, and never once it's installed", async () => {
    const forced = { ...env, PLANHOP_ACCOUNT: "b" };
    expect((await pick([], forced)).messages.join(" ")).toMatch(/planhop allow-memory --install/);
    expect((await pick([], forced)).messages.join(" ")).not.toMatch(/allow-memory/);

    const fresh = { ...forced, XDG_STATE_HOME: join(home, "state") };
    expect((await pick([], { ...fresh, PLANHOP_ACCOUNT: "a" })).messages.join(" ")).not.toMatch(/allow-memory/);
    installMemoryHook(join(home, ".claude", "settings.json"));
    expect((await pick([], fresh)).messages.join(" ")).not.toMatch(/allow-memory/);
  });

  it("refuses an account folder that is really ~/.claude", async () => {
    writeFileSync(join(home, ".config", "planhop", "config.json"), JSON.stringify({ accounts: { a: "~/.claude", b: "~/.claude/inner" } }));
    await expect(pick([], { ...env, PLANHOP_ACCOUNT: "b" })).rejects.toThrow(/inside/);
  });
});
