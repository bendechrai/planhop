import { execFileSync } from "node:child_process";

export default function setup(): void {
  execFileSync("pnpm", ["-s", "run", "docs"], { stdio: "inherit" });
}
