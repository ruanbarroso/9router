// `6994cd1f` ("HTTP/2 AgentService support", 2026-07-20) tirou este caminho do
// `fetch`: agent.api5.cursor.sh só fala HTTP/2 e o undici do Node não fala h2,
// então `fetchCursorCatalog` usa `http2.connect` (cursorModels.js:81). Os
// testes continuavam mockando `global.fetch`, que a rota não chama mais — a
// requisição saía (ou falhava) de verdade e o catálogo vinha null. O mock agora
// é do `http2`, e com isso o teste também deixa de depender da rede.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h2 = vi.hoisted(() => ({
  // Preenchido por teste: { status, body } ou um Error a lançar na conexão.
  next: null,
  requests: [],
  connect: vi.fn(),
}));

vi.mock("http2", () => {
  h2.connect.mockImplementation(() => ({
    close() {},
    on() {},
    request(headers) {
      h2.requests.push(headers);
      const handlers = {};
      queueMicrotask(() => {
        const { status = 200, body = new Uint8Array() } = h2.next || {};
        handlers.response?.({ ":status": status });
        if (body.length) handlers.data?.(Buffer.from(body));
        handlers.end?.();
      });
      return {
        on(event, fn) { handlers[event] = fn; },
        end() {},
      };
    },
  }));
  return { default: h2, ...h2 };
});

const {
  clearCursorModelCache,
  parseCursorUsableModels,
  resolveCursorModels,
} = await import("../../open-sse/services/cursorModels.js");

function varint(value) {
  const bytes = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Uint8Array.from(bytes);
}

function field(fieldNumber, value) {
  return Uint8Array.from([(fieldNumber << 3) | 2, ...varint(value.length), ...value]);
}

function text(value) {
  return new TextEncoder().encode(value);
}

function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function model(id, name) {
  return field(1, concat(field(1, text(id)), field(4, text(name))));
}

describe("Cursor live model catalog", () => {
  beforeEach(() => {
    clearCursorModelCache();
    h2.next = null;
    h2.requests = [];
    h2.connect.mockClear();
  });

  afterEach(() => {
    clearCursorModelCache();
  });

  it("decodes the GetUsableModels protobuf response", () => {
    const payload = concat(
      model("default", "Auto"),
      model("gpt-5.3-codex", "GPT 5.3 Codex"),
      model("gpt-5.3-codex", "Duplicate"),
    );

    expect(parseCursorUsableModels(payload)).toEqual([
      { id: "default", name: "Auto" },
      { id: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
    ]);
  });

  it("fetches the account-specific catalog and caches it", async () => {
    const payload = concat(model("claude-4.6-opus", "Claude 4.6 Opus"));
    h2.next = { status: 200, body: payload };
    const credentials = {
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    };

    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });
    await expect(resolveCursorModels(credentials)).resolves.toEqual({
      models: [{ id: "claude-4.6-opus", name: "Claude 4.6 Opus" }],
    });

    // Uma única conexão h2 para as duas chamadas: a segunda veio do cache.
    expect(h2.connect).toHaveBeenCalledTimes(1);
    expect(h2.connect).toHaveBeenCalledWith("https://agent.api5.cursor.sh");
    expect(h2.requests).toHaveLength(1);
    expect(h2.requests[0]).toMatchObject({
      ":method": "POST",
      ":path": "/agent.v1.AgentService/GetUsableModels",
      ":authority": "agent.api5.cursor.sh",
      "content-type": "application/proto",
      accept: "application/proto",
    });
  });

  it("fails open when the Cursor catalog request fails", async () => {
    h2.next = { status: 403, body: new TextEncoder().encode("no") };

    await expect(resolveCursorModels({
      accessToken: "cursor-token",
      providerSpecificData: { machineId: "machine-id" },
    })).resolves.toBeNull();
  });
});
