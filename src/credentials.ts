import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeJsonPath, isDefaultDir, normalizeDir, type Env } from "./paths.js";

interface OAuthBlob {
  claudeAiOauth?: { accessToken?: string; expiresAt?: number };
}

/**
 * macOS Keychain service name Claude Code uses for a config dir. Not a documented
 * interface: default dir -> "Claude Code-credentials", otherwise a suffix of the
 * first 8 hex chars of sha256(absolute dir path).
 */
export function keychainService(dir: string, env: Env = process.env): string {
  if (isDefaultDir(dir, env)) return "Claude Code-credentials";
  const hash = createHash("sha256").update(normalizeDir(dir, env)).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

function readCredentialBlob(dir: string, env: Env, platform: NodeJS.Platform): string | undefined {
  try {
    if (platform === "darwin") {
      return execFileSync("security", ["find-generic-password", "-s", keychainService(dir, env), "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        // A locked Keychain can prompt and block; don't hang the launch waiting for it
        timeout: 5000,
      });
    }
    return readFileSync(join(normalizeDir(dir, env), ".credentials.json"), "utf8");
  } catch {
    return undefined;
  }
}

/** The account's current OAuth access token, or undefined if missing or about to expire. */
export function accessToken(
  dir: string,
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  now: number = Date.now(),
): string | undefined {
  const blob = readCredentialBlob(dir, env, platform);
  if (!blob) return undefined;
  let parsed: OAuthBlob;
  try {
    parsed = JSON.parse(blob) as OAuthBlob;
  } catch {
    return undefined;
  }
  const oauth = parsed.claudeAiOauth;
  if (!oauth?.accessToken || (oauth.expiresAt ?? 0) < now + 60_000) return undefined;
  return oauth.accessToken;
}

/** Email of the claude.ai account logged into this config dir. */
export function accountEmail(dir: string, env: Env = process.env): string | undefined {
  try {
    const cfg = JSON.parse(readFileSync(claudeJsonPath(dir, env), "utf8")) as {
      oauthAccount?: { emailAddress?: string } | null;
    };
    return cfg.oauthAccount?.emailAddress ?? undefined;
  } catch {
    return undefined;
  }
}
