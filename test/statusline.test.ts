import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { renderStatusline } from "../src/statusline.js";
import { saveCache } from "../src/usage.js";

let home: string;
let env: Record<string, string>;
const ESC = String.fromCharCode(27);
const plain = (s: string): string => s.split(ESC).map((part, i) => (i === 0 ? part : part.replace(/^\[[0-9;]*m/, ""))).join("");
const input = JSON.stringify({ workspace: { current_dir: "/tmp/proj" }, model: { display_name: "Opus" }, context_window: { used_percentage: 12 } });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "planhop-status-"));
  mkdirSync(join(home, ".claude-b"), { recursive: true });
  mkdirSync(join(home, ".config", "planhop"), { recursive: true });
  writeFileSync(join(home, ".config", "planhop", "config.json"), JSON.stringify({ accounts: { a: "~/.claude", b: "~/.claude-b" } }));
  writeFileSync(join(home, ".claude-b", ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "b@example.com" } }));
  env = { HOME: home, PATH: "/usr/bin:/bin", CLAUDE_CONFIG_DIR: join(home, ".claude-b") };
  const soon = Date.now() + 3_600_000;
  saveCache([{ name: "b", dir: join(home, ".claude-b"), u5: 0.25, r5: soon, u7: 0.6, r7: soon * 1 + 86_400_000, fetchedAt: Date.now(), stale: false }], env);
});

describe("renderStatusline", () => {
  it("shows the session's own account and that account's usage", () => {
    const line = plain(renderStatusline(input, {}, env));
    expect(line).toMatch(/^b@example.com \| proj \| Opus \| ctx 12% \| 5h 25% .* \| 7d 60% /);
  });

  it("puts the account in front of a wrapped command and passes it the usage", () => {
    const line = plain(renderStatusline(input, { wrap: 'printf "%s %s%%" "$PLANHOP_ACCOUNT" "$PLANHOP_7D_PCT"' }, env));
    expect(line).toBe("b@example.com | b 60%");
  });
});
