import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocked by the same specifier catalogEgress.js uses. The real module reaches
// the database, which would make this suite depend on a DB file.
const resolveConnectionProxyConfig = vi.fn();

vi.mock("@/lib/network/connectionProxy.js", () => ({
  resolveConnectionProxyConfig: (...a) => resolveConnectionProxyConfig(...a),
  pickProxyPoolId: vi.fn(),
}));

const POOL = {
  connectionProxyEnabled: true,
  connectionProxyUrl: "http://pool-a.internal:8080",
  connectionNoProxy: "",
  vercelRelayUrl: "",
  strictProxy: true,
  source: "pool",
};

const conn = (psd, id = "c1") => ({ id, providerSpecificData: psd });

describe("resolveCatalogEgress", () => {
  let resolveCatalogEgress;

  beforeEach(async () => {
    vi.resetModules();
    resolveConnectionProxyConfig.mockReset();
    ({ resolveCatalogEgress } = await import("../../src/lib/network/catalogEgress.js"));
  });

  it("goes direct when the connection carries no providerSpecificData", async () => {
    expect(await resolveCatalogEgress(conn(null))).toBe(null);
    expect(resolveConnectionProxyConfig).not.toHaveBeenCalled();
  });

  it("resolves the connection's own pool", async () => {
    resolveConnectionProxyConfig.mockResolvedValue(POOL);
    const bag = await resolveCatalogEgress(conn({ proxyPoolId: "pool-a" }));
    expect(resolveConnectionProxyConfig).toHaveBeenCalledWith({ proxyPoolId: "pool-a" });
    expect(bag.connectionProxyUrl).toBe("http://pool-a.internal:8080");
  });

  it("carries the pool's strictProxy into the bag", async () => {
    // Without it a catalog lookup silently falls back to direct egress, which
    // on this host means a blocked packet instead of a proxied request.
    resolveConnectionProxyConfig.mockResolvedValue(POOL);
    expect((await resolveCatalogEgress(conn({ proxyPoolId: "pool-a" }))).strictProxy).toBe(true);
  });

  it("goes direct when the connection resolves to no pool", async () => {
    resolveConnectionProxyConfig.mockResolvedValue({ source: "none" });
    expect(await resolveCatalogEgress(conn({}))).toBe(null);
  });

  it("never throws when resolution fails", async () => {
    // A catalog lookup is a convenience; the dashboard falls back to the static
    // model list. Failing the whole request over a pool read would be worse.
    resolveConnectionProxyConfig.mockRejectedValue(new Error("db locked"));
    expect(await resolveCatalogEgress(conn({ proxyPoolId: "pool-a" }))).toBe(null);
  });
});

describe("withCatalogEgress", () => {
  let withCatalogEgress;
  let readAmbient;

  beforeEach(async () => {
    vi.resetModules();
    resolveConnectionProxyConfig.mockReset();
    ({ withCatalogEgress } = await import("../../src/lib/network/catalogEgress.js"));
    // Same module instance the wrapper just loaded: vi.resetModules() gives the
    // fresh graph its own AsyncLocalStorage, so a static import here would be a
    // different store and always read null — indistinguishable from a bug.
    ({ getAmbientProxyOptions: readAmbient } = await import("../../open-sse/utils/egressContext.js"));
  });

  afterEach(() => {
    expect(readAmbient()).toBe(null); // the store must not outlive the wrapper
  });

  const byPool = () => resolveConnectionProxyConfig.mockImplementation(async ({ proxyPoolId }) => ({
    ...POOL, connectionProxyUrl: `http://${proxyPoolId}:8080`,
  }));

  it("exposes the pool to everything inside the body", async () => {
    byPool();
    await withCatalogEgress(conn({ proxyPoolId: "pool-a" }), async () => {
      expect(readAmbient().connectionProxyUrl).toBe("http://pool-a:8080");
    });
  });

  it("passes null inside the body when the connection has no pool", async () => {
    await withCatalogEgress(conn(null), async () => {
      expect(readAmbient()).toBe(null);
    });
  });

  it("clears the store even when the lookup throws", async () => {
    byPool();
    await expect(withCatalogEgress(conn({ proxyPoolId: "pool-a" }), async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
  });

  it("keeps two concurrent catalog lookups on their own pools", async () => {
    // `/v1/models` walks every connection; two of them resolving at once must
    // not swap relays — the whole risk of an ambient design.
    byPool();
    const seen = [];
    const lookup = (pool, delay) => withCatalogEgress(conn({ proxyPoolId: pool }), async () => {
      await new Promise((r) => setTimeout(r, delay));
      seen.push([pool, readAmbient().connectionProxyUrl]);
    });
    // Deliberately out of order: the slow chain must come back to its own pool.
    await Promise.all([lookup("pool-a", 20), lookup("pool-b", 2)]);
    expect(seen.sort()).toEqual([
      ["pool-a", "http://pool-a:8080"],
      ["pool-b", "http://pool-b:8080"],
    ]);
  });

  it("resolves the pool once per lookup, not once per fetch", async () => {
    byPool();
    await withCatalogEgress(conn({ proxyPoolId: "pool-a" }), async () => {
      readAmbient(); readAmbient(); readAmbient();
    });
    expect(resolveConnectionProxyConfig).toHaveBeenCalledTimes(1);
  });
});
