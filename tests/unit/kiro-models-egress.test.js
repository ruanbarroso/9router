import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocked by the specifier kiroModels.js uses. The real module pulls the whole
// refresh layer (and with it the database) into a test about one status code.
const refreshKiroToken = vi.fn();
vi.mock("open-sse/services/tokenRefresh.js", () => ({
  refreshKiroToken: (...a) => refreshKiroToken(...a),
}));

const CREDS = () => ({
  accessToken: "stale-token",
  refreshToken: "refresh-token",
  providerSpecificData: {
    profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/ABC",
    clientId: "client-abc",
  },
});

const ok = (models) => ({
  ok: true,
  status: 200,
  json: async () => ({ models }),
  text: async () => "",
});

const fail = (status) => ({
  ok: false,
  status,
  statusText: `HTTP ${status}`,
  text: async () => "expired",
});

describe("resolveKiroModels token refresh", () => {
  let resolveKiroModels;
  let clearKiroModelCache;
  let fetchMock;

  beforeEach(async () => {
    vi.resetModules();
    refreshKiroToken.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    ({ resolveKiroModels, clearKiroModelCache } = await import("../../open-sse/services/kiroModels.js"));
    clearKiroModelCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The whole point of this file. AWS `ListAvailableModels` answers 403 — not
  // 401 — for an expired token, so a catch that tested 401 alone never
  // refreshed: it fell through to the static catalogue, with no log line
  // saying the account simply needed a new token.
  for (const status of [401, 403]) {
    it(`refreshes and retries on ${status}`, async () => {
      fetchMock
        .mockResolvedValueOnce(fail(status))
        .mockResolvedValueOnce(ok([{ modelId: "auto", modelName: "Auto" }]));
      refreshKiroToken.mockResolvedValue({ accessToken: "fresh-token" });

      const creds = CREDS();
      const out = await resolveKiroModels(creds, {});

      expect(refreshKiroToken).toHaveBeenCalledTimes(1);
      expect(out.models.length).toBeGreaterThan(0);
      // The retry must carry the new token, and the caller's record must end up
      // holding it too, so the next call does not repeat the round trip.
      expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer fresh-token");
      expect(creds.accessToken).toBe("fresh-token");
    });

    it(`persists the refreshed credentials on ${status}`, async () => {
      fetchMock
        .mockResolvedValueOnce(fail(status))
        .mockResolvedValueOnce(ok([{ modelId: "auto" }]));
      refreshKiroToken.mockResolvedValue({ accessToken: "fresh-token" });
      const onCredentialsRefreshed = vi.fn();

      await resolveKiroModels(CREDS(), { onCredentialsRefreshed });

      expect(onCredentialsRefreshed).toHaveBeenCalledWith({ accessToken: "fresh-token" });
    });
  }

  it("does not refresh on a status that is not an auth failure", async () => {
    // 500 is the upstream having a bad day; burning a refresh on it would
    // churn tokens for no reason.
    fetchMock.mockResolvedValueOnce(fail(500));
    expect(await resolveKiroModels(CREDS(), {})).toBe(null);
    expect(refreshKiroToken).not.toHaveBeenCalled();
  });

  it("does not refresh when there is no refresh token", async () => {
    fetchMock.mockResolvedValueOnce(fail(403));
    const creds = { ...CREDS(), refreshToken: "" };
    expect(await resolveKiroModels(creds, {})).toBe(null);
    expect(refreshKiroToken).not.toHaveBeenCalled();
  });

  it("returns null rather than throwing when the retry also fails", async () => {
    fetchMock
      .mockResolvedValueOnce(fail(403))
      .mockResolvedValueOnce(fail(403));
    refreshKiroToken.mockResolvedValue({ accessToken: "fresh-token" });
    expect(await resolveKiroModels(CREDS(), {})).toBe(null);
  });

  it("returns null rather than throwing when the refresh yields no token", async () => {
    fetchMock.mockResolvedValueOnce(fail(403));
    refreshKiroToken.mockResolvedValue({});
    expect(await resolveKiroModels(CREDS(), {})).toBe(null);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
