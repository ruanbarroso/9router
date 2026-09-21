// ORÇAMENTO TOTAL do combo: o prazo de QUEM CHAMOU, não o de um degrau.
//
// Incidente que originou: 2026-09-21, combo `barroso-chat` chamado pelo gateway
// `barroso-keys` com 60 s de orçamento. Requisição real `d85a5695`: o degrau 1
// (`muse-spark`) gastou 20,5 s no teto, o degrau 2 (`gemini-3.8-flash`) levou
// 429 em 4 contas até `all 43 accounts locked` (~6 s) mais 2 s de cooldown, e o
// degrau 3 (`gpt-5.6-luna`, p90 de 69 s — o mais lento da chain) recebeu o
// bastão com ~30 s já queimados. O keys desistiu em `upstream nao mandou
// headers em 60000 ms` enquanto o degrau 3 ainda escrevia: 34,7% das chamadas
// da hora viraram `503 capacity_shed`.
//
// O teto por degrau não via isso — ele não sabe quanto do prazo do cliente já
// foi gasto pelos degraus anteriores. Sem deadline o gateway seguia abrindo
// degrau DEPOIS que o cliente foi embora, ocupando conta e quota que as
// requisições ainda vivas precisavam, o que realimentava o 429 do degrau 2.
import { describe, it, expect } from "vitest";
import { handleComboChat, deadlineDoHeader } from "open-sse/services/combo.js";

const log = { info() {}, warn() {}, error() {}, debug() {} };

const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: "oi" } }] }), {
  status: 200,
  headers: { "Content-Type": "application/json" },
});

const indisponivel = () =>
  new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 });

describe("deadlineDoHeader", () => {
  const req = (v) => ({ headers: { get: (k) => (k === "x-deadline-ms" ? v : null) } });

  it("lê o prazo que o cliente mandou", () => {
    expect(deadlineDoHeader(req("60000"))).toBe(60000);
  });

  it("sem header não há deadline — comportamento de antes", () => {
    expect(deadlineDoHeader(req(null))).toBeNull();
    expect(deadlineDoHeader(undefined)).toBeNull();
  });

  it("descarta valor implausível em vez de desligar a chain no primeiro degrau", () => {
    // Um negativo (relógio torto do outro lado) ou um absurdo não podem virar
    // "não há tempo para nada": isso trocaria a chain inteira por um erro.
    expect(deadlineDoHeader(req("-5"))).toBeNull();
    expect(deadlineDoHeader(req("0"))).toBeNull();
    expect(deadlineDoHeader(req("abacaxi"))).toBeNull();
    expect(deadlineDoHeader(req(String(60 * 60 * 1000)))).toBeNull();
  });
});

describe("handleComboChat com orçamento total", () => {
  it("não abre degrau novo quando o prazo do cliente já acabou", async () => {
    const vistos = [];
    const t0 = Date.now();
    const res = await handleComboChat({
      body: {},
      models: ["gemini/lento", "cx/luna", "cx/outro"],
      log,
      // Prazo curto: o degrau 1 sozinho já o consome.
      deadlineMs: 1600,
      stepCeilingMs: 10000,
      handleSingleModel: async (_b, m) => {
        vistos.push(m);
        await new Promise((r) => setTimeout(r, 400));
        return indisponivel();
      },
    });

    // O degrau 3 nunca foi aberto: não havia prazo para ele terminar.
    expect(vistos.length).toBeLessThan(3);
    expect(res.ok).toBe(false);
    // E o erro volta ANTES do prazo do cliente, não depois dele.
    expect(Date.now() - t0).toBeLessThan(1600);
  });

  it("o primeiro degrau é sempre tentado, mesmo com prazo apertado", async () => {
    // Cortar antes de tentar qualquer coisa trocaria uma chance por um erro
    // garantido — nunca é melhor para quem chamou.
    const vistos = [];
    const res = await handleComboChat({
      body: {},
      models: ["gemini/unico", "cx/luna"],
      log,
      deadlineMs: 10,
      handleSingleModel: async (_b, m) => { vistos.push(m); return ok(); },
    });
    expect(vistos).toEqual(["gemini/unico"]);
    expect(res.status).toBe(200);
  });

  it("o orçamento também é teto do ÚLTIMO degrau, que não tem para onde cair", async () => {
    // Aqui o corte não troca resposta por erro: passado o prazo não há mais
    // ninguém escutando, e um erro explicável vale mais que um socket morto.
    let pendurouAteOFim = false;
    const t0 = Date.now();
    const res = await handleComboChat({
      body: {},
      models: ["cx/so-este"],
      log,
      deadlineMs: 1800,
      handleSingleModel: async () => {
        await new Promise((r) => setTimeout(r, 5000));
        pendurouAteOFim = true;
        return ok();
      },
    });
    expect(pendurouAteOFim).toBe(false);
    expect(res.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("pula o cooldown de transiente quando não sobra prazo para o degrau seguinte", async () => {
    // Dormir 2 s de um orçamento que já não cobre o próximo degrau só adianta
    // o erro; é tempo gasto sem nenhuma chance de entrega.
    const t0 = Date.now();
    await handleComboChat({
      body: {},
      models: ["gemini/a", "cx/b"],
      log,
      deadlineMs: 1700,
      handleSingleModel: async () => indisponivel(),
    });
    // Sem o corte, o cooldown de 2 s do 503 sozinho estouraria isto.
    expect(Date.now() - t0).toBeLessThan(1700);
  });

  it("sem deadline nada muda: a chain inteira continua sendo percorrida", async () => {
    const vistos = [];
    const res = await handleComboChat({
      body: {},
      models: ["gemini/a", "gemini/b", "cx/luna"],
      log,
      handleSingleModel: async (_b, m) => {
        vistos.push(m);
        return m === "cx/luna" ? ok() : new Response("{}", { status: 500 });
      },
    });
    expect(vistos).toEqual(["gemini/a", "gemini/b", "cx/luna"]);
    expect(res.status).toBe(200);
  });

  it("com prazo folgado a chain inteira também é percorrida", async () => {
    const vistos = [];
    const res = await handleComboChat({
      body: {},
      models: ["gemini/a", "gemini/b", "cx/luna"],
      log,
      deadlineMs: 60000,
      handleSingleModel: async (_b, m) => {
        vistos.push(m);
        return m === "cx/luna" ? ok() : new Response("{}", { status: 500 });
      },
    });
    expect(vistos).toEqual(["gemini/a", "gemini/b", "cx/luna"]);
    expect(res.status).toBe(200);
  });
});
