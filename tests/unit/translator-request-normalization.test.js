import { describe, it, expect } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.js";
import { filterToOpenAIFormat } from "../../open-sse/translator/formats/openai.js";
import { parseSSELine } from "../../open-sse/utils/streamHelpers.js";

describe("request normalization", () => {
  // `collapseTextParts` (concerns/message.js:5) colapsa UM part de texto para
  // string e devolve o array intacto em qualquer outro caso — nunca juntou dois
  // parts com "\n". Essa é a forma desde `32e3980a`, o commit que escreveu ESTE
  // arquivo de teste, então a asserção de junção nunca passou. E preservar o
  // array é o comportamento certo: juntar apaga a fronteira entre os blocos,
  // que é o que carrega `cache_control` por bloco no caminho Claude.
  it("claudeToOpenAIRequest colapsa um único part de texto e preserva os demais", () => {
    const um = claudeToOpenAIRequest("gpt-oss:120b", {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }, true);
    expect(um.messages[0].content).toBe("hi");

    const dois = claudeToOpenAIRequest("gpt-oss:120b", {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "text", text: "there" },
          ],
        },
      ],
    }, true);
    expect(dois.messages[0].content).toEqual([
      { type: "text", text: "hi" },
      { type: "text", text: "there" },
    ]);
  });

  it("claudeToOpenAIRequest preserves multimodal arrays", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "ZmFrZQ==",
              },
            },
          ],
        },
      ],
    };

    const result = claudeToOpenAIRequest("gpt-4o", body, true);
    expect(Array.isArray(result.messages[0].content)).toBe(true);
  });

  it("filterToOpenAIFormat preserva arrays de texto sem juntar", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        },
      ],
    };

    // `filterToOpenAIFormat` FILTRA tipos de bloco não-OpenAI; ela não colapsa
    // nem junta. Os dois parts de texto saem como entraram.
    const result = filterToOpenAIFormat(JSON.parse(JSON.stringify(body)));
    expect(result.messages[0].content).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]);
  });

  it("translateRequest Claude->OpenAI preserva todos os blocos de texto do turno", () => {
    const body = {
      model: "ollama/gpt-oss:120b",
      system: [{ type: "text", text: "You are helpful." }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "text", text: "world" },
          ],
        },
      ],
      stream: true,
    };

    const result = translateRequest(
      FORMATS.CLAUDE,
      FORMATS.OPENAI,
      "gpt-oss:120b",
      JSON.parse(JSON.stringify(body)),
      true,
      null,
      "ollama",
    );

    // Mesma regra de `collapseTextParts`: dois parts continuam array ponta a
    // ponta. O que o caminho /v1/messages garante é que nenhum bloco de texto
    // se perde, não que vire string.
    const userMessage = result.messages.find((m) => m.role === "user");
    expect(userMessage.content).toEqual([
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ]);
  });

  it("translateRequest strips unsupported Anthropic output_config for MiniMax Claude-compatible endpoints", () => {
    const body = {
      model: "MiniMax-M2.7",
      system: [{ type: "text", text: "You are helpful." }],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "continue" }],
        },
      ],
      max_tokens: 1024,
      output_config: {
        effort: "medium",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
    };

    const result = translateRequest(
      FORMATS.CLAUDE,
      FORMATS.CLAUDE,
      "MiniMax-M2.7",
      JSON.parse(JSON.stringify(body)),
      true,
      null,
      "minimax",
    );

    expect(result.output_config).toBeUndefined();
    expect(result.messages[0].content[0].text).toBe("continue");
  });

  it("translateRequest preserves output_config for Anthropic Claude", () => {
    const body = {
      model: "claude-sonnet-4.5",
      system: [{ type: "text", text: "You are helpful." }],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "continue" }],
        },
      ],
      max_tokens: 1024,
      output_config: {
        format: { type: "json_schema", schema: { type: "object" } },
      },
    };

    const result = translateRequest(
      FORMATS.CLAUDE,
      FORMATS.CLAUDE,
      "claude-sonnet-4.5",
      JSON.parse(JSON.stringify(body)),
      true,
      null,
      "claude",
    );

    expect(result.output_config).toEqual(body.output_config);
  });

  it("parseSSELine supports provider raw NDJSON stream lines", () => {
    const raw = JSON.stringify({
      model: "gpt-oss:120b",
      message: { role: "assistant", content: "hello" },
      done: false,
    });

    // O ramo NDJSON é fechado atrás de `format === FORMATS.OLLAMA`
    // (streamHelpers.js:12). Sem o segundo argumento a função cai no ramo SSE,
    // exige o prefixo "data:" e devolve null — que é exatamente o contrato,
    // porque NDJSON cru e SSE são indistinguíveis sem o formato do alvo. Os
    // dois chamadores de produção (`utils/stream.js:246,415`) passam
    // `targetFormat`; o teste não passava.
    const parsed = parseSSELine(raw, FORMATS.OLLAMA);
    expect(parsed).toEqual({
      model: "gpt-oss:120b",
      message: { role: "assistant", content: "hello" },
      done: false,
    });

    // E sem o formato: null, não um parse acidental.
    expect(parseSSELine(raw)).toBeNull();
  });

  it("parseSSELine still supports SSE data lines", () => {
    const parsed = parseSSELine('data: {"choices":[{"delta":{"content":"hi"}}]}');
    expect(parsed.choices[0].delta.content).toBe("hi");
  });
});
