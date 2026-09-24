import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { includesPlanhop, installStatusline, planStatusline, uninstallStatusline } from "../src/settings.js";

let home: string;
let env: Record<string, string>;
const settingsFile = (): string => join(home, ".claude", "settings.json");
const read = (): Record<string, unknown> => JSON.parse(readFileSync(settingsFile(), "utf8")) as Record<string, unknown>;
const command = (): string => (read().statusLine as { command: string }).command;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "planhop-settings-"));
  mkdirSync(join(home, ".claude"));
  env = { HOME: home };
});

describe("planStatusline", () => {
  it("quotes the existing command safely", () => {
    expect(planStatusline(undefined, "append")).toBe("planhop statusline");
    expect(planStatusline("bash '/x y/s.sh'", "append")).toBe(`planhop statusline --append 'bash '\\''/x y/s.sh'\\'''`);
    expect(planStatusline("a", "wrap")).toBe("planhop statusline --wrap 'a'");
    expect(planStatusline("a", "replace")).toBe("planhop statusline");
  });

  it("recognises planhop however it's invoked", () => {
    expect(includesPlanhop("planhop statusline")).toBe(true);
    expect(includesPlanhop("/Users/x/Library/pnpm/planhop statusline --wrap 'y'")).toBe(true);
    expect(includesPlanhop("'/h/.claude/meko-statusline.sh' --inner-cmd 'planhop statusline'")).toBe(true);
    expect(includesPlanhop("bash ~/.claude/statusline-command.sh")).toBe(false);
  });
});

describe("installStatusline / uninstallStatusline", () => {
  it("adds planhop when there's no status line, keeping other settings", () => {
    writeFileSync(settingsFile(), JSON.stringify({ model: "opus" }));
    expect(installStatusline("append", env).result).toBe("added");
    expect(read().model).toBe("opus");
    expect(command()).toBe("planhop statusline");
  });

  it("puts an existing status line after planhop's, and restores it on uninstall", () => {
    writeFileSync(settingsFile(), JSON.stringify({ statusLine: { type: "command", command: "meko.sh", padding: 1 } }));
    installStatusline("append", env);
    expect(command()).toBe("planhop statusline --append 'meko.sh'");
    expect((read().statusLine as { padding: number }).padding).toBe(1);
    expect(uninstallStatusline(env)).toBe("restored");
    expect(command()).toBe("meko.sh");
  });

  it("does nothing when planhop is already there", () => {
    writeFileSync(settingsFile(), JSON.stringify({ statusLine: { type: "command", command: "x --inner-cmd 'planhop statusline'" } }));
    expect(installStatusline("append", env).result).toBe("unchanged");
    expect(command()).toBe("x --inner-cmd 'planhop statusline'");
  });

  it("removes planhop's status line on uninstall when there was none before", () => {
    installStatusline("append", env);
    expect(uninstallStatusline(env)).toBe("removed");
    expect(read().statusLine).toBeUndefined();
    expect(uninstallStatusline(env)).toBe("not-installed");
  });

  it("writes through a symlinked settings.json", () => {
    const real = join(home, "dotfiles-settings.json");
    writeFileSync(real, "{}");
    symlinkSync(real, settingsFile());
    installStatusline("append", env);
    expect(readlinkSync(settingsFile())).toBe(real);
    expect(readFileSync(real, "utf8")).toContain("planhop statusline");
  });

  it("refuses to touch a settings.json it can't parse", () => {
    writeFileSync(settingsFile(), "{ broken");
    expect(() => installStatusline("append", env)).toThrow();
    expect(readFileSync(settingsFile(), "utf8")).toBe("{ broken");
  });
});
