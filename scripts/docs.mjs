// Copy planhop's compiled choose.js to the marketing page as a classic script
// (so the page also works when opened from disk, where modules are blocked).
import { readFileSync, writeFileSync } from "node:fs";

const src = readFileSync("dist/choose.js", "utf8");
const names = [...src.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]);
const body = src.replace(/^export /gm, "");
writeFileSync(
  "docs/choose.js",
  `// Generated from src/choose.ts by \`pnpm docs\`. Do not edit.\n(() => {\n${body}\nglobalThis.planhopChoose = { ${names.join(", ")} };\n})();\n`,
);
console.log(`docs/choose.js: ${names.join(", ")}`);
