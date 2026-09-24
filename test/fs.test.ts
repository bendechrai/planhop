import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { accessToken, accountEmail, keychainService } from "../src/credentials.js";
import { claudeJsonPath } from "../src/paths.js";
import { findRealClaude, SHIM_MARKER } from "../src/realbin.js";
import { seedClaudeJson, syncLinks } from "../src/share.js";

let home: string;
let env: Record<string, string>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "planhop-"));
  env = { HOME: home, PATH: "" };
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), "{}");
  writeFileSync(join(home, ".claude", ".credentials.json"), "secret-a");
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "a@example.com" }, userID: "x", mcpServers: { m: { url: "u" } }, numStartups: 3 }),
  );
});

describe("credentials", () => {
  it("names Keychain entries like Claude Code does", () => {
    expect(keychainService(join(home, ".claude"), env)).toBe("Claude Code-credentials");
    // sha256("/Users/ben/.claude-b") starts 14c698fe; verified against a real Claude Code login
    expect(keychainService("/Users/ben/.claude-b", { HOME: "/Users/ben" })).toBe("Claude Code-credentials-14c698fe");
  });

  it("reads Linux credentials files and ignores expired tokens", () => {
    const dir = join(home, ".claude-b");
    mkdirSync(dir);
    const now = 1_000_000;
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: now + 3_600_000 } }));
    expect(accessToken(dir, env, "linux", now)).toBe("tok");
    expect(accessToken(dir, env, "linux", now + 7_200_000)).toBeUndefined();
    expect(accessToken(join(home, "nope"), env, "linux", now)).toBeUndefined();
  });

  it("reads the logged-in email from the right .claude.json", () => {
    expect(accountEmail(join(home, ".claude"), env)).toBe("a@example.com");
    expect(claudeJsonPath(join(home, ".claude-b"), env)).toBe(join(home, ".claude-b", ".claude.json"));
  });
});

describe("share", () => {
  it("links shared items but never the login", () => {
    const dir = join(home, ".claude-b");
    syncLinks(dir, env);
    expect(lstatSync(join(dir, "projects")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, "settings.json"))).toBe(join(home, ".claude", "settings.json"));
    expect(existsSync(join(dir, ".credentials.json"))).toBe(false);
  });



  it("seeds .claude.json without the login or account keys, with private permissions", () => {
    const dir = join(home, ".claude-b");
    mkdirSync(dir);
    seedClaudeJson(dir, env);
    const seeded = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")) as Record<string, unknown>;
    expect(seeded.oauthAccount).toBeUndefined();
    expect(seeded.userID).toBeUndefined();
    expect(seeded.numStartups).toBe(3);
    expect(statSync(join(dir, ".claude.json")).mode & 0o777).toBe(0o600);
  });

});

describe("findRealClaude", () => {
  it("skips planhop shims on PATH", () => {
    const shimDir = join(home, "shim");
    const realDir = join(home, "real");
    mkdirSync(shimDir);
    mkdirSync(realDir);
    writeFileSync(join(shimDir, "claude"), `#!/bin/sh\n# ${SHIM_MARKER}\n`);
    writeFileSync(join(realDir, "claude"), "#!/bin/sh\necho real\n");
    chmodSync(join(shimDir, "claude"), 0o755);
    chmodSync(join(realDir, "claude"), 0o755);
    expect(findRealClaude({ HOME: home, PATH: `${shimDir}:${realDir}` })).toBe(join(realDir, "claude"));
    expect(findRealClaude({ HOME: home, PATH: shimDir })).toBeUndefined();
  });
});
