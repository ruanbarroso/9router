// Gate: so kết quả test hiện tại với baseline known-fails.
// PASS nếu KHÔNG có test nào pass(baseline) → fail(now). Test mới được phép.
// Usage: node tests/__baseline__/verify-no-regression.mjs <current-results.json>
import { readdirSync, readFileSync } from "fs";

// Every known-fails*.txt in this directory contributes to the baseline, so a new
// snapshot can be added as its own dated file instead of rewriting the original —
// regenerating one big list in place is how a real regression gets laundered in.
const baselineDir = new URL("./", import.meta.url);
const knownFails = new Set(
  readdirSync(baselineDir)
    .filter(f => f.startsWith("known-fails") && f.endsWith(".txt"))
    .flatMap(f => readFileSync(new URL(f, baselineDir), "utf8").split("\n"))
    .map(s => s.trim()).filter(s => s && !s.startsWith("#"))
);

const resultsPath = process.argv[2];
if (!resultsPath) { console.error("Missing results.json path"); process.exit(2); }

// Baseline keys are repo-relative ("tests/unit/foo.test.js :: ..."). The absolute
// path in results.json varies by machine: "/app/tests/..." in CI, but
// "C:\Users\...\9router\tests\..." on Windows. Anchor on the last "/tests/"
// segment instead of splitting on a hardcoded "/app/" prefix, which yields
// undefined off-container and makes every failure look like a regression.
function toBaselineKey(filePath) {
  const normalized = String(filePath).replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/tests/");
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

const r = JSON.parse(readFileSync(resultsPath, "utf8"));
const nowFails = r.testResults.flatMap(f =>
  f.assertionResults.filter(a => a.status === "failed")
    .map(a => toBaselineKey(f.name) + " :: " + a.fullName)
);

// Regression = fail bây giờ NHƯNG không có trong baseline known-fails
const regressions = nowFails.filter(f => !knownFails.has(f));

if (regressions.length) {
  console.error(`\n❌ REGRESSION: ${regressions.length} test pass→fail:\n`);
  regressions.forEach(f => console.error("  - " + f));
  process.exit(1);
}
console.log(`✅ No regression. (now fails=${nowFails.length}, baseline known=${knownFails.size}, all known)`);
