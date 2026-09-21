import { describe, it, expect } from "vitest";
import {
  TetoDeDegrau,
  otimoDe,
  AMOSTRAS_MINIMAS,
  TETO_MINIMO_MS,
  PISO_MEDIANA_K,
} from "open-sse/services/stepCeiling.js";
import { handleComboChat, _tetoDeDegrauParaTeste } from "open-sse/services/combo.js";

const log = { info() {}, warn() {}, error() {}, debug() {} };

const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: "oi" } }] }), {
  status: 200,
  headers: { "Content-Type": "application/json" },
});

// Uma amostra bimodal como a do `gemini-3.5-flash-lite` medido em produção:
// mediana ~1 s e um ramo patológico que vai a 58 s.
function bimodal(nRapidas, nLentas) {
  return [
    ...Array.from({ length: nRapidas }, () => 1000 + Math.random() * 500),
    ...Array.from({ length: nLentas }, () => 45000 + Math.random() * 13000),
  ];
}

describe("otimoDe — reinício ótimo", () => {
  it("escolhe o ramo rápido numa distribuição bimodal, e não o quantil da cauda", () => {
    const { teto } = otimoDe(bimodal(90, 10), 5000);
    // O p95 dessa amostra está na casa dos 50 s; o ótimo tem de ficar junto do
    // ramo rápido, que é o comportamento normal da dupla.
    expect(teto).toBeLessThan(5000);
  });

  it("não corta dentro do observado quando esperar sempre compensa", () => {
    // Cauda curta e apertada: nunca vale a pena trocar de degrau.
    const amostras = Array.from({ length: 100 }, () => 900 + Math.random() * 200);
    const { teto, naBorda } = otimoDe(amostras, 5000);
    expect(naBorda).toBe(true);
    expect(teto).toBeGreaterThanOrEqual(Math.max(...amostras) - 1e-9);
  });
});

describe("TetoDeDegrau", () => {
  it("não opina sem amostra suficiente", () => {
    const t = new TetoDeDegrau();
    for (let i = 0; i < AMOSTRAS_MINIMAS - 1; i++) t.registrarPlena("gemini", "flash-lite", 1000);
    expect(t.tetoPara("gemini", "flash-lite")).toBeNull();
  });

  it("respeita o piso absoluto — existe para matar a cauda, não para espremer o p90", () => {
    const t = new TetoDeDegrau();
    for (const ms of bimodal(90, 10)) t.registrarPlena("gemini", "flash-lite", ms);
    const teto = t.tetoPara("gemini", "flash-lite");
    expect(teto).toBeGreaterThanOrEqual(TETO_MINIMO_MS);
    // E ainda assim corta a cauda de 58 s, que é o ponto de tudo isto.
    expect(teto).toBeLessThan(45000);
  });

  it("o piso pela mediana impede que um modelo lento seja excluído", () => {
    const t = new TetoDeDegrau();
    // Mediana de 30 s: um modelo legitimamente lento (glm-5.3 tem mediana de 16 s).
    for (let i = 0; i < 100; i++) t.registrarPlena("nvidia", "glm", 28000 + Math.random() * 4000);
    const teto = t.tetoPara("nvidia", "glm");
    expect(teto).toBeGreaterThan(30000 * PISO_MEDIANA_K * 0.9);
  });

  it("aprender só encurta: nunca ultrapassa o teto configurado", () => {
    const t = new TetoDeDegrau();
    for (let i = 0; i < 100; i++) t.registrarPlena("nvidia", "glm", 50000);
    expect(t.tetoPara("nvidia", "glm", 30000)).toBeLessThanOrEqual(30000);
  });

  it("esquece amostra velha e volta a não opinar", () => {
    let agora = 0;
    const t = new TetoDeDegrau({ agora: () => agora, ttlMs: 1000 });
    for (let i = 0; i < 100; i++) t.registrarPlena("gemini", "flash-lite", 1000);
    expect(t.tetoPara("gemini", "flash-lite")).not.toBeNull();
    agora += 5000;
    expect(t.tetoPara("gemini", "flash-lite")).toBeNull();
  });
});

describe("handleComboChat com teto", () => {
  it("NUNCA corta o último degrau: sem saída, cortar troca espera por erro", async () => {
    let entregou = false;
    const res = await handleComboChat({
      body: {},
      models: ["gemini/so-este"],
      log,
      handleSingleModel: async () => {
        // Bem mais lento que qualquer teto que pudesse ser aprendido.
        await new Promise((r) => setTimeout(r, 120));
        entregou = true;
        return ok();
      },
    });
    expect(entregou).toBe(true);
    expect(res.status).toBe(200);
  });

  it("o degrau que responde rápido continua respondendo", async () => {
    const res = await handleComboChat({
      body: {},
      models: ["gemini/rapido", "cx/luna"],
      log,
      handleSingleModel: async (_b, m) => {
        if (m === "gemini/rapido") return ok();
        throw new Error("não deveria chegar no segundo degrau");
      },
    });
    expect(res.status).toBe(200);
  });

  it("CORTA o degrau pendurado e entrega pelo seguinte — o ponto de toda a mudança", async () => {
    // Ensina a dupla a ser rápida, com o piso absoluto baixado para o teste
    // continuar sendo um teste de unidade e não uma espera de 20 s.
    const memoria = _tetoDeDegrauParaTeste();
    memoria.tetoMinimoMs = 50;
    for (let i = 0; i < 100; i++) memoria.registrarPlena("gemini", "pendura", 10);

    let pendurouAteOFim = false;
    const t0 = Date.now();
    const res = await handleComboChat({
      body: {},
      models: ["gemini/pendura", "cx/luna"],
      log,
      handleSingleModel: async (_b, m) => {
        if (m === "gemini/pendura") {
          await new Promise((r) => setTimeout(r, 3000));
          pendurouAteOFim = true;
          return ok();
        }
        return ok();
      },
    });

    expect(res.status).toBe(200);
    // Entregou pelo SEGUNDO degrau, sem esperar os 3 s do primeiro.
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(pendurouAteOFim).toBe(false);

    // E a amostra cortada NÃO entra na série: senão o teto aprenderia com o que
    // ele mesmo truncou e desceria até o piso.
    const antes = memoria.amostrasVivas("gemini", "pendura").length;
    expect(antes).toBe(100);

    memoria.tetoMinimoMs = TETO_MINIMO_MS;
    memoria.series.clear();
  });

  it("um degrau pendurado não impede o combo de cair para o seguinte", async () => {
    // Sem teto aprendido ainda (amostra insuficiente), o combo precisa continuar
    // funcionando exatamente como antes: o degrau responde e a vez é dele.
    const vistos = [];
    const res = await handleComboChat({
      body: {},
      models: ["gemini/falha", "cx/luna"],
      log,
      handleSingleModel: async (_b, m) => {
        vistos.push(m);
        if (m === "gemini/falha") {
          return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 });
        }
        return ok();
      },
    });
    expect(vistos).toEqual(["gemini/falha", "cx/luna"]);
    expect(res.status).toBe(200);
  });
});
