import { beforeEach, describe, expect, it, vi } from "vitest";

// A no-auth free provider (OpenCode) used to short-circuit to a single virtual
// "Public" credential BEFORE the DB was ever queried. Installs that had
// persisted one row per egress proxy got none of it: no connectionId (so every
// request shared one upstream session), one globally-configured pool instead of
// each row's own, and no account fallback. These guard the new rule — persisted
// active rows win, the virtual credential is only the empty-install fallback.

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
}));
const proxyMocks = vi.hoisted(() => ({
  resolveConnectionProxyConfig: vi.fn(),
  pickProxyPoolId: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => proxyMocks);
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: { opencode: { noAuth: true } },
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

// One row per proxy pool — the shape the 12-account OpenCode install actually has.
function row(n) {
  return {
    id: `oc-${n}`,
    provider: "opencode",
    authType: "none",
    name: `OpenCode ${n}`,
    isActive: true,
    priority: n,
    providerSpecificData: { proxyPoolId: `pool-${n}` },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getSettings.mockResolvedValue({});
  dbMocks.getProxyPools.mockResolvedValue([]);
  dbMocks.getProviderConnections.mockResolvedValue([row(1), row(2), row(3)]);
  // Echo back whichever pool the caller asked to resolve, so the assertions can
  // tell a per-row pool apart from the settings-level one.
  proxyMocks.resolveConnectionProxyConfig.mockImplementation(async (data) => ({
    source: data?.proxyPoolId ? "pool" : "none",
    proxyPoolId: data?.proxyPoolId || null,
    proxyPool: null,
    connectionProxyEnabled: !!data?.proxyPoolId,
    connectionProxyUrl: data?.proxyPoolId ? `http://${data.proxyPoolId}:8080` : "",
    connectionNoProxy: "",
    strictProxy: !!data?.proxyPoolId,
  }));
});

describe("no-auth provider with persisted connections", () => {
  it("selects a real row instead of the virtual Public credential", async () => {
    const creds = await getProviderCredentials("opencode");
    expect(creds.connectionId).toBe("oc-1");
    expect(creds.connectionName).toBe("OpenCode 1");
    expect(creds.id).not.toBe("noauth");
  });

  it("uses the selected row's own proxy pool, not the settings-level one", async () => {
    dbMocks.getSettings.mockResolvedValue({
      providerStrategies: { opencode: { proxyPoolId: "settings-pool", rotateStrategy: "round-robin" } },
    });
    const creds = await getProviderCredentials("opencode");
    expect(creds.providerSpecificData.connectionProxyPoolId).toBe("pool-1");
    expect(creds.providerSpecificData.connectionProxyUrl).toBe("http://pool-1:8080");
    // The no-auth rotation setting must not reach a persisted row.
    expect(proxyMocks.pickProxyPoolId).not.toHaveBeenCalled();
  });

  it("falls back to the next row (and its pool) when one is excluded", async () => {
    const creds = await getProviderCredentials("opencode", new Set(["oc-1"]));
    expect(creds.connectionId).toBe("oc-2");
    expect(creds.providerSpecificData.connectionProxyPoolId).toBe("pool-2");
  });

  it("skips rows model-locked into the future", async () => {
    const locked = { ...row(1), modelLock_gpt: new Date(Date.now() + 60_000).toISOString() };
    dbMocks.getProviderConnections.mockResolvedValue([locked, row(2)]);
    const creds = await getProviderCredentials("opencode", null, "gpt");
    expect(creds.connectionId).toBe("oc-2");
  });

  it("reports allRateLimited rather than reviving the public credential when every row is locked", async () => {
    const until = new Date(Date.now() + 60_000).toISOString();
    dbMocks.getProviderConnections.mockResolvedValue([
      { ...row(1), modelLock_gpt: until },
      { ...row(2), modelLock_gpt: until },
    ]);
    const creds = await getProviderCredentials("opencode", null, "gpt");
    expect(creds.allRateLimited).toBe(true);
    expect(creds.connectionName).toBeUndefined();
  });

  it("honours round-robin across rows", async () => {
    dbMocks.getSettings.mockResolvedValue({
      providerStrategies: { opencode: { fallbackStrategy: "round-robin", stickyRoundRobinLimit: 1 } },
    });
    dbMocks.getProviderConnections.mockResolvedValue([
      { ...row(1), lastUsedAt: new Date(Date.now() - 1000).toISOString(), consecutiveUseCount: 1 },
      { ...row(2), lastUsedAt: new Date(Date.now() - 60_000).toISOString(), consecutiveUseCount: 1 },
    ]);
    const creds = await getProviderCredentials("opencode");
    expect(creds.connectionId).toBe("oc-2");
  });
});

describe("no-auth provider with no persisted connections", () => {
  beforeEach(() => {
    dbMocks.getProviderConnections.mockResolvedValue([]);
  });

  it("still returns the virtual Public credential", async () => {
    const creds = await getProviderCredentials("opencode");
    expect(creds.id).toBe("noauth");
    expect(creds.connectionName).toBe("Public");
    expect(creds.accessToken).toBe("public");
  });

  it("applies the settings-level pool to the virtual credential", async () => {
    dbMocks.getSettings.mockResolvedValue({
      providerStrategies: { opencode: { proxyPoolId: "settings-pool" } },
    });
    const creds = await getProviderCredentials("opencode");
    expect(creds.providerSpecificData.connectionProxyPoolId).toBe("settings-pool");
  });

  it("applies the configured rotate strategy to the virtual credential", async () => {
    dbMocks.getSettings.mockResolvedValue({
      providerStrategies: { opencode: { rotateStrategy: "round-robin" } },
    });
    dbMocks.getProxyPools.mockResolvedValue([
      { id: "pool-a", proxyUrl: "http://a:8080" },
      { id: "pool-b", proxyUrl: "http://b:8080" },
    ]);
    proxyMocks.pickProxyPoolId.mockReturnValue("pool-b");
    const creds = await getProviderCredentials("opencode");
    expect(proxyMocks.pickProxyPoolId).toHaveBeenCalledWith(["pool-a", "pool-b"], "round-robin", "opencode");
    expect(creds.providerSpecificData.connectionProxyPoolId).toBe("pool-b");
  });
});

describe("providers that are not no-auth", () => {
  it("returns null when they have no connections", async () => {
    dbMocks.getProviderConnections.mockResolvedValue([]);
    expect(await getProviderCredentials("claude")).toBeNull();
  });
});
