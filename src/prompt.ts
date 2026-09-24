import { closeSync, openSync, readSync } from "node:fs";

/** True when there's a person at a terminal to answer questions. */
export function canAsk(): boolean {
  return process.stdin.isTTY && process.stderr.isTTY;
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read one line, waiting for it. Reads the terminal device itself: Node can
 * leave stdin non-blocking (it does on Linux), and a plain read of fd 0 then
 * returns straight away with EAGAIN instead of waiting for the answer.
 */
function readLine(): string | undefined {
  let fd: number | undefined;
  let own = false;
  try {
    fd = openSync("/dev/tty", "r");
    own = true;
  } catch {
    fd = 0;
  }
  const buf = Buffer.alloc(256);
  let line = "";
  try {
    while (!line.includes("\n")) {
      let n: number;
      try {
        n = readSync(fd, buf, 0, buf.length, null);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EAGAIN") {
          sleepMs(20);
          continue;
        }
        throw e;
      }
      if (n <= 0) break;
      line += buf.subarray(0, n).toString("utf8");
    }
  } catch {
    return undefined;
  } finally {
    if (own) closeSync(fd);
  }
  return line;
}

/**
 * Ask on stderr and read one line from the terminal. Synchronous on purpose:
 * it runs inside `planhop pick`, whose stdout the shim is capturing.
 * Returns undefined when there's no terminal or nothing was read.
 */
export function ask(question: string): string | undefined {
  if (!canAsk()) return undefined;
  process.stderr.write(question);
  return readLine()?.trim();
}
