import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { assertSeparateDir, syncLinks, type Conflict } from "../src/share.js";

let home: string;
let env: Record<string, string>;
let claude: string;
let b: string;

/** Every file under `dir`, recursively, as paths relative to it. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (lstatSync(p).isDirectory()) walk(p, join(rel, name));
      else out.push(join(rel, name));
    }
  };
  walk(dir, "");
  return out;
}

const moved = (): string => join(home, ".local", "state", "planhop", "moved");

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "planhop-share-"));
  env = { HOME: home, PATH: "" };
  claude = join(home, ".claude");
  b = join(home, ".claude-b");
  mkdirSync(join(claude, "projects"), { recursive: true });
  writeFileSync(join(claude, "settings.json"), '{"shared":true}');
  writeFileSync(join(claude, "CLAUDE.md"), "shared notes");
});

describe("assertSeparateDir", () => {
  it("allows a separate folder and ~/.claude itself", () => {
    expect(() => { assertSeparateDir(b, env); }).not.toThrow();
    expect(() => { assertSeparateDir(claude, env); }).not.toThrow();
  });

  it("refuses ~/.claude under another name", () => {
    const alias = join(home, "alias");
    symlinkSync(claude, alias);
    expect(() => { assertSeparateDir(alias, env); }).toThrow(/same folder/);
  });

  it("refuses folders inside or containing ~/.claude", () => {
    expect(() => { assertSeparateDir(join(claude, "sub"), env); }).toThrow(/inside/);
    expect(() => { assertSeparateDir(home, env); }).toThrow(/contains/);
  });

  it("stops syncLinks before it touches anything", () => {
    const alias = join(home, "alias");
    symlinkSync(claude, alias);
    expect(() => syncLinks(alias, env)).toThrow();
    expect(readFileSync(join(claude, "settings.json"), "utf8")).toBe('{"shared":true}');
    expect(lstatSync(join(claude, "settings.json")).isSymbolicLink()).toBe(false);
  });
});

describe("syncLinks never deletes", () => {
  it("moves an identical copy aside without asking, then links", () => {
    mkdirSync(b);
    writeFileSync(join(b, "CLAUDE.md"), "shared notes");
    let asked = false;
    syncLinks(b, env, () => { asked = true; return "skip"; });
    expect(asked).toBe(false);
    expect(readlinkSync(join(b, "CLAUDE.md"))).toBe(join(claude, "CLAUDE.md"));
    expect(filesUnder(moved()).some((f) => f.endsWith("CLAUDE.md"))).toBe(true);
  });

  it("leaves both copies alone when there's no answer", () => {
    mkdirSync(b);
    writeFileSync(join(b, "settings.json"), '{"mine":true}');
    const notes = syncLinks(b, env); // default ask: no terminal, skip
    expect(readFileSync(join(b, "settings.json"), "utf8")).toBe('{"mine":true}');
    expect(lstatSync(join(b, "settings.json")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(claude, "settings.json"), "utf8")).toBe('{"shared":true}');
    expect(notes.join(" ")).toMatch(/isn't shared/);
  });

  it("shares ~/.claude's copy and moves the account's aside when asked", () => {
    mkdirSync(b);
    writeFileSync(join(b, "settings.json"), '{"mine":true}');
    const seen: Conflict[] = [];
    syncLinks(b, env, (c) => { seen.push(c); return "shared"; });
    expect(seen.map((c) => c.name)).toEqual(["settings.json"]);
    expect(readlinkSync(join(b, "settings.json"))).toBe(join(claude, "settings.json"));
    const kept = filesUnder(moved()).find((f) => f.endsWith("settings.json"));
    expect(kept).toBeDefined();
    expect(readFileSync(join(moved(), kept ?? ""), "utf8")).toBe('{"mine":true}');
  });

  it("shares the account's copy and moves ~/.claude's aside when asked", () => {
    mkdirSync(b);
    writeFileSync(join(b, "settings.json"), '{"mine":true}');
    syncLinks(b, env, () => "local");
    expect(readFileSync(join(claude, "settings.json"), "utf8")).toBe('{"mine":true}');
    expect(readlinkSync(join(b, "settings.json"))).toBe(join(claude, "settings.json"));
    const kept = filesUnder(moved()).find((f) => f.endsWith("settings.json"));
    expect(readFileSync(join(moved(), kept ?? ""), "utf8")).toBe('{"shared":true}');
  });

  it("asks about a real folder in the way instead of skipping it silently", () => {
    mkdirSync(join(b, "projects"), { recursive: true });
    writeFileSync(join(b, "projects", "session.jsonl"), "b's session");
    const names: string[] = [];
    syncLinks(b, env, (c) => { names.push(c.name); return "skip"; });
    expect(names).toContain("projects");
    expect(readFileSync(join(b, "projects", "session.jsonl"), "utf8")).toBe("b's session");
  });

  it("skips keepSeparate items and dangling links in ~/.claude", () => {
    symlinkSync(join(home, "nowhere"), join(claude, "dangling"));
    syncLinks(b, env, () => "shared", ["settings.json"]);
    expect(existsSync(join(b, "settings.json"))).toBe(false);
    expect(existsSync(join(b, "dangling"))).toBe(false);
    expect(lstatSync(join(b, "CLAUDE.md")).isSymbolicLink()).toBe(true);
  });

  it("is safe to run twice (a second launch finds everything linked)", () => {
    syncLinks(b, env);
    expect(syncLinks(b, env)).toEqual([]);
  });
});
