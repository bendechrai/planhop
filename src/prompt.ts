import { readSync } from "node:fs";

/** True when there's a person at a terminal to answer questions. */
export function canAsk(): boolean {
  return process.stdin.isTTY && process.stderr.isTTY;
}

/**
 * Ask on stderr and read one line from the terminal. Synchronous on purpose:
 * it runs inside `planhop pick`, whose stdout the shim is capturing.
 * Returns undefined when there's no terminal or nothing was read.
 */
export function ask(question: string): string | undefined {
  if (!canAsk()) return undefined;
  process.stderr.write(question);
  const buf = Buffer.alloc(64);
  let line = "";
  try {
    while (!line.includes("\n")) {
      const n = readSync(0, buf, 0, buf.length, null);
      if (n <= 0) break;
      line += buf.subarray(0, n).toString("utf8");
    }
  } catch {
    return undefined;
  }
  return line.trim();
}
