import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Questions must wait for an answer at a real terminal. Reading stdin directly
// returned at once on Linux (non-blocking stdin), which a unit test can't see.
const hasPython = spawnSync("python3", ["--version"]).status === 0;

function run(home: string, answers: string[], args: string[]): string {
  return spawnSync("python3", [resolve("test/fixtures/pty-run.py"), resolve("dist/cli.js"), home, ...answers, "--", ...args], {
    encoding: "utf8",
    timeout: 40_000,
  }).stdout;
}

describe.skipIf(!hasPython)("questions at a real terminal", () => {
  it("shim: waits for each answer, adds the PATH line on yes, skips the status line on no", () => {
    const home = mkdtempSync(join(tmpdir(), "planhop-pty-"));
    const out = run(home, ["y", "n"], ["shim"]);
    expect(out).toContain("questions: 2 all waited: True");
    expect(out).toMatch(/Added planhop's PATH line/);
    expect(out).toMatch(/Skipped\. Add it later/);
  });

  it("shim: changes nothing on no", () => {
    const home = mkdtempSync(join(tmpdir(), "planhop-pty-"));
    const out = run(home, ["n"], ["shim"]);
    expect(out).toContain("all waited: True");
    expect(out).toMatch(/Not changed/);
  });

  it("statusline --install: asks how to combine with an existing status line", () => {
    const home = mkdtempSync(join(tmpdir(), "planhop-pty-"));
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "meko-statusline.sh" } }));
    const out = run(home, ["1"], ["statusline", "--install"]);
    expect(out).toContain("questions: 1 all waited: True");
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as { statusLine: { command: string } };
    expect(settings.statusLine.command).toBe("planhop statusline --append 'meko-statusline.sh'");
  });
});
