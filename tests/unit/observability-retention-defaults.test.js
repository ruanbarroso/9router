import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// getObservabilityConfig() reads `settings.observabilityX || <repo default>`,
// and DEFAULT_SETTINGS is always merged into settings — so the left operand is
// never falsy and the repo-side default is dead code. Raising retention in the
// repo alone silently changes nothing, which is exactly the bug this pins:
// the effective value lives in settingsRepo, and the two must agree.
function read(relPath) {
  return readFileSync(resolve("src/lib/db/repos", relPath), "utf8");
}

function num(source, pattern) {
  const m = source.match(pattern);
  expect(m, `pattern not found: ${pattern}`).toBeTruthy();
  return Number(m[1]);
}

describe("observability retention defaults", () => {
  const settings = read("settingsRepo.js");
  const repo = read("requestDetailsRepo.js");

  it("agrees on maxRecords between settingsRepo and requestDetailsRepo", () => {
    const fromSettings = num(settings, /observabilityMaxRecords:\s*(\d+)/);
    const fromRepo = num(repo, /DEFAULT_MAX_RECORDS\s*=\s*(\d+)/);
    expect(fromSettings).toBe(fromRepo);
  });

  it("agrees on maxJsonSize (both expressed in KB)", () => {
    const fromSettings = num(settings, /observabilityMaxJsonSize:\s*([\d.]+)/);
    const fromRepo = num(repo, /DEFAULT_MAX_JSON_SIZE_KB\s*=\s*([\d.]+)/);
    expect(fromSettings).toBe(fromRepo);
  });

  it("keeps retention deep enough to be a useful troubleshooting log", () => {
    // At a busy gateway's ~50 req/min, anything under a few thousand rows is
    // minutes of history and the Details tab only ever shows the request you
    // just made.
    expect(num(settings, /observabilityMaxRecords:\s*(\d+)/)).toBeGreaterThanOrEqual(10000);
  });

  it("keeps the worst-case row size bounded as retention grows", () => {
    // Four payload fields are each capped at maxJsonSize. Raising row count
    // without lowering this multiplies disk, so pin the product.
    const records = num(settings, /observabilityMaxRecords:\s*(\d+)/);
    const kb = num(settings, /observabilityMaxJsonSize:\s*([\d.]+)/);
    const worstCaseMB = (records * 4 * kb) / 1024;
    expect(worstCaseMB).toBeLessThanOrEqual(256);
  });
});
