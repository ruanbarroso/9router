import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression guard for the gap this PR closes: every proxy pool in production is
// configured strictProxy=1, but getProviderCredentials used to build
// providerSpecificData from a five-key literal that simply had no strictProxy
// field. The flag was dropped here, so 100% of LLM chat traffic ran fail-open
// even though proxyFetch.js has honoured strictProxy all along.

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
  FREE_PROVIDERS: { publicprov: { noAuth: true } },
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { getProviderCredentials } = await import("../../src/sse/services/auth.js");

const STRICT_POOL = {
  source: "pool",
  proxyPoolId: "bk-strict-a",
  proxyPool: { id: "bk-strict-a", strictProxy: true },
  connectionProxyEnabled: true,
  connectionProxyUrl: "http://100.64.0.5:18080",
  connectionNoProxy: "localhost",
  strictProxy: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getSettings.mockResolvedValue({});
  dbMocks.getProxyPools.mockResolvedValue([]);
  dbMocks.getProviderConnections.mockResolvedValue([
    { id: "conn-1", provider: "claude", isActive: true, accessToken: "t", providerSpecificData: { proxyPoolId: "bk-strict-a" } },
  ]);
  proxyMocks.resolveConnectionProxyConfig.mockResolvedValue(STRICT_POOL);
});

describe("getProviderCredentials — proxy threading", () => {
  it("carries strictProxy through to the chat path", async () => {
    const creds = await getProviderCredentials("claude");
    expect(creds.providerSpecificData.strictProxy).toBe(true);
  });

  it("carries the resolver's source so logs can name why egress went direct", async () => {
    const creds = await getProviderCredentials("claude");
    expect(creds.providerSpecificData.connectionProxySource).toBe("pool");
  });

  it("still carries the four original proxy fields", async () => {
    const creds = await getProviderCredentials("claude");
    expect(creds.providerSpecificData).toMatchObject({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://100.64.0.5:18080",
      connectionNoProxy: "localhost",
      vercelRelayUrl: "",
      connectionProxyPoolId: "bk-strict-a",
    });
  });

  it("lets the resolved pool win over a stale strictProxy on the connection row", async () => {
    dbMocks.getProviderConnections.mockResolvedValue([
      { id: "conn-1", provider: "claude", isActive: true, providerSpecificData: { strictProxy: false, proxyPoolId: "bk-strict-a" } },
    ]);
    const creds = await getProviderCredentials("claude");
    expect(creds.providerSpecificData.strictProxy).toBe(true);
  });

  it("preserves unrelated providerSpecificData keys", async () => {
    dbMocks.getProviderConnections.mockResolvedValue([
      { id: "conn-1", provider: "claude", isActive: true, providerSpecificData: { proxyPoolId: "bk-strict-a", copilotToken: "ghu_x" } },
    ]);
    const creds = await getProviderCredentials("claude");
    expect(creds.providerSpecificData.copilotToken).toBe("ghu_x");
  });

  it("threads strictProxy for no-auth free providers too", async () => {
    const creds = await getProviderCredentials("publicprov");
    expect(creds.providerSpecificData.strictProxy).toBe(true);
    expect(creds.providerSpecificData.connectionProxySource).toBe("pool");
  });

  it("reports source=none and strictProxy=false when no pool is configured", async () => {
    proxyMocks.resolveConnectionProxyConfig.mockResolvedValue({
      source: "none", proxyPoolId: null, proxyPool: null,
      connectionProxyEnabled: false, connectionProxyUrl: "", connectionNoProxy: "",
    });
    const creds = await getProviderCredentials("claude");
    expect(creds.providerSpecificData.strictProxy).toBe(false);
    expect(creds.providerSpecificData.connectionProxySource).toBe("none");
  });
});
