import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pickShell, shellQuote, shimScript } from "../src/shell.js";

const sh = (code: string): string => execFileSync("/bin/sh", ["-c", code], { encoding: "utf8" });

describe("shellQuote", () => {
  it("round-trips awkward strings through the shell unchanged", () => {
    for (const s of ["plain", "with space", "it's", "$(touch /tmp/x)", "`id`", "a\"b", "semi;colon", "new\nline"]) {
      expect(sh(`printf %s ${shellQuote(s)}`)).toBe(s);
    }
  });
});

describe("pickShell", () => {
  it("sets the real binary, the config dir and PLANHOP_ACTIVE", () => {
    const code = pickShell("/opt/claude bin/claude", { dir: "/home/me/.claude-b", name: "b", isDefault: false });
    expect(code.startsWith("# planhop-pick\n")).toBe(true);
    expect(sh(`${code}\nprintf '%s|%s|%s' "$PLANHOP_REAL_CLAUDE" "$CLAUDE_CONFIG_DIR" "$PLANHOP_ACTIVE"`)).toBe("/opt/claude bin/claude|/home/me/.claude-b|b");
  });

  it("unsets CLAUDE_CONFIG_DIR for the default account", () => {
    const code = pickShell("/c", { dir: "/home/me/.claude", name: "a", isDefault: true });
    expect(sh(`CLAUDE_CONFIG_DIR=/stale; ${code}\nprintf '[%s]' "\${CLAUDE_CONFIG_DIR-unset}"`)).toBe("[unset]");
  });
});

describe("shim", () => {
  /** Run the shim with a fake `planhop` whose pick prints `pickOutput(pathToFakeClaude)`. */
  function runShim(pickOutput: (fakeClaude: string) => string): { status: number | null; stdout: string; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), "planhop-shim-"));
    mkdirSync(join(dir, "bin"));
    const fakeClaude = join(dir, "real-claude");
    writeFileSync(fakeClaude, `#!/bin/sh\nprintf 'ran %s in %s as %s' "$*" "$CLAUDE_CONFIG_DIR" "$PLANHOP_ACTIVE"\n`);
    const fakePlanhop = join(dir, "bin", "planhop");
    writeFileSync(fakePlanhop, `#!/bin/sh\ncat <<'OUT'\n${pickOutput(fakeClaude)}\nOUT\n`);
    const shim = join(dir, "claude");
    writeFileSync(shim, shimScript());
    for (const f of [fakePlanhop, fakeClaude, shim]) chmodSync(f, 0o755);
    const r = spawnSync(shim, ["-c"], { encoding: "utf8", env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin` } });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it("evals planhop's output and execs the real claude with the same arguments", () => {
    const r = runShim((claude) => pickShell(claude, { dir: "/b", name: "b", isDefault: false }));
    expect(r.stdout).toBe("ran -c in /b as b");
  });

  it("refuses to eval anything that doesn't start with the planhop header", () => {
    const r = runShim(() => "echo pwned");
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/unexpected output/);
  });
});
