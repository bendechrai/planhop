import { describe, expect, it } from "vitest";
import { cacheDir, configFile, stateDir } from "../src/paths.js";

describe("XDG base directories", () => {
  it("uses XDG variables that hold an absolute path", () => {
    const env = { HOME: "/home/u", XDG_CONFIG_HOME: "/cfg", XDG_CACHE_HOME: "/cache", XDG_STATE_HOME: "/state" };
    expect(configFile(env)).toBe("/cfg/planhop/config.json");
    expect(cacheDir(env)).toBe("/cache/planhop");
    expect(stateDir(env)).toBe("/state/planhop");
  });

  it("falls back to the defaults when an XDG variable is set but empty", () => {
    const env = { HOME: "/home/u", XDG_CONFIG_HOME: "", XDG_CACHE_HOME: "", XDG_STATE_HOME: "" };
    expect(configFile(env)).toBe("/home/u/.config/planhop/config.json");
    expect(cacheDir(env)).toBe("/home/u/.cache/planhop");
    expect(stateDir(env)).toBe("/home/u/.local/state/planhop");
  });

  it("ignores relative XDG paths, as the spec requires", () => {
    const env = { HOME: "/home/u", XDG_CONFIG_HOME: "cfg", XDG_CACHE_HOME: "./cache", XDG_STATE_HOME: "state" };
    expect(configFile(env)).toBe("/home/u/.config/planhop/config.json");
    expect(cacheDir(env)).toBe("/home/u/.cache/planhop");
    expect(stateDir(env)).toBe("/home/u/.local/state/planhop");
  });
});
