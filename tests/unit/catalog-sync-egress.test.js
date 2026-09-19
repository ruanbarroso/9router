import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The catalog sync is the one egress path in the tree that belongs to no
// connection: models.dev is a global source, so there is no providerSpecificData
// to resolve a pool from. On a proxy-required host it therefore cannot run at
// all — which is fine, the module is built to degrade to the built-in tables —
// but the retry loop turned that into a refusal line every 30 minutes, reading
// like a live incident to anyone tailing the journal.

const blocked = () => Object.assign(new Error("[Egress] Direct connection refused"), {
  code: "EGRESS_DIRECT_BLOCKED",
});

describe("model catalog sync under a fail-closed egress policy", () => {
  let sync;
  let fetchMock;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    // The real reader touches the database and the filesystem; neither is what
    // this file is about.
    vi.doMock("open-sse/providers/catalogOverride.js", () => ({
      CATALOG_FILE: "/tmp/does-not-matter.json",
      CATALOG_RAW_FILE: "/tmp/does-not-matter.raw.json",
      CATALOG_VERSION: 1,
      invalidateCatalog: () => {},
      installCatalogSource: async () => {},
    }));
    sync = await import("@/lib/modelCatalog/sync.js");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.doUnmock("open-sse/providers/catalogOverride.js");
  });

  it("stops scheduling once egress policy refuses the fetch", async () => {
    fetchMock.mockRejectedValue(blocked());

    sync.startModelCatalogSync();
    await vi.advanceTimersByTimeAsync(61_000); // past the startup delay
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A whole day of retries would have fired by now if the refusal were being
    // read as transient.
    await vi.advanceTimersByTimeAsync(25 * 60 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still retries an ordinary failure — a refusal is not the same as a bad day", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));

    sync.startModelCatalogSync();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(31 * 60 * 1000); // one RETRY_DELAY_MS
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("records the refusal in the state the dashboard route reads", async () => {
    fetchMock.mockRejectedValue(blocked());
    expect(await sync.syncModelCatalog()).toBe(null);
    expect(sync.getSyncState().lastError).toMatch(/refused/i);
  });
});
