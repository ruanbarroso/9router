import { beforeEach, describe, expect, it, vi } from "vitest";

// usageHistory could always say WHICH virtual key made a request, but never how
// long it took: `meta` was hardcoded to {}. The journal has the latency and not
// the key; requestDetails has both but only while ENABLE_REQUEST_LOGS is on, and
// it evicts at maxRecords. These tests pin the two halves of the join.

const mocks = vi.hoisted(() => ({ saveRequestUsage: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/usageDb.js", () => ({
  saveRequestUsage: mocks.saveRequestUsage,
  appendRequestLog: vi.fn(),
  saveRequestDetail: vi.fn(),
}));

import { saveUsageStats } from "../../open-sse/handlers/chatCore/requestDetail.js";

const TOKENS = { prompt_tokens: 10, completion_tokens: 5 };
const call = () => mocks.saveRequestUsage.mock.calls[0][0];

describe("saveUsageStats carries latency to the usage row", () => {
  beforeEach(() => mocks.saveRequestUsage.mockClear());

  it("passes ttft and total through, alongside the virtual key", () => {
    saveUsageStats({
      provider: "codex", model: "gpt-5.6-luna", tokens: TOKENS,
      connectionId: "conn-1", apiKey: "sk-virtual-key",
      latency: { ttft: 15683, total: 19021 }, silent: true,
    });
    expect(call()).toMatchObject({
      apiKey: "sk-virtual-key",
      latency: { ttft: 15683, total: 19021 },
    });
  });

  it("rounds fractional timings", () => {
    saveUsageStats({ provider: "p", model: "m", tokens: TOKENS, latency: { ttft: 11.6, total: 42.4 }, silent: true });
    expect(call().latency).toEqual({ ttft: 12, total: 42 });
  });

  it("keeps a total-only measurement (non-streaming has no ttft)", () => {
    saveUsageStats({ provider: "p", model: "m", tokens: TOKENS, latency: { total: 1234 }, silent: true });
    expect(call().latency).toEqual({ total: 1234 });
  });

  it("omits latency entirely when the caller measured nothing", () => {
    saveUsageStats({ provider: "p", model: "m", tokens: TOKENS, silent: true });
    expect(call().latency).toBeUndefined();
  });

  it("drops non-finite timings instead of persisting NaN", () => {
    saveUsageStats({ provider: "p", model: "m", tokens: TOKENS, latency: { ttft: NaN, total: Infinity }, silent: true });
    expect(call().latency).toBeUndefined();
  });
});
