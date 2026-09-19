import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocked by the same specifiers egress.js uses. Both reach the database; the
// real modules would open it and make this suite depend on a DB file.
const getSettings = vi.fn();
const resolveConnectionProxyConfig = vi.fn();

vi.mock("@/lib/db/index.js", () => ({ getSettings: (...a) => getSettings(...a) }));
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
};

describe("resolveOAuthEgress", () => {
  let resolveOAuthEgress;
  let describeOAuthEgressFailure;

  beforeEach(async () => {
    vi.resetModules();
    getSettings.mockReset();
    resolveConnectionProxyConfig.mockReset();
    ({ resolveOAuthEgress, describeOAuthEgressFailure } = await import("../../src/lib/oauth/egress.js"));
  });

  it("goes direct when the provider has no strategy entry", async () => {
    getSettings.mockResolvedValue({ providerStrategies: {} });
    const e = await resolveOAuthEgress("codex");
    expect(e.mode).toBe("unconfigured");
    expect(e.proxyOptions).toBe(null);
  });

  it("goes direct without touching settings when no provider is given", async () => {
    const e = await resolveOAuthEgress("");
    expect(e.mode).toBe("unconfigured");
    expect(getSettings).not.toHaveBeenCalled();
  });

  it("resolves the pool configured for that provider", async () => {
    getSettings.mockResolvedValue({ providerStrategies: { codex: { proxyPoolId: "pool-a" } } });
    resolveConnectionProxyConfig.mockResolvedValue(POOL);
    const e = await resolveOAuthEgress("codex");
    expect(resolveConnectionProxyConfig).toHaveBeenCalledWith({ proxyPoolId: "pool-a" });
    expect(e.mode).toBe("pool");
    expect(e.poolId).toBe("pool-a");
    expect(e.proxyOptions.connectionProxyUrl).toBe("http://pool-a.internal:8080");
  });

  it("carries the pool's strictProxy into the bag", async () => {
    // Otherwise a connect under a closed firewall silently falls back to direct
    // on the first proxy hiccup — the exact leak this port exists to close.
    getSettings.mockResolvedValue({ providerStrategies: { codex: { proxyPoolId: "pool-a" } } });
    resolveConnectionProxyConfig.mockResolvedValue(POOL);
    expect((await resolveOAuthEgress("codex")).proxyOptions.strictProxy).toBe(true);
  });

  it("reports a pool that resolves to no usable relay", async () => {
    getSettings.mockResolvedValue({ providerStrategies: { codex: { proxyPoolId: "pool-a" } } });
    resolveConnectionProxyConfig.mockResolvedValue({ connectionProxyUrl: "", vercelRelayUrl: "" });
    const e = await resolveOAuthEgress("codex");
    expect(e.mode).toBe("unresolved");
    expect(e.poolId).toBe("pool-a");
    expect(e.proxyOptions).toBe(null);
  });

  it("never throws when the settings read fails", async () => {
    // A broken settings row must not make every OAuth connect unreachable.
    getSettings.mockRejectedValue(new Error("db locked"));
    const e = await resolveOAuthEgress("codex");
    expect(e.mode).toBe("error");
    expect(e.detail).toContain("db locked");
  });

  it("ignores a blank pool id", async () => {
    getSettings.mockResolvedValue({ providerStrategies: { codex: { proxyPoolId: "   " } } });
    const e = await resolveOAuthEgress("codex");
    expect(e.mode).toBe("unconfigured");
    expect(resolveConnectionProxyConfig).not.toHaveBeenCalled();
  });

  describe("describeOAuthEgressFailure", () => {
    it("leaves a provider's own answer untouched", () => {
      // `invalid_grant` is the provider talking; rewriting it would send the
      // operator looking at the network for an expired code.
      expect(describeOAuthEgressFailure(new Error("invalid_grant"), { mode: "pool" }, "codex")).toBe(null);
    });

    it("names the pool when one was used", () => {
      const out = describeOAuthEgressFailure(new Error("fetch failed"), { mode: "pool", poolId: "pool-a" }, "codex");
      expect(out).toContain("pool-a");
      expect(out).toContain("codex");
    });

    it("says why it went direct when nothing was configured", () => {
      const out = describeOAuthEgressFailure(new Error("fetch failed"), { mode: "unconfigured" }, "codex");
      expect(out).toContain("providerStrategies.codex.proxyPoolId");
    });

    it("sees the real code through undici's cause chain", () => {
      const out = describeOAuthEgressFailure(
        new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }),
        { mode: "unconfigured" }, "codex",
      );
      expect(out).not.toBe(null);
    });

    it("terminates on a self-referential cause chain", () => {
      const e = new Error("nope");
      e.cause = e;
      expect(describeOAuthEgressFailure(e, { mode: "pool" }, "codex")).toBe(null);
    });
  });
});

describe("withOAuthEgress", () => {
  let withOAuthEgress;
  let readAmbient;

  beforeEach(async () => {
    vi.resetModules();
    getSettings.mockReset();
    resolveConnectionProxyConfig.mockReset();
    ({ withOAuthEgress } = await import("../../src/lib/oauth/egress.js"));
    // Same module instance the wrapper just loaded: vi.resetModules() gives the
    // fresh graph its own AsyncLocalStorage, so a static import here would be a
    // different store and always read null — indistinguishable from a bug.
    ({ getAmbientProxyOptions: readAmbient } = await import("../../open-sse/utils/egressContext.js"));
  });

  afterEach(() => {
    expect(readAmbient()).toBe(null); // the store must not outlive the wrapper
  });

  const withPool = (id) => {
    getSettings.mockResolvedValue({ providerStrategies: { [id]: { proxyPoolId: `pool-${id}` } } });
    resolveConnectionProxyConfig.mockImplementation(async ({ proxyPoolId }) => ({
      ...POOL, connectionProxyUrl: `http://${proxyPoolId}:8080`,
    }));
  };

  it("exposes the pool to everything inside the body", async () => {
    withPool("codex");
    await withOAuthEgress("codex", async () => {
      expect(readAmbient().connectionProxyUrl).toBe("http://pool-codex:8080");
    });
  });

  it("passes null inside the body when nothing is configured", async () => {
    getSettings.mockResolvedValue({ providerStrategies: {} });
    await withOAuthEgress("codex", async () => {
      expect(readAmbient()).toBe(null);
    });
  });

  it("clears the store even when the body throws", async () => {
    withPool("codex");
    await expect(withOAuthEgress("codex", async () => { throw new Error("boom"); }))
      .rejects.toThrow("boom");
  });

  it("keeps two concurrent connects on their own pools", async () => {
    // Two operators connecting different providers at once must not swap
    // relays — the whole risk of an ambient design.
    getSettings.mockImplementation(async () => ({
      providerStrategies: { codex: { proxyPoolId: "pool-codex" }, claude: { proxyPoolId: "pool-claude" } },
    }));
    resolveConnectionProxyConfig.mockImplementation(async ({ proxyPoolId }) => ({
      ...POOL, connectionProxyUrl: `http://${proxyPoolId}:8080`,
    }));
    const seen = [];
    const connect = (p, delay) => withOAuthEgress(p, async () => {
      await new Promise((r) => setTimeout(r, delay));
      seen.push([p, readAmbient().connectionProxyUrl]);
    });
    // Deliberately out of order: the slow chain must come back to its own pool.
    await Promise.all([connect("codex", 20), connect("claude", 2)]);
    expect(seen.sort()).toEqual([
      ["claude", "http://pool-claude:8080"],
      ["codex", "http://pool-codex:8080"],
    ]);
  });

  it("does not shadow an outer pool when the inner resolves to none", async () => {
    getSettings.mockResolvedValue({ providerStrategies: { codex: { proxyPoolId: "pool-codex" } } });
    resolveConnectionProxyConfig.mockImplementation(async ({ proxyPoolId }) => ({
      ...POOL, connectionProxyUrl: `http://${proxyPoolId}:8080`,
    }));
    await withOAuthEgress("codex", async () => {
      // "claude" has no strategy entry → null bag. It must inherit codex's pool
      // rather than downgrade this chain to direct egress.
      await withOAuthEgress("claude", async () => {
        expect(readAmbient().connectionProxyUrl).toBe("http://pool-codex:8080");
      });
    });
  });
});
