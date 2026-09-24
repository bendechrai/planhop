import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { modeOf, writeAtomic } from "./fsutil.js";
import { collapseHome, home, type Env } from "./paths.js";

export const BEGIN = "# >>> planhop >>>";
export const END = "# <<< planhop <<<";

export interface Rc {
  shell: "zsh" | "bash" | "fish";
  /** the startup file to edit */
  path: string;
  /** the line that puts `dir` first on PATH, in that shell's syntax */
  line: string;
}

/** `dir` with the home folder written as $HOME, for a portable startup-file line. */
function portable(dir: string, env: Env): string {
  return collapseHome(dir, env).replace(/^~(?=\/|$)/, "$HOME");
}

/** The startup file for the user's login shell, and the PATH line for it. */
export function detectRc(dir: string, env: Env = process.env, platform: NodeJS.Platform = process.platform): Rc | undefined {
  const shell = basename(env.SHELL ?? "");
  const h = home(env);
  const d = portable(dir, env);
  if (shell === "zsh") return { shell, path: join(env.ZDOTDIR ?? h, ".zshrc"), line: `export PATH="${d}:$PATH"` };
  if (shell === "bash") {
    // Terminal apps on macOS start login shells, which read ~/.bash_profile, not ~/.bashrc
    return { shell, path: join(h, platform === "darwin" ? ".bash_profile" : ".bashrc"), line: `export PATH="${d}:$PATH"` };
  }
  if (shell === "fish") {
    const conf = join(env.XDG_CONFIG_HOME ?? join(h, ".config"), "fish", "conf.d", "planhop.fish");
    return { shell, path: conf, line: `fish_add_path --prepend --move "${d}"` };
  }
  return undefined;
}

function block(line: string): string {
  return `${BEGIN}\n# Put planhop's \`claude\` first so it picks the account (planhop shim --remove undoes this)\n${line}\n${END}\n`;
}

const BLOCK_RE = new RegExp(`\\n?${BEGIN}\\n[\\s\\S]*?${END}\\n?`);

/**
 * Add or refresh planhop's block at the end of a startup file. At the end so
 * it runs after anything else that puts a `claude` on PATH (nvm, installers).
 * Writes through a symlinked file (dotfiles managers) rather than replacing it.
 */
export function installRcBlock(path: string, line: string): "added" | "updated" | "unchanged" {
  const target = existsSync(path) ? realpathSync(path) : path;
  const before = existsSync(target) ? readFileSync(target, "utf8") : "";
  const had = BLOCK_RE.test(before);
  const without = before.replace(BLOCK_RE, "\n").replace(/\n+$/, "");
  const after = `${without}${without ? "\n\n" : ""}${block(line)}`;
  if (after === before) return "unchanged";
  writeAtomic(target, after, modeOf(target, 0o644));
  return had ? "updated" : "added";
}

/** Take planhop's block out of a startup file; true if there was one. */
export function removeRcBlock(path: string): boolean {
  if (!existsSync(path)) return false;
  const target = realpathSync(path);
  const before = readFileSync(target, "utf8");
  if (!BLOCK_RE.test(before)) return false;
  writeAtomic(target, before.replace(BLOCK_RE, "\n").replace(/\n{3,}/g, "\n\n"), modeOf(target, 0o644));
  return true;
}
