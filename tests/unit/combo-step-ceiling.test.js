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
    // O que importa é que ele CONTINUA SENDO ATENDIDO: o teto cobre a
    // distribuição inteira dele, em vez de cortá-lo na mediana e apagá-lo.
    // (Antes isto exigia 3 × mediana = 81 s para amostras que nunca passam de
    // 32 s — um valor que a série não sustenta. O múltiplo é piso protetor,
    // não valor final: ver o limite pela cauda observada em `tetoPara`.)
    expect(teto).toBeGreaterThanOrEqual(32000);
  });

  it("aprender pode ALONGAR: medição vale mais que o palpite configurado", () => {
    // Antes isto exigia `<= configurado` — "aprender só encurta". A regra
    // parecia conservadora e não era: um degrau que ENTREGA em 50 s era
    // cortado em 30 s para sempre, e cada corte virava outra censura em 30 s
    // que confirmava o corte. O teto parava de medir o modelo e passava a
    // medir a si mesmo.
    const t = new TetoDeDegrau();
    for (let i = 0; i < 100; i++) t.registrarPlena("nvidia", "glm", 50000);
    const teto = t.tetoPara("nvidia", "glm", 30000);
    // Onde há medição, ela manda — inclusive para cima.
    expect(teto).toBeGreaterThan(30000);
    // Mas nunca além da cauda observada: depois do máximo já visto não há
    // massa de probabilidade que a série conheça.
    expect(teto).toBeLessThanOrEqual(Math.round(50000 * 1.15));
  });

  it("quem limita o alongamento é o orçamento, não o teto configurado", () => {
    // O chamador faz `min(teto, fatia, sobra)`: o prazo do cliente é um fato,
    // o teto configurado era só um chute sobre o modelo.
    const t = new TetoDeDegrau();
    for (let i = 0; i < 100; i++) t.registrarPlena("nvidia", "glm", 50000);
    const aprendido = t.tetoPara("nvidia", "glm");
    const sobra = 20000;
    expect(Math.min(aprendido, sobra)).toBe(20000);
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

// ── Teto CONFIGURADO: o que faltava para a correção valer em produção ────────
//
// O teto aprendido exige 40 amostras por dupla. O `barroso-quick` recebe ~22
// chamadas por hora e a série é em memória: na prática o teto nunca armava, e
// era justamente na janela sem medição que os 503 de 60 s caíam. Estes testes
// fixam que o teto de partida vale desde a PRIMEIRA requisição.
describe("teto configurado (COMBO_STEP_CEILING_MS)", () => {
  it("corta um degrau pendurado SEM nenhuma amostra aprendida — o caso real de produção", async () => {
    const memoria = _tetoDeDegrauParaTeste();
    memoria.series.clear();

    // Prova que a dupla não tem medição nenhuma: é o estado logo após um deploy.
    expect(memoria.amostrasVivas("gemini", "nova")).toHaveLength(0);

    const vistos = [];
    let pendurouAteOFim = false;
    const res = await handleComboChat({
      body: {},
      models: ["gemini/nova", "cx/luna"],
      log,
      stepCeilingMs: 120,
      handleSingleModel: async (_b, m) => {
        vistos.push(m);
        if (m === "gemini/nova") {
          await new Promise((r) => setTimeout(r, 3000));
          pendurouAteOFim = true;
          return ok();
        }
        return ok();
      },
    });

    expect(res.status).toBe(200);
    expect(vistos).toEqual(["gemini/nova", "cx/luna"]);
    expect(pendurouAteOFim).toBe(false);
  });

  it("não corta o ÚLTIMO degrau, nem com teto configurado", async () => {
    const memoria = _tetoDeDegrauParaTeste();
    memoria.series.clear();

    // Último degrau: cortar aqui troca uma espera por um erro. Ele espera.
    const t0 = Date.now();
    const res = await handleComboChat({
      body: {},
      models: ["gemini/unico"],
      log,
      stepCeilingMs: 80,
      handleSingleModel: async () => {
        await new Promise((r) => setTimeout(r, 300));
        return ok();
      },
    });

    expect(res.status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  });

  it("o aprendido ALONGA quando a medição mostra que o degrau entrega além do configurado", () => {
    // Esta dupla ENTREGA em 90 s, consistentemente. Cortá-la em 25 s porque o
    // configurado diz 25 s é trocar uma resposta certa por um erro certo — e a
    // cada corte nasce outra censura em 25 s que "confirma" o corte.
    //
    // O configurado é o que se faz SEM MEDIÇÃO. Com 30 observações, a medição
    // é a melhor resposta que existe, para os dois lados.
    const memoria = new TetoDeDegrau();
    for (let i = 0; i < AMOSTRAS_MINIMAS + 10; i++) memoria.registrarPlena("p", "lento", 90_000);

    const configurado = 25_000;
    const teto = memoria.tetoPara("p", "lento", configurado);
    expect(teto).toBeGreaterThan(configurado);
    // Limitado pela cauda observada, não pelo múltiplo da mediana (que pediria
    // 270 s para uma série que nunca passou de 90 s).
    expect(teto).toBeLessThanOrEqual(Math.round(90_000 * 1.15));

    // E quem impede isso de estourar o cliente é o ORÇAMENTO, no chamador.
    expect(Math.min(teto, 20_000)).toBe(20_000);
  });

  it("um degrau rápido não é afetado pelo teto configurado", async () => {
    const memoria = _tetoDeDegrauParaTeste();
    memoria.series.clear();

    const res = await handleComboChat({
      body: {},
      models: ["gemini/rapido2", "cx/luna"],
      log,
      stepCeilingMs: 5000,
      handleSingleModel: async (_b, m) => {
        if (m === "gemini/rapido2") return ok();
        throw new Error("não deveria cair para o segundo degrau");
      },
    });
    expect(res.status).toBe(200);
  });
});

// CENSURA À DIREITA — uma duração cortada pelo teto não é "levou T", é
// "passou de T". Descartá-la (o que se fazia antes) evita a catraca e cria o
// viés de sobrevivência: a série passa a descrever só quem respondeu. Medido
// em produção: das 29 quedas do degrau 1 do `barroso-chat`, 29 foram por teto.
describe("aprendizado com observações censuradas", () => {
  it("não trata a cortada como entrega: nada de catraca", () => {
    // 30 entregas em 10 s e 70 cortes em 12 s. Se a cortada contasse como
    // duração observada, o teto desceria rumo ao piso a cada rodada.
    const t = new TetoDeDegrau();
    for (let i = 0; i < 30; i++) t.registrarPlena("oc", "muse", 10000);
    for (let i = 0; i < 70; i++) t.registrarCortada("oc", "muse", 12000);
    const teto = t.tetoPara("oc", "muse");
    // O teto não pode cair ABAIXO do que se sabe que entrega.
    expect(teto).toBeGreaterThanOrEqual(10000);
  });

  it("a cortada CONTA: um degrau que pendura não passa por rápido", () => {
    // Mesmas 30 entregas rápidas, mas agora com 70 cortes. Uma série que
    // ignorasse os cortes veria só "30 amostras de 2 s" e concluiria que este
    // degrau é rápido — enquanto 70% do tráfego real estoura nele.
    const soPlenas = new TetoDeDegrau();
    for (let i = 0; i < 30; i++) soPlenas.registrarPlena("oc", "muse", 2000);
    const comCensura = new TetoDeDegrau();
    for (let i = 0; i < 30; i++) comCensura.registrarPlena("oc", "muse", 2000);
    for (let i = 0; i < 70; i++) comCensura.registrarCortada("oc", "muse", 12000);

    // A série com censura sabe que a maioria não entregou; a outra não faz ideia.
    const km = comCensura.observacoesVivas("oc", "muse");
    expect(km.filter((o) => o.cortada).length).toBe(70);
    expect(soPlenas.observacoesVivas("oc", "muse").every((o) => !o.cortada)).toBe(true);
  });

  it("a censura conta para o mínimo de amostras", () => {
    // Exigir N PLENAS de um degrau que pendura na maioria das vezes é nunca
    // aprender justamente sobre quem mais precisa de teto.
    const t = new TetoDeDegrau();
    for (let i = 0; i < 5; i++) t.registrarPlena("oc", "muse", 3000);
    for (let i = 0; i < AMOSTRAS_MINIMAS; i++) t.registrarCortada("oc", "muse", 12000);
    expect(t.tetoPara("oc", "muse")).not.toBeNull();
  });

  it("série curta demais continua sem opinar", () => {
    const t = new TetoDeDegrau();
    for (let i = 0; i < 3; i++) t.registrarCortada("oc", "muse", 12000);
    expect(t.tetoPara("oc", "muse")).toBeNull();
  });

  it("sem nenhuma entrega não há o que estimar", () => {
    // Só cortes: Kaplan-Meier não tem evento nenhum, S(t) nunca desce.
    const t = new TetoDeDegrau();
    for (let i = 0; i < 50; i++) t.registrarCortada("oc", "muse", 12000);
    expect(t.tetoPara("oc", "muse")).toBeNull();
  });
});

describe("o que entra na série", () => {
  it("um 429 rápido NÃO vira amostra de entrega rápida", async () => {
    // O `gemini-3.8-flash(high)` recusa com 429 em ~200 ms, 4.122 vezes contra
    // 48 entregas na janela medida. Se o erro entrasse como duração, a série
    // aprenderia "este degrau responde em 200 ms" e passaria a cortá-lo no
    // piso — exatamente quando ele estivesse disponível para responder.
    const memoria = _tetoDeDegrauParaTeste();
    memoria.series.clear();

    await handleComboChat({
      body: {},
      models: ["gemini/recusa", "cx/luna"],
      log,
      handleSingleModel: async (_b, m) => {
        if (m === "gemini/recusa") {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
        }
        return ok();
      },
    });

    // Nem plena nem censurada: o degrau TERMINOU (recusando), então não é
    // censura; e não entregou, então não é duração de entrega.
    expect(memoria.observacoesVivas("gemini", "recusa")).toHaveLength(0);
    memoria.series.clear();
  });

  it("só o 2xx entra como amostra plena", async () => {
    const memoria = _tetoDeDegrauParaTeste();
    memoria.series.clear();

    await handleComboChat({
      body: {},
      models: ["gemini/entrega", "cx/luna"],
      log,
      handleSingleModel: async () => ok(),
    });

    const obs = memoria.observacoesVivas("gemini", "entrega");
    expect(obs).toHaveLength(1);
    expect(obs[0].cortada).toBe(false);
    memoria.series.clear();
  });
});

// O custo de desistir não é uma latência: em ~2 de cada 3 vezes medidas, a
// chain que sofreu corte NÃO entregou e virou erro. Tratar isso como "5 s até a
// alternativa responder" faz o argmin cortar cedo demais — medido em produção,
// 16% das entregas reais do `muse-spark` aconteceram em tempo igual ou acima do
// teto aplicado.
describe("custo de abandonar medido", () => {
  it("sem desfechos bastantes usa o custo otimista de antes", async () => {
    const { custoDeAbandonar, CUSTO_ALTERNATIVA_MS } = await import("open-sse/services/stepCeiling.js");
    expect(custoDeAbandonar(null)).toBe(CUSTO_ALTERNATIVA_MS);
  });

  it("alternativa que sempre entrega devolve exatamente o custo de antes", async () => {
    const { custoDeAbandonar, CUSTO_ALTERNATIVA_MS } = await import("open-sse/services/stepCeiling.js");
    // p = 1 tem de ser idêntico ao comportamento anterior: a mudança só age
    // onde a medição diz que a alternativa falha.
    expect(custoDeAbandonar(1)).toBe(CUSTO_ALTERNATIVA_MS);
  });

  it("alternativa que falha na maioria encarece desistir", async () => {
    const { custoDeAbandonar, CUSTO_ALTERNATIVA_MS } = await import("open-sse/services/stepCeiling.js");
    // A taxa medida no `barroso-chat`: 33% de entrega depois de um corte.
    expect(custoDeAbandonar(0.33)).toBeGreaterThan(CUSTO_ALTERNATIVA_MS * 5);
  });

  it("a taxa só conta com desfechos suficientes", async () => {
    const { TetoDeDegrau, DESFECHOS_MINIMOS } = await import("open-sse/services/stepCeiling.js");
    const t = new TetoDeDegrau();
    for (let i = 0; i < DESFECHOS_MINIMOS - 1; i++) t.registrarDesfecho("a>b", false);
    expect(t.taxaDeEntregaAposCorte("a>b")).toBeNull();
    t.registrarDesfecho("a>b", false);
    expect(t.taxaDeEntregaAposCorte("a>b")).toBe(0);
  });

  it("o teto ALONGA quando a alternativa se mostra ruim — o defeito corrigido", async () => {
    const { TetoDeDegrau, DESFECHOS_MINIMOS } = await import("open-sse/services/stepCeiling.js");
    // Mesma distribuição de entrega nos dois: cauda longa e censura, o retrato
    // do `muse-spark`.
    // Maioria rápida e uma cauda real que vai longe: é aqui que o `C` decide,
    // porque o argmin fica DENTRO do observado em vez de na borda.
    const semiar = () => {
      const t = new TetoDeDegrau();
      for (let i = 0; i < 40; i++) t.registrarPlena("oc", "muse", 3000 + i * 50);
      for (let i = 0; i < 15; i++) t.registrarPlena("oc", "muse", 20000 + i * 2000);
      for (let i = 0; i < 20; i++) t.registrarCortada("oc", "muse", 14000);
      return t;
    };

    const alternativaBoa = semiar();
    for (let i = 0; i < DESFECHOS_MINIMOS; i++) alternativaBoa.registrarDesfecho("c1", true);

    const alternativaRuim = semiar();
    // 1 em 3 entrega: a medição real.
    for (let i = 0; i < DESFECHOS_MINIMOS * 3; i++) {
      alternativaRuim.registrarDesfecho("c2", i % 3 === 0);
    }

    const tetoBom = alternativaBoa.tetoPara("oc", "muse", Infinity, "c1");
    const tetoRuim = alternativaRuim.tetoPara("oc", "muse", Infinity, "c2");

    // Quando cair fora quase sempre dá em erro, esperar passa a valer mais.
    expect(tetoRuim).toBeGreaterThan(tetoBom);
  });
});

describe("kaplanMeier", () => {
  it("sem censura reproduz a empírica", async () => {
    const { kaplanMeier } = await import("open-sse/services/stepCeiling.js");
    const km = kaplanMeier([
      { ms: 1000, cortada: false },
      { ms: 2000, cortada: false },
      { ms: 3000, cortada: false },
      { ms: 4000, cortada: false },
    ]);
    // Quatro eventos, S cai 1 -> .75 -> .5 -> .25 -> 0
    expect(km.map((d) => d.S)).toEqual([0.75, 0.5, 0.25, 0]);
  });

  it("a censura retira do conjunto de risco sem contar como evento", async () => {
    const { kaplanMeier } = await import("open-sse/services/stepCeiling.js");
    // 1 entrega em 1 s, 1 corte em 2 s, 1 entrega em 3 s.
    const km = kaplanMeier([
      { ms: 1000, cortada: false },
      { ms: 2000, cortada: true },
      { ms: 3000, cortada: false },
    ]);
    // Em 1 s: 1/3 completou -> S = 2/3. Em 3 s resta 1 em risco (o cortado
    // saiu) e ele completa -> S = 0. O corte não vira "entregou em 2 s".
    expect(km[0].S).toBeCloseTo(2 / 3, 5);
    expect(km[km.length - 1].S).toBeCloseTo(0, 5);
  });
});
