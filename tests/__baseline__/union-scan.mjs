// Scratch helper: list failures across several results.json runs that are NOT
// already in the baseline, with how many runs each appeared in. A test that
// fails in some runs but not others is nondeterministic, not a regression.
// Usage: node tests/__baseline__/union-scan.mjs <run1.json> <run2.json> ...
import { readdirSync, readFileSync } from "fs";

const dir = new URL("./", import.meta.url);
const known = new Set(
  readdirSync(dir).filter(f => f.startsWith("known-fails") && f.endsWith(".txt"))
    .flatMap(f => readFileSync(new URL(f, dir), "utf8").split("\n"))
    .map(s => s.trim()).filter(s => s && !s.startsWith("#"))
);

const SEP = String.fromCharCode(92); // backslash, without escaping through a shell
const key = (p) => {
  const n = String(p).split(SEP).join("/");
  const i = n.lastIndexOf("/tests/");
  return i === -1 ? n : n.slice(i + 1);
};

const runs = process.argv.slice(2);
const seen = new Map();
for (const r of runs) {
  const j = JSON.parse(readFileSync(r, "utf8"));
  for (const f of j.testResults) {
    for (const a of f.assertionResults) {
      if (a.status !== "failed") continue;
      const k = key(f.name) + " :: " + a.fullName;
      if (!known.has(k)) seen.set(k, (seen.get(k) || 0) + 1);
    }
  }
}

console.log(`runs analisadas: ${runs.length}\n`);
for (const [k, c] of [...seen].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${c}/${runs.length}  ${k}`);
}
