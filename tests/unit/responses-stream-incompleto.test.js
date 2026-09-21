// O stream da Responses API que acaba SEM evento terminal.
//
// `transformer/streamToJsonConverter.js` faz `state.status` partir de
// `in_progress` e só mudar em `response.completed`/`response.done`/
// `response.failed`. Quando a conexão do upstream cai no meio, o envelope volta
// `in_progress` — e o handler não-streaming vazava esse status para dentro do
// `finish_reason` do chat.completion, além de devolver um 200 com conteúdo
// vazio.
//
// Incidente que originou: 2026-09-21, combo `barroso-chat`. O degrau 1
// (`oc/muse-spark-1.3-contributor-free`, único modelo em `openai-responses`)
// cortava o stream, o 9router logava `succeeded`, e o gateway `barroso-keys`
// respondia ao cliente `502 upstream 200 sem conteúdo: provider encerrou a
// resposta sem conteúdo: finish_reason=in_progress` — 103 de 478 chamadas no
// dia, contra 0 três dias antes. O keys agia como projetado: `finishAutorizaVazio`
// só aceita o vazio quando o `finish_reason` significa TRUNCAGEM, e um valor
// desconhecido cai do lado da falha de propósito. O 200 mudo nascia aqui.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");

const EVENTO_CRIADO =
  'event: response.created\ndata: {"response":{"id":"resp_1","created_at":1700000000}}';
const EVENTO_TEXTO =
  'event: response.output_item.done\ndata: {"output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"olá"}]}}';
const EVENTO_TOOL =
  'event: response.output_item.done\ndata: {"output_index":0,"item":{"type":"function_call","call_id":"call_1","name":"shell","arguments":"{\\"cmd\\":\\"ls\\"}"}}';
const EVENTO_COMPLETO =
  'event: response.completed\ndata: {"response":{"usage":{"input_tokens":10,"output_tokens":3,"total_tokens":13}}}';

function ctx(eventos, sourceFormat = FORMATS.OPENAI) {
  const encoder = new TextEncoder();
  const raw = eventos.join("\n\n") + "\n\n";
  return {
    providerResponse: new Response(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); }
    }), { headers: { "content-type": "text/event-stream" } }),
    sourceFormat,
    targetFormat: FORMATS.OPENAI_RESPONSES,
    provider: "oc",
    model: "muse-spark-1.3-contributor-free",
    body: { model: "muse-spark-1.3-contributor-free", messages: [] },
    stream: false,
    requestStartTime: Date.now(),
    connectionId: "test-connection",
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    trackDone: vi.fn(),
    appendLog: vi.fn()
  };
}

describe("stream Responses encerrado sem evento terminal", () => {
  it("devolve 502 em vez de um 200 mudo — o caso real de produção", async () => {
    // Exatamente o que o muse-spark entregava: abre a resposta e a conexão cai.
    const result = await handleForcedSSEToJson(ctx([EVENTO_CRIADO]));
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toContain("in_progress");
  });

  it("não deixa o status do envelope virar finish_reason", async () => {
    // O degrau seguinte da chain só entra se ESTE falhar; mas se algum dia o
    // corpo voltar a ser entregue, `finish_reason` tem de ser da spec do chat.
    const result = await handleForcedSSEToJson(ctx([EVENTO_CRIADO, EVENTO_TEXTO]));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.choices[0].finish_reason).toBe("stop");
  });

  it("entrega o texto de um stream truncado que já tinha conteúdo", async () => {
    // Descartar o que já foi escrito custaria resposta; o corte só vale para o
    // envelope que não entregou NADA.
    const result = await handleForcedSSEToJson(ctx([EVENTO_CRIADO, EVENTO_TEXTO]));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.choices[0].message.content).toBe("olá");
  });

  it("entrega o tool call de um stream truncado", async () => {
    const result = await handleForcedSSEToJson(ctx([EVENTO_CRIADO, EVENTO_TOOL]));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.choices[0].finish_reason).toBe("tool_calls");
    expect(json.choices[0].message.tool_calls[0].function.name).toBe("shell");
  });

  it("um stream completo segue passando com finish_reason=stop", async () => {
    const result = await handleForcedSSEToJson(ctx([EVENTO_CRIADO, EVENTO_TEXTO, EVENTO_COMPLETO]));
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.choices[0].finish_reason).toBe("stop");
    expect(json.usage.completion_tokens).toBe(3);
  });

  it("um response.completed sem conteúdo NÃO é cortado — é resposta legítima", async () => {
    // O modelo terminou e escolheu não escrever. Isso é decisão dele, não falha
    // de transporte, e não cabe a este handler transformar em erro.
    const result = await handleForcedSSEToJson(ctx([EVENTO_CRIADO, EVENTO_COMPLETO]));
    expect(result.success).toBe(true);
  });

  it("corta também quando o cliente é Responses API", async () => {
    // O retorno as-is para cliente Responses vem ANTES da montagem do chat, e
    // devolvia o envelope `in_progress` cru.
    const result = await handleForcedSSEToJson(ctx([EVENTO_CRIADO], FORMATS.OPENAI_RESPONSES));
    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
  });
});
