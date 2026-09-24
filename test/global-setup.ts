import { execFileSync } from "node:child_process";

export default function setup(): void {
  execFileSync("pnpm", ["-s", "docs"], { stdio: "inherit" });
}
