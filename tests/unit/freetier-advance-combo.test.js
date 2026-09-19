// O 403 FreeTierError do OpenCode Zen ("free tier can only be used from within
// OpenCode") é política de produto: determinístico e idêntico para todas as
// contas (medido em produção: 12/12 contas, 0 sucessos). Duas coisas distintas
// precisam ser ditas sobre ele, e antes deste fix compartilhavam um booleano:
//
//   1. NÃO faça fan-out pelas outras contas do opencode — queima as 12 em ~3s
//      sem nenhuma chance de sucesso, e a credencial está sã (cooldown 0).
//   2. AVANCE o combo — o degrau seguinte é outro provedor e não tem motivo
//      para falhar.
//
// Com só `shouldFallback:false`, o (1) era obtido ao custo do (2): o combo
// inteiro abortava no degrau 1 e o 403 vazava para o cliente como
// `insufficient_quota`, que gateways à frente leem como cota estourada.
import { describe, expect, it } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { ERROR_RULES } from "../../open-sse/config/errorConfig.js";

const FREETIER_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "FreeTierError",
    message: "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode",
  },
});

describe("FreeTierError — sem fan-out de conta, mas avança o combo", () => {
  it("não faz fallback de conta e não põe a conta em cooldown", () => {
    const result = checkFallbackError(403, FREETIER_BODY);

    expect(result.shouldFallback).toBe(false);
    expect(result.cooldownMs).toBe(0);
  });

  it("marca advanceCombo para o combo seguir para o próximo modelo", () => {
    expect(checkFallbackError(403, FREETIER_BODY).advanceCombo).toBe(true);
  });

  it("casa pelo nome do tipo também, quando a mensagem não vem no corpo", () => {
    const result = checkFallbackError(403, JSON.stringify({ error: { type: "FreeTierError" } }));

    expect(result.shouldFallback).toBe(false);
    expect(result.advanceCombo).toBe(true);
  });

  it("vence a regra genérica de status 403, que é a que vem depois", () => {
    // Sem as regras de texto, um 403 cairia em { status: 403, cooldownMs: 2min }
    // e travaria a conta. A ordem dentro de ERROR_RULES é o que garante isto.
    const generico = checkFallbackError(403, "forbidden");
    expect(generico.shouldFallback).toBe(true);
    expect(generico.cooldownMs).toBeGreaterThan(0);

    const textoFreeTier = ERROR_RULES.findIndex((r) => r.text === "freetiererror");
    const status403 = ERROR_RULES.findIndex((r) => r.status === 403);
    expect(textoFreeTier).toBeGreaterThanOrEqual(0);
    expect(textoFreeTier).toBeLessThan(status403);
  });

  it("não vaza advanceCombo para os outros erros", () => {
    // Um 400 de requisição também tem shouldFallback:false, mas pelo motivo
    // oposto: o pedido é que está errado, então repeti-lo noutro modelo só
    // reproduz o erro. Este é o caso que o `!shouldFallback && !advanceCombo`
    // do combo.js continua abortando.
    expect(checkFallbackError(400, "maximum context length").advanceCombo).toBeFalsy();
    expect(checkFallbackError(429, "rate limit").advanceCombo).toBeFalsy();
    expect(checkFallbackError(503, "upstream exploded").advanceCombo).toBeFalsy();
  });
});
