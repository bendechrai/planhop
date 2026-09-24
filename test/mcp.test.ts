import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { flattenMcp, mergeMcp, syncMcp } from "../src/share.js";

describe("mergeMcp", () => {
  const s = (v: string): string => JSON.stringify({ url: v });

  it("unions everything on the first sync, main account winning conflicts", () => {
    const merged = mergeMcp(undefined, [{ "u\0x": s("a") }, { "u\0x": s("b"), "u\0y": s("b") }]);
    expect(merged).toEqual({ "u\0x": s("a"), "u\0y": s("b") });
  });

  it("applies an addition, a change and a removal made on any account", () => {
    const base = { "u\0keep": s("1"), "u\0change": s("1"), "u\0drop": s("1") };
    const a = { "u\0keep": s("1"), "u\0change": s("1"), "u\0drop": s("1") };
    const b = { "u\0keep": s("1"), "u\0change": s("2"), "u\0new": s("1") }; // b changed, added, removed
    expect(mergeMcp(base, [a, b])).toEqual({ "u\0keep": s("1"), "u\0change": s("2"), "u\0new": s("1") });
  });

  it("prefers the main account when both changed the same server", () => {
    const base = { "u\0x": s("0") };
    expect(mergeMcp(base, [{ "u\0x": s("main") }, { "u\0x": s("other") }])).toEqual({ "u\0x": s("main") });
  });
});

describe("syncMcp", () => {
  let home: string;
  let env: Record<string, string>;
  let cfg: Config;
  const read = (p: string): Record<string, unknown> => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "planhop-mcp-"));
    env = { HOME: home, PATH: "" };
    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, ".claude-b"));
    cfg = { accounts: { a: join(home, ".claude"), b: join(home, ".claude-b") }, keepSeparate: [] };
    writeFileSync(join(home, ".claude.json"), JSON.stringify({
      oauthAccount: { emailAddress: "a@example.com" },
      mcpServers: { shared: { url: "s" } },
      projects: { "/p": { allowedTools: ["x"], mcpServers: { proj: { url: "p" } } } },
    }));
    writeFileSync(join(home, ".claude-b", ".claude.json"), JSON.stringify({
      oauthAccount: { emailAddress: "b@example.com" },
      mcpServers: { onlyB: { url: "b" } },
    }));
  });

  it("gives every account every server, in both directions, without touching logins", () => {
    syncMcp(env, cfg);
    const a = read(join(home, ".claude.json"));
    const b = read(join(home, ".claude-b", ".claude.json"));
    expect(Object.keys(a.mcpServers as object).sort()).toEqual(["onlyB", "shared"]);
    expect(Object.keys(b.mcpServers as object).sort()).toEqual(["onlyB", "shared"]);
    expect(flattenMcp(b)).toEqual(flattenMcp(a));
    expect((a.oauthAccount as { emailAddress: string }).emailAddress).toBe("a@example.com");
    expect((b.oauthAccount as { emailAddress: string }).emailAddress).toBe("b@example.com");
    expect((a.projects as Record<string, { allowedTools: string[] }>)["/p"]?.allowedTools).toEqual(["x"]);
  });

  it("carries a removal on one account to the others on the next sync", () => {
    syncMcp(env, cfg);
    const bPath = join(home, ".claude-b", ".claude.json");
    const b = read(bPath);
    delete (b.mcpServers as Record<string, unknown>).shared;
    writeFileSync(bPath, JSON.stringify(b));
    syncMcp(env, cfg);
    expect(Object.keys(read(join(home, ".claude.json")).mcpServers as object)).toEqual(["onlyB"]);
  });

  it("doesn't treat a newly added account's missing servers as removals", () => {
    syncMcp(env, cfg);
    mkdirSync(join(home, ".claude-c"));
    writeFileSync(join(home, ".claude-c", ".claude.json"), JSON.stringify({ mcpServers: {} }));
    const withC = { ...cfg, accounts: { ...cfg.accounts, c: join(home, ".claude-c") } };
    syncMcp(env, withC);
    expect(Object.keys(read(join(home, ".claude.json")).mcpServers as object).sort()).toEqual(["onlyB", "shared"]);
    expect(Object.keys(read(join(home, ".claude-c", ".claude.json")).mcpServers as object).sort()).toEqual(["onlyB", "shared"]);
  });

  it("does nothing when mcpServers is kept separate", () => {
    syncMcp(env, { ...cfg, keepSeparate: ["mcpServers"] });
    expect(Object.keys(read(join(home, ".claude-b", ".claude.json")).mcpServers as object)).toEqual(["onlyB"]);
  });
});
