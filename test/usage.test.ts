import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchLiveUsage, loadCache, saveCache, type Usage } from "../src/usage.js";

let env: Record<string, string>;
const reading = (name: string, u7: number): Usage => ({ name, dir: `/x/${name}`, u5: 0.1, r5: null, u7, r7: 1_900_000_000_000, fetchedAt: Date.now(), stale: false });

beforeEach(() => {
  env = { HOME: mkdtempSync(join(tmpdir(), "planhop-usage-")) };
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchLiveUsage", () => {
  it("turns percentages into fractions and resets into timestamps", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify({
      five_hour: { utilization: 14, resets_at: "2026-09-24T00:00:00.1+00:00" },
      seven_day: { utilization: 31, resets_at: "2026-09-29T03:00:00Z" },
    }))));
    const u = await fetchLiveUsage("tok");
    expect(u.u5).toBeCloseTo(0.14);
    expect(u.u7).toBeCloseTo(0.31);
    expect(u.r7).toBe(Date.parse("2026-09-29T03:00:00Z"));
  });

  it("treats junk values as zero instead of NaN, and missing resets as no window", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify({ five_hour: { utilization: "lots" }, seven_day: null }))));
    const u = await fetchLiveUsage("tok");
    expect(u.u5).toBe(0);
    expect(u.u7).toBe(0);
    expect(u.r5).toBeNull();
    expect(u.r7).toBeNull();
  });

  it("reports HTTP errors", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("no", { status: 401 })));
    await expect(fetchLiveUsage("tok")).rejects.toThrow(/401/);
  });
});

describe("usage cache", () => {
  it("merges readings from separate saves", () => {
    saveCache([reading("a", 0.3)], env);
    saveCache([reading("b", 0.6)], env);
    const cache = loadCache(env);
    expect(Object.keys(cache).sort()).toEqual(["a", "b"]);
    expect(cache.a?.u7).toBe(0.3);
  });

  it("drops malformed entries instead of passing them on", () => {
    mkdirSync(join(env.HOME ?? "", ".cache", "planhop"), { recursive: true });
    writeFileSync(join(env.HOME ?? "", ".cache", "planhop", "usage.json"), JSON.stringify({ a: reading("a", 0.2), bad: { name: "bad", u5: "x" } }));
    expect(Object.keys(loadCache(env))).toEqual(["a"]);
  });

  it("survives a corrupt cache file", () => {
    mkdirSync(join(env.HOME ?? "", ".cache", "planhop"), { recursive: true });
    writeFileSync(join(env.HOME ?? "", ".cache", "planhop", "usage.json"), "{not json");
    expect(loadCache(env)).toEqual({});
    saveCache([reading("a", 0.1)], env);
    expect(Object.keys(loadCache(env))).toEqual(["a"]);
  });
});
