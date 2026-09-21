import { describe, it, expect, vi, beforeEach } from "vitest";

// A stream that dies after HTTP 200 was committed never reaches finalizeStream(),
// so onStreamComplete never fires and the row saved at stream-open stays frozen
// on its "[Streaming in progress...]" placeholder with status "success" — while
// the client got an empty body. These tests pin the three halves of the fix:
// the abort is recorded, a pre-first-byte failure becomes a retry instead of a
// dead 200, and the terminal frame is one a Claude client retries on its own.

const saved = [];
vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(async (d) => { saved.push(d); }),
  saveRequestUsage: vi.fn(async () => {}),
  appendRequestLog: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(() => () => {}),
}));

const { handleStreamingResponse, buildOnStreamComplete } = await import(
  "../../open-sse/handlers/chatCore/streamingHandler.js"
);
const { buildStreamErrorBytes } = await import("../../open-sse/utils/streamHelpers.js");
const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

const enc = new TextEncoder();
const dec = new TextDecoder();

function fakeStreamController() {
  let connected = true;
  return {
    signal: new AbortController().signal,
    startTime: Date.now(),
    isConnected: () => connected,
    handleComplete: () => { connected = false; },
    handleError: () => { connected = false; },
    handleDisconnect: () => { connected = false; },
    abort: () => { connected = false; },
  };
}

// Upstream that returns SSE headers and then behaves as `script` dictates.
function upstream(script) {
  return {
    status: 200,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: new ReadableStream(script),
  };
}

function baseArgs(overrides = {}) {
  const { onStreamComplete, streamDetailId, settled } = buildOnStreamComplete({
    provider: "claude", model: "claude-opus-5", connectionId: "conn-1",
    apiKey: "sk-test", requestStartTime: Date.now(), body: { messages: [] },
    stream: true, clientRawRequest: { endpoint: "/v1/messages" },
  });
  return {
    provider: "claude",
    model: "claude-opus-5",
    sourceFormat: FORMATS.CLAUDE,
    targetFormat: FORMATS.CLAUDE,
    body: { messages: [] },
    stream: true,
    requestStartTime: Date.now(),
    connectionId: "conn-1",
    apiKey: "sk-test",
    clientRawRequest: { endpoint: "/v1/messages" },
    streamController: fakeStreamController(),
    onStreamComplete,
    streamDetailId,
    settled,
    ...overrides,
  };
}

async function drain(stream) {
  const reader = stream.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

beforeEach(() => { saved.length = 0; });

describe("first-byte gate (claude passthrough only)", () => {
  it("turns an upstream that closes before the first token into a retryable failure", async () => {
    const result = await handleStreamingResponse(baseArgs({
      providerResponse: upstream({ start(c) { c.close(); } }),
    }));

    // No 200 committed: the account loop in src/sse/handlers/chat.js gets to retry.
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toContain("upstream closed before first token");
  });

  it("does not punish a healthy account for a socket that broke", () => {
    const { shouldFallback, cooldownMs } = checkFallbackError(
      502, "[claude/claude-opus-5] upstream closed before first token"
    );
    // Switch accounts immediately, but no cooldown: the credential is fine.
    expect(shouldFallback).toBe(true);
    expect(cooldownMs).toBe(0);
  });

  it("commits the 200 and loses nothing when a slow upstream exceeds the ceiling", async () => {
    // Ceiling is 3s; this one answers later, so the gate gives up and the
    // request proceeds exactly as it did before the gate existed.
    const result = await handleStreamingResponse(baseArgs({
      providerResponse: upstream({
        async start(c) {
          await new Promise((r) => setTimeout(r, 3200));
          c.enqueue(enc.encode('event: message_start\ndata: {"type":"message_start"}\n\n'));
          c.enqueue(enc.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
          c.close();
        },
      }),
    }));

    expect(result.success).toBe(true);
    // The chunk that arrived while the gate was already gone must still reach
    // the client — dropping the pending read would truncate a healthy response.
    const out = await drain(result.response.body);
    expect(out).toContain("message_start");
    expect(out).toContain("message_stop");
  }, 10000);

  it("leaves non-claude traffic ungated", async () => {
    // codex p50 TTFT is 26.7s — a first-byte gate there would fail every request.
    const result = await handleStreamingResponse(baseArgs({
      provider: "opencode",
      model: "muse-spark",
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.OPENAI,
      providerResponse: upstream({ start(c) { c.close(); } }),
    }));

    expect(result.success).toBe(true);
  });
});

describe("aborted stream is recorded instead of frozen as success", () => {
  it("rewrites the placeholder row as an error when upstream dies mid-stream", async () => {
    const result = await handleStreamingResponse(baseArgs({
      providerResponse: upstream({
        start(c) {
          c.enqueue(enc.encode('event: message_start\ndata: {"type":"message_start"}\n\n'));
        },
        pull(c) { c.error(new Error("socket hang up")); },
      }),
    }));

    expect(result.success).toBe(true);
    await drain(result.response.body);
    await new Promise((r) => setTimeout(r, 50));

    const errorRow = saved.find((d) => d.status === "error");
    expect(errorRow, "abort must produce an error row").toBeTruthy();
    expect(errorRow.statusCode).toBe(504);
    expect(errorRow.errorReason).toBeTruthy();
    expect(errorRow.response.content).toBe("[Stream aborted]");

    // Same id as the placeholder: the log shows one request, not two.
    const placeholder = saved.find((d) => d.response?.content === "[Streaming in progress...]");
    expect(placeholder).toBeTruthy();
    expect(errorRow.id).toBe(placeholder.id);
  });
});

describe("terminal frame is retryable for Claude clients", () => {
  it("emits overloaded_error, not server_error", () => {
    const out = dec.decode(buildStreamErrorBytes(504, "boom", FORMATS.CLAUDE, { sawOpening: true }));
    expect(out).toContain("overloaded_error");
    expect(out).not.toContain("server_error");
  });

  it("opens the protocol with a synthetic message_start when upstream never did", () => {
    const out = dec.decode(
      buildStreamErrorBytes(504, "boom", FORMATS.CLAUDE, { sawOpening: false, model: "claude-opus-5" })
    );
    // An `error` event with no opening is what the client reports as
    // "empty or malformed response (HTTP 200)".
    expect(out.indexOf("message_start")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("message_start")).toBeLessThan(out.indexOf("overloaded_error"));
    expect(out).toContain("claude-opus-5");
  });

  it("leaves OpenAI-format terminals untouched", () => {
    const out = dec.decode(buildStreamErrorBytes(504, "boom", FORMATS.OPENAI, { sawOpening: false }));
    expect(out).toContain("[DONE]");
    expect(out).not.toContain("message_start");
  });
});
