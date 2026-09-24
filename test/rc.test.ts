import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { BEGIN, detectRc, END, installRcBlock, removeRcBlock } from "../src/rc.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "planhop-rc-"));
});
const bin = (): string => join(home, ".local", "share", "planhop", "bin");

describe("detectRc", () => {
  it("finds the right startup file per shell and platform", () => {
    expect(detectRc(bin(), { HOME: home, SHELL: "/bin/zsh" }, "darwin")?.path).toBe(join(home, ".zshrc"));
    expect(detectRc(bin(), { HOME: home, SHELL: "/bin/zsh", ZDOTDIR: join(home, "z") }, "linux")?.path).toBe(join(home, "z", ".zshrc"));
    expect(detectRc(bin(), { HOME: home, SHELL: "/bin/bash" }, "linux")?.path).toBe(join(home, ".bashrc"));
    expect(detectRc(bin(), { HOME: home, SHELL: "/bin/bash" }, "darwin")?.path).toBe(join(home, ".bash_profile"));
    expect(detectRc(bin(), { HOME: home, SHELL: "/usr/bin/fish" }, "linux")?.path).toBe(join(home, ".config", "fish", "conf.d", "planhop.fish"));
    expect(detectRc(bin(), { HOME: home, SHELL: "/bin/tcsh" }, "linux")).toBeUndefined();
  });

  it("writes the line with $HOME so it survives a changed home path", () => {
    expect(detectRc(bin(), { HOME: home, SHELL: "/bin/bash" }, "linux")?.line).toBe('export PATH="$HOME/.local/share/planhop/bin:$PATH"');
    expect(detectRc(bin(), { HOME: home, SHELL: "/usr/bin/fish" }, "linux")?.line).toBe('fish_add_path --prepend --move "$HOME/.local/share/planhop/bin"');
  });
});

describe("installRcBlock / removeRcBlock", () => {
  const line = 'export PATH="$HOME/.local/share/planhop/bin:$PATH"';

  it("appends one block at the end, and is idempotent", () => {
    const rc = join(home, ".bashrc");
    writeFileSync(rc, "export NVM_DIR=x\n. nvm.sh\n");
    expect(installRcBlock(rc, line)).toBe("added");
    expect(installRcBlock(rc, line)).toBe("unchanged");
    const text = readFileSync(rc, "utf8");
    expect(text.startsWith("export NVM_DIR=x\n. nvm.sh\n")).toBe(true);
    expect(text.trimEnd().endsWith(END)).toBe(true);
    expect(text.split(BEGIN).length).toBe(2);
  });

  it("moves an existing block back to the end when other lines were added after it", () => {
    const rc = join(home, ".zshrc");
    writeFileSync(rc, "a\n");
    installRcBlock(rc, line);
    writeFileSync(rc, readFileSync(rc, "utf8") + "export PATH=/later:$PATH\n");
    expect(installRcBlock(rc, line)).toBe("updated");
    const text = readFileSync(rc, "utf8");
    expect(text.indexOf("/later")).toBeLessThan(text.indexOf(BEGIN));
  });

  it("creates the file (and fish's conf.d) when missing", () => {
    const rc = join(home, ".config", "fish", "conf.d", "planhop.fish");
    mkdirSync(join(home, ".config", "fish", "conf.d"), { recursive: true });
    expect(installRcBlock(rc, "fish_add_path x")).toBe("added");
    expect(readFileSync(rc, "utf8")).toContain("fish_add_path x");
  });

  it("writes through a symlinked startup file instead of replacing the link", () => {
    const real = join(home, "dotfiles-zshrc");
    writeFileSync(real, "a\n");
    const rc = join(home, ".zshrc");
    symlinkSync(real, rc);
    installRcBlock(rc, line);
    expect(readlinkSync(rc)).toBe(real);
    expect(readFileSync(real, "utf8")).toContain(BEGIN);
  });

  it("removes only planhop's block", () => {
    const rc = join(home, ".bashrc");
    writeFileSync(rc, "before\n");
    installRcBlock(rc, line);
    expect(removeRcBlock(rc)).toBe(true);
    expect(readFileSync(rc, "utf8").trim()).toBe("before");
    expect(removeRcBlock(rc)).toBe(false);
  });
});
