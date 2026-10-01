import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { isSharedMemoryWrite } from "../src/memory.js";

let home: string;
let claude: string;
let b: string;
let env: Record<string, string>;

const write = (file: string, tool = "Write"): unknown => ({ hook_event_name: "PermissionRequest", tool_name: tool, tool_input: { file_path: file } });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "planhop-memory-"));
  claude = join(home, ".claude");
  b = join(home, ".claude-b");
  mkdirSync(join(claude, "projects", "-proj", "memory"), { recursive: true });
  writeFileSync(join(claude, "projects", "-proj", "memory", "MEMORY.md"), "");
  writeFileSync(join(claude, "settings.json"), "{}");
  mkdirSync(b);
  symlinkSync(join(claude, "projects"), join(b, "projects"));
  symlinkSync(join(claude, "settings.json"), join(b, "settings.json"));
  env = { HOME: home, CLAUDE_CONFIG_DIR: b };
});

describe("isSharedMemoryWrite", () => {
  it("approves saving a memory through the account's projects link", () => {
    expect(isSharedMemoryWrite(write(join(b, "projects", "-proj", "memory", "MEMORY.md"), "Edit"), env)).toBe(true);
    expect(isSharedMemoryWrite(write(join(b, "projects", "-proj", "memory", "new-fact.md")), env)).toBe(true);
  });

  it("approves a project's first memory, before its folder exists", () => {
    expect(isSharedMemoryWrite(write(join(b, "projects", "-other", "memory", "MEMORY.md")), env)).toBe(true);
  });

  it("stays out of it on the ~/.claude account", () => {
    const file = join(claude, "projects", "-proj", "memory", "MEMORY.md");
    expect(isSharedMemoryWrite(write(file), { HOME: home })).toBe(false);
    expect(isSharedMemoryWrite(write(file), { HOME: home, CLAUDE_CONFIG_DIR: claude })).toBe(false);
  });

  it("leaves everything that isn't a memory file to Claude Code", () => {
    expect(isSharedMemoryWrite(write(join(b, "settings.json")), env)).toBe(false);
    expect(isSharedMemoryWrite(write(join(b, "projects", "-proj", "session.jsonl")), env)).toBe(false);
    expect(isSharedMemoryWrite(write(join(b, "projects", "memory", "x.md")), env)).toBe(false);
    expect(isSharedMemoryWrite(write(join(claude, "projects", "-proj", "memory", "MEMORY.md")), env)).toBe(false);
    expect(isSharedMemoryWrite(write(join(home, "code", "memory", "x.md")), env)).toBe(false);
  });

  it("isn't fooled by .. in the path", () => {
    expect(isSharedMemoryWrite(write(join(b, "projects", "-proj", "memory") + "/../../../settings.json"), env)).toBe(false);
  });

  it("refuses a memory path that really lands somewhere else", () => {
    const elsewhere = join(home, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(claude, "projects", "-linked"));
    expect(isSharedMemoryWrite(write(join(b, "projects", "-linked", "memory", "x.md")), env)).toBe(false);
    symlinkSync(join(home, ".zshrc"), join(claude, "projects", "-proj", "memory", "link.md"));
    expect(isSharedMemoryWrite(write(join(b, "projects", "-proj", "memory", "link.md")), env)).toBe(false);
  });

  it("only answers for Write and Edit, and ignores input it doesn't understand", () => {
    const file = join(b, "projects", "-proj", "memory", "MEMORY.md");
    expect(isSharedMemoryWrite(write(file, "Bash"), env)).toBe(false);
    expect(isSharedMemoryWrite({ tool_name: "Write", tool_input: { file_path: "projects/-proj/memory/x.md" } }, env)).toBe(false);
    expect(isSharedMemoryWrite({ tool_name: "Write" }, env)).toBe(false);
    expect(isSharedMemoryWrite("nonsense", env)).toBe(false);
    expect(isSharedMemoryWrite(null, env)).toBe(false);
  });
});
