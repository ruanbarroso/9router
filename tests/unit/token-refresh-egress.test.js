import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAmbientProxyOptions,
  runWithProxy,
  runWithoutProxy,
} from "../../open-sse/utils/egressContext.js";

describe("egressContext", () => {
  it("is null outside any store", () => {
    expect(getAmbientProxyOptions()).toBe(null);
  });

  it("exposes the bag inside the store", async () => {
    const bag = { connectionProxyEnabled: true, connectionProxyUrl: "http://p:1" };
    await runWithProxy(bag, async () => {
      expect(getAmbientProxyOptions()).toBe(bag);
    });
  });

  it("survives an await boundary", async () => {
    const bag = { strictProxy: true };
    await runWithProxy(bag, async () => {
      await new Promise((r) => setTimeout(r, 5));
      expect(getAmbientProxyOptions()).toBe(bag);
    });
  });

  it("is cleared after the store exits", async () => {
    await runWithProxy({ strictProxy: true }, async () => {});
    expect(getAmbientProxyOptions()).toBe(null);
  });

  it("is cleared even when the body throws", async () => {
    await expect(runWithProxy({ strictProxy: true }, async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(getAmbientProxyOptions()).toBe(null);
  });

  it("keeps concurrent chains apart", async () => {
    // The whole risk of an ambient design is one request seeing another's pool.
    const seen = [];
    const chain = (n, delay) => runWithProxy({ id: n }, async () => {
      await new Promise((r) => setTimeout(r, delay));
      seen.push([n, getAmbientProxyOptions().id]);
    });
    await Promise.all([chain(1, 20), chain(2, 5), chain(3, 12)]);
    expect(seen.every(([expected, actual]) => expected === actual)).toBe(true);
    expect(seen).toHaveLength(3);
  });

  it("does not shadow an outer pool with a null bag", async () => {
    // A failed pool lookup must not quietly downgrade a nested call to direct.
    const outer = { id: "outer" };
    await runWithProxy(outer, async () => {
      await runWithProxy(null, async () => {
        expect(getAmbientProxyOptions()).toBe(outer);
      });
    });
  });

  it("lets an inner store override an outer one", async () => {
    await runWithProxy({ id: "outer" }, async () => {
      await runWithProxy({ id: "inner" }, async () => {
        expect(getAmbientProxyOptions().id).toBe("inner");
      });
      expect(getAmbientProxyOptions().id).toBe("outer");
    });
  });

  it("runWithoutProxy opts a nested call out entirely", async () => {
    await runWithProxy({ id: "outer" }, async () => {
      await runWithoutProxy(async () => {
        expect(getAmbientProxyOptions()).toBe(null);
      });
    });
  });
});

// ─── tokenRefresh wiring ───────────────────────────────────────────────────

const resolveConnectionProxyConfig = vi.fn();

// Mocked by the SAME specifier tokenRefresh.js uses. The `@/` alias form does
// not intercept here: the dynamic import inside tokenRefresh.js is a relative
// path, and mocking the alias let the real module load and open the database.
vi.mock("../../src/lib/network/connectionProxy.js", () => ({
  resolveConnectionProxyConfig: (...a) => resolveConnectionProxyConfig(...a),
  pickProxyPoolId: vi.fn(),
}));

describe("refreshTokenByProvider — pool resolution", () => {
  let refreshTokenByProvider;
  let seenPerFetch;
  let realFetch;
  let fetchSpy;
  let fetchHandler;
  let readAmbient;

  const POOL = {
    source: "pool",
    proxyPoolId: "pool-7",
    connectionProxyEnabled: true,
    connectionProxyUrl: "http://proxy.internal:8080",
    connectionNoProxy: "",
    strictProxy: true,
  };

  beforeEach(async () => {
    vi.resetModules();
    resolveConnectionProxyConfig.mockReset();
    seenPerFetch = [];
    realFetch = globalThis.fetch;

    // Default handler: answer as the token endpoint. Tests swap `fetchHandler`
    // rather than globalThis.fetch, because proxyFetch.js captures
    // `originalFetch` at import time — a later reassignment is never seen.
    fetchHandler = async () => new Response(
      JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    fetchSpy = vi.fn((...args) => fetchHandler(...args));
    globalThis.fetch = fetchSpy;

    // Imported AFTER the spy is installed, so proxyFetch captures it as
    // originalFetch. The bare fetch() calls in the refresh providers then run
    // the real chain — patchedFetch → ambient lookup → proxyAwareFetch → spy —
    // which is the plumbing under test, not a stub of it.
    ({ refreshTokenByProvider } = await import("../../open-sse/services/tokenRefresh.js"));

    // Read the ambient bag through the SAME module instance tokenRefresh just
    // loaded. vi.resetModules() gives the fresh graph its own AsyncLocalStorage,
    // so this file's top-level import is a different store and always sees null
    // — which looks exactly like "the pool was never applied".
    ({ getAmbientProxyOptions: readAmbient } = await import("../../open-sse/utils/egressContext.js"));

    // Record the ambient bag as seen from inside proxyAwareFetch's caller.
    const inner = fetchHandler;
    fetchHandler = async (...args) => {
      seenPerFetch.push(readAmbient());
      return inner(...args);
    };
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const creds = (psd) => ({
    refreshToken: `rt-${Math.random()}`,
    providerSpecificData: psd,
  });

  it("resolves the pool once per call, not once per fetch", async () => {
    resolveConnectionProxyConfig.mockResolvedValue(POOL);
    await refreshTokenByProvider("claude", creds({ proxyPoolId: "pool-7" }), null);
    expect(resolveConnectionProxyConfig).toHaveBeenCalledTimes(1);
  });

  it("routes the refresh through the resolved pool", async () => {
    resolveConnectionProxyConfig.mockResolvedValue(POOL);
    await refreshTokenByProvider("claude", creds({ proxyPoolId: "pool-7" }), null);
    expect(seenPerFetch.length).toBeGreaterThan(0);
    for (const bag of seenPerFetch) {
      expect(bag?.connectionProxyUrl).toBe("http://proxy.internal:8080");
    }
  });

  it("carries strictProxy from the pool into the refresh", async () => {
    resolveConnectionProxyConfig.mockResolvedValue(POOL);
    await refreshTokenByProvider("claude", creds({ proxyPoolId: "pool-7" }), null);
    expect(seenPerFetch[0]?.strictProxy).toBe(true);
  });

  it("does not look up a pool when the connection has no provider data", async () => {
    await refreshTokenByProvider("claude", { refreshToken: "rt" }, null);
    expect(resolveConnectionProxyConfig).not.toHaveBeenCalled();
    expect(seenPerFetch[0]).toBe(null);
  });

  it("refreshes without a pool when source is none", async () => {
    resolveConnectionProxyConfig.mockResolvedValue({ source: "none", proxyPoolId: null });
    await refreshTokenByProvider("claude", creds({}), null);
    expect(seenPerFetch[0]).toBe(null);
  });

  it("a pool lookup that throws does not brick the refresh", async () => {
    // A broken pool table must degrade one connection's egress, not stop every
    // refresh on the box. Under REQUIRE_PROXY the guard then fails it by name.
    resolveConnectionProxyConfig.mockRejectedValue(new Error("db locked"));
    const warn = vi.fn();
    const out = await refreshTokenByProvider("claude", creds({ proxyPoolId: "p" }), { warn });
    expect(out).toBeTruthy();
    expect(warn).toHaveBeenCalled();
  });

  it("returns null without touching the network when there is no refresh token", async () => {
    const out = await refreshTokenByProvider("claude", { refreshToken: "" }, null);
    expect(out).toBe(null);
    expect(resolveConnectionProxyConfig).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps two concurrent refreshes on their own pools", async () => {
    // 26 production connections refresh in the background; a crossed store here
    // would send one account's token through another account's proxy.
    resolveConnectionProxyConfig.mockImplementation(async (psd) => ({
      ...POOL,
      proxyPoolId: psd.proxyPoolId,
      connectionProxyUrl: `http://${psd.proxyPoolId}:8080`,
    }));
    fetchHandler = async () => {
      const bag = readAmbient();
      // Deliberately finish out of order: the slow chain must still come back
      // to its own pool, not to the one the fast chain left behind.
      await new Promise((r) => setTimeout(r, bag.connectionProxyUrl.includes("aaa") ? 20 : 2));
      seenPerFetch.push(bag.connectionProxyUrl);
      return new Response(JSON.stringify({ access_token: "at", expires_in: 1 }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    await Promise.all([
      refreshTokenByProvider("claude", creds({ proxyPoolId: "aaa" }), null),
      refreshTokenByProvider("claude", creds({ proxyPoolId: "bbb" }), null),
    ]);
    expect(new Set(seenPerFetch)).toEqual(new Set(["http://aaa:8080", "http://bbb:8080"]));
  });
});
