import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  includesPlanhop,
  installMemoryHook,
  installStatusline,
  memoryHookInstalled,
  memoryHookSettings,
  planStatusline,
  uninstallMemoryHook,
  uninstallStatusline,
} from "../src/settings.js";

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

describe("memoryHookSettings", () => {
  const both = { a: "~/.claude", b: "~/.claude-b" };

  it("is the shared settings.json once there's an account other than ~/.claude", () => {
    expect(memoryHookSettings({ accounts: { a: "~/.claude" }, keepSeparate: [] }, env)).toEqual([]);
    expect(memoryHookSettings({ accounts: both, keepSeparate: [] }, env)).toEqual([settingsFile()]);
  });

  it("is each other account's own settings.json when that's kept separate", () => {
    expect(memoryHookSettings({ accounts: both, keepSeparate: ["settings.json"] }, env)).toEqual([join(home, ".claude-b", "settings.json")]);
  });

  it("is nothing when accounts keep their own projects folder", () => {
    expect(memoryHookSettings({ accounts: both, keepSeparate: ["projects"] }, env)).toEqual([]);
  });
});

describe("installMemoryHook / uninstallMemoryHook", () => {
  const sound = { matcher: "", hooks: [{ type: "command", command: "afplay glass.aiff" }] };
  const mine = { matcher: "Write|Edit", hooks: [{ type: "command", command: "planhop allow-memory" }] };
  const hooks = (): Record<string, unknown> => read().hooks as Record<string, unknown>;

  it("adds the hook next to the hooks already there, once", () => {
    writeFileSync(settingsFile(), JSON.stringify({ model: "opus", hooks: { Notification: [sound], PermissionRequest: [sound] } }));
    expect(memoryHookInstalled(settingsFile())).toBe(false);
    expect(installMemoryHook(settingsFile())).toBe("added");
    expect(read().model).toBe("opus");
    expect(hooks()).toEqual({ Notification: [sound], PermissionRequest: [sound, mine] });
    expect(memoryHookInstalled(settingsFile())).toBe(true);
    expect(installMemoryHook(settingsFile())).toBe("unchanged");
    expect(hooks().PermissionRequest).toHaveLength(2);
  });

  it("creates the settings file when there isn't one", () => {
    const own = join(home, ".claude-b", "settings.json");
    expect(installMemoryHook(own)).toBe("added");
    expect(JSON.parse(readFileSync(own, "utf8"))).toEqual({ hooks: { PermissionRequest: [mine] } });
  });

  it("takes out only its own hook, however planhop is invoked", () => {
    const byPath = { matcher: "Write|Edit", hooks: [{ type: "command", command: "/opt/bin/planhop allow-memory" }, sound.hooks[0]] };
    writeFileSync(settingsFile(), JSON.stringify({ hooks: { Notification: [sound], PermissionRequest: [byPath, mine] } }));
    expect(uninstallMemoryHook(settingsFile())).toBe("removed");
    expect(hooks()).toEqual({ Notification: [sound], PermissionRequest: [{ matcher: "Write|Edit", hooks: [sound.hooks[0]] }] });
    expect(uninstallMemoryHook(settingsFile())).toBe("not-installed");
  });

  it("leaves no empty hooks behind", () => {
    writeFileSync(settingsFile(), JSON.stringify({ model: "opus" }));
    installMemoryHook(settingsFile());
    uninstallMemoryHook(settingsFile());
    expect(read()).toEqual({ model: "opus" });
  });

  it("refuses to touch a settings.json it can't parse", () => {
    writeFileSync(settingsFile(), "{ broken");
    expect(() => installMemoryHook(settingsFile())).toThrow();
    expect(readFileSync(settingsFile(), "utf8")).toBe("{ broken");
  });
});
