import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Questions must wait for an answer at a real terminal. Reading stdin directly
// returned at once on Linux (non-blocking stdin), which a unit test can't see.
const hasPython = spawnSync("python3", ["--version"]).status === 0;

describe.skipIf(!hasPython)("questions at a real terminal", () => {
  const run = (answer: string): string =>
    spawnSync("python3", [resolve("test/fixtures/pty-shim.py"), resolve("dist/cli.js"), answer], { encoding: "utf8", timeout: 30_000 }).stdout;

  it("waits for the answer and acts on yes", () => {
    const out = run("y");
    expect(out).toContain("waited for the answer: True");
    expect(out).toMatch(/Added planhop's PATH line/);
  });

  it("waits for the answer and changes nothing on no", () => {
    const out = run("n");
    expect(out).toContain("waited for the answer: True");
    expect(out).toMatch(/Not changed/);
  });
});
