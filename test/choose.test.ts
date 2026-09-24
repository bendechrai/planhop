import { describe, expect, it } from "vitest";
import { choose, fmtHours, score } from "../src/choose.js";
import type { Usage } from "../src/usage.js";

const H = 3_600_000;
const now = Date.UTC(2026, 8, 23, 12);

function acct(name: string, u5: number, h5: number | null, u7: number, h7: number | null): Usage {
  return {
    name,
    dir: `/tmp/${name}`,
    u5,
    r5: h5 === null ? null : now + h5 * H,
    u7,
    r7: h7 === null ? null : now + h7 * H,
    fetchedAt: now,
    stale: false,
  };
}

const pickName = (...accounts: Usage[]): string | undefined => choose(accounts.map((a) => score(a, now)))?.name;

describe("choose", () => {
  it("spends the quota that expires soonest, even if it's nearly used", () => {
    expect(pickName(acct("a", 0.2, 2, 0.95, 4), acct("b", 0.1, 3, 0.05, 72))).toBe("a");
  });

  it("skips an account whose 5h window is full", () => {
    expect(pickName(acct("a", 1, 1, 0.95, 4), acct("b", 0.1, 3, 0.05, 72))).toBe("b");
  });

  it("breaks near ties with 5h quota about to expire", () => {
    expect(pickName(acct("a", 0.1, 4.5, 0.5, 50), acct("b", 0.2, 0.5, 0.5, 53))).toBe("b");
  });

  it("does not treat resets more than TIE_HOURS apart as a tie", () => {
    expect(pickName(acct("a", 0.1, 4.5, 0.5, 50), acct("b", 0.2, 0.5, 0.5, 60))).toBe("a");
  });

  it("puts accounts whose week hasn't started last", () => {
    expect(pickName(acct("a", 0.1, 4, 0.9, 150), acct("b", 0, null, 0, null))).toBe("a");
  });

  it("uses an idle account when the active one is full", () => {
    expect(pickName(acct("a", 0.1, 4, 1, 150), acct("b", 0, null, 0, null))).toBe("b");
  });

  it("when all are blocked, picks the one that frees up soonest", () => {
    expect(pickName(acct("a", 1, 3, 0.5, 50), acct("b", 0.2, 1, 1, 20))).toBe("a");
  });

  it("treats windows whose reset has passed as fresh", () => {
    const stale = { ...acct("a", 1, null, 1, null), r5: now - H, r7: now - H };
    const s = score(stale, now);
    expect(s.blocked).toBe(false);
    expect(s.u5).toBe(0);
    expect(s.u7).toBe(0);
  });

  it("returns undefined for no accounts", () => {
    expect(choose([])).toBeUndefined();
  });
});

describe("fmtHours", () => {
  it("formats hours and days", () => {
    expect(fmtHours(null)).toBe("idle");
    expect(fmtHours(1.5)).toBe("1h30m");
    expect(fmtHours(45)).toBe("1d21h");
  });
});
