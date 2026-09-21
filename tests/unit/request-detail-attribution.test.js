import { describe, it, expect } from "vitest";
import { buildRequestDetail } from "open-sse/handlers/chatCore/requestDetail.js";

// The Usage > Details table answers "which virtual key hit which upstream
// account, and why did it fail". That is only possible if the attribution
// fields survive buildRequestDetail -> saveRequestDetail. buildRequestDetail
// returns a fixed-shape object, so a field that is not named there is dropped
// silently — these tests pin the shape.
describe("buildRequestDetail attribution fields", () => {
  it("carries apiKey and endpoint through to the persisted detail", () => {
    const detail = buildRequestDetail({
      provider: "claude",
      model: "claude-opus-5",
      connectionId: "conn-1",
      apiKey: "sk-abc123-def",
      endpoint: "/v1/messages",
    });

    expect(detail.apiKey).toBe("sk-abc123-def");
    expect(detail.endpoint).toBe("/v1/messages");
  });

  it("falls back to clientRawRequest.endpoint when endpoint is not explicit", () => {
    const detail = buildRequestDetail({
      provider: "openai",
      model: "gpt-5.6-luna",
      clientRawRequest: { endpoint: "/v1/chat/completions" },
    });

    expect(detail.endpoint).toBe("/v1/chat/completions");
  });

  it("keeps statusCode and errorReason on the error path", () => {
    const detail = buildRequestDetail({
      provider: "gemini",
      model: "gemini-3.8-flash",
      apiKey: "sk-key",
      status: "error",
      statusCode: 429,
      errorReason: "Quota exceeded for metric: generate_content_free_tier_requests",
    });

    expect(detail.status).toBe("error");
    expect(detail.statusCode).toBe(429);
    expect(detail.errorReason).toContain("Quota exceeded");
  });

  it("leaves attribution undefined rather than inventing values", () => {
    const detail = buildRequestDetail({ provider: "claude", model: "m" });

    expect(detail.apiKey).toBeUndefined();
    expect(detail.endpoint).toBeUndefined();
    expect(detail.statusCode).toBeUndefined();
    expect(detail.errorReason).toBeUndefined();
    // A request with no recorded failure must still read as a success.
    expect(detail.status).toBe("success");
  });

  it("does not let a zero statusCode be swallowed by ?? / || confusion", () => {
    const detail = buildRequestDetail({ provider: "p", model: "m", statusCode: 0 });
    expect(detail.statusCode).toBe(0);
  });
});
