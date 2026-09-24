import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Json = Record<string, unknown>;

/** Parsed JSON object, or undefined if the file is missing, unreadable or not an object. */
export function readJson(path: string): Json | undefined {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write via a uniquely named temp file and rename, so readers never see a
 * partial file and concurrent writers never share a temp file.
 */
export function writeAtomic(path: string, data: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${String(process.pid)}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, data, { mode });
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* never created */
    }
    throw e;
  }
}

/** Current permission bits of a file, or `fallback` if it doesn't exist. */
export function modeOf(path: string, fallback = 0o600): number {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return fallback;
  }
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Take an exclusive lock file (created with O_EXCL) for `fn`. Waits up to
 * `waitMs`; a lock older than `staleMs` is assumed abandoned and taken over.
 * If the lock can't be had in time, runs `fn` anyway rather than blocking a launch.
 */
export function withLock<T>(lockPath: string, fn: () => T, waitMs = 2000, staleMs = 10_000): T {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + waitMs;
  let held = false;
  while (!held) {
    try {
      closeSync(openSync(lockPath, "wx"));
      held = true;
    } catch {
      let age: number;
      try {
        age = Date.now() - statSync(lockPath).mtimeMs;
      } catch {
        continue; // released between our attempts
      }
      if (age > staleMs) {
        try {
          unlinkSync(lockPath);
        } catch {
          /* someone else took it over */
        }
        continue;
      }
      if (Date.now() > deadline) break;
      sleepMs(15);
    }
  }
  try {
    return fn();
  } finally {
    if (held) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* already gone */
      }
    }
  }
}

/** Create `path` only if it doesn't exist; true if this call created it. */
export function createExclusive(path: string): boolean {
  mkdirSync(dirname(path), { recursive: true });
  try {
    closeSync(openSync(path, "wx"));
    return true;
  } catch {
    return false;
  }
}
