import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";

interface Run { i: number; from: number; to: number }
interface Sim { runs: Run[]; waiting: number; wanted: number; unused: number }
interface PlanhopSim {
  simulate: (resets: number[], rate: number, day: number, record: boolean) => Sim;
  subscriptionsNeeded: (rate: number, day: number) => number | null;
  coverage: (sim: Sim, n: number, rate: number, day: number) => number;
  rateOf: (level: number) => number;
  MEASURE: number;
}

let m: PlanhopSim;

beforeAll(() => {
  // Load the page's scripts exactly as the browser does: choose.js (generated from src) then sim.js
  runInThisContext(readFileSync("docs/choose.js", "utf8"));
  runInThisContext(readFileSync("docs/sim.js", "utf8"));
  m = (globalThis as unknown as { planhopSim: PlanhopSim }).planhopSim;
});

const busyTime = (runs: Run[]): number => runs.reduce((t, r) => t + (r.to - r.from), 0);

describe("the page's planning model", () => {
  it("covers the default example with two subscriptions", () => {
    const rate = m.rateOf(21);
    const sim = m.simulate([124, 45], rate, 24, true);
    expect(m.coverage(sim, 2, rate, 24)).toBeGreaterThan(0.995);
  });

  it("uses Claude Code continuously around the clock when there's quota (no gaps at midnight)", () => {
    const sim = m.simulate([124, 45, 1], m.rateOf(22), 24, true);
    expect(sim.waiting).toBe(0);
    expect(busyTime(sim.runs)).toBeCloseTo(m.MEASURE, 6);
    for (let k = 1; k < sim.runs.length; k++) {
      expect(sim.runs[k]?.from).toBeCloseTo(sim.runs[k - 1]?.to ?? -1, 6);
    }
  });

  it("only uses Claude Code during the hours in use", () => {
    const sim = m.simulate([124, 45], m.rateOf(30), 8, true);
    for (const r of sim.runs) {
      const startOfDay = Math.floor(r.from / 24) * 24;
      expect(r.to).toBeLessThanOrEqual(startOfDay + 8 + 1e-6);
    }
  });

  it("never claims fewer subscriptions than the weekly demand needs", () => {
    // ~229% of one subscription's week each week: two can't keep up however the resets fall
    const rate = m.rateOf(25);
    const even = m.simulate([84, 168], rate, 24, false);
    expect(m.coverage(even, 2, rate, 24)).toBeLessThan(0.995);
    expect(m.subscriptionsNeeded(rate, 24)).toBe(3);
  });

  it("switches to another subscription when a 5-hour window fills", () => {
    const sim = m.simulate([124, 45], m.rateOf(60), 8, true);
    const firstDay = sim.runs.filter((r) => r.from < 8);
    expect(new Set(firstDay.map((r) => r.i)).size).toBe(2);
  });

  it("needs 21 subscriptions at the top of the scale around the clock", () => {
    expect(m.subscriptionsNeeded(m.rateOf(100), 24)).toBe(21);
  });
});
