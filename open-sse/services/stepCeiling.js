// TETO POR DEGRAU DE COMBO — quanto vale a pena esperar por (provider, model)
// antes de cair para o próximo degrau.
//
// ─── O PROBLEMA MEDIDO ───────────────────────────────────────────────────────
//
// O `handleComboChat` faz `await handleSingleModel(...)` sem teto nenhum. O único
// guarda que existe no caminho é o `FETCH_CONNECT_TIMEOUT_MS` do `base.js`, e ele
// é limpo (`clearTimeout(connectTimer)`) no instante em que os CABEÇALHOS chegam —
// a leitura do corpo que vem depois não tem guarda alguma. Como todo o tráfego
// deste gateway é não-streaming (`stream=false` em 1.000/1.000 requisições
// gravadas), é exatamente ali que o tempo é gasto, e é ali que não havia ninguém
// olhando.
//
// Medido no journal do krouter, 2 dias, por duração de degrau de combo
// (`[COMBO] Trying model` -> `succeeded`/`failed`):
//
//   degrau                                      n      p50    p90    p99    máx
//   cc/claude-opus-5                        14.983     1 s    2 s    4 s     9 s
//   cx/gpt-5.6-luna(max)                     3.164     2 s   15 s   71 s   151 s
//   oc/muse-spark-1.3-contributor-free       1.954     3 s   11 s   33 s    75 s
//   gemini/gemini-3.5-flash-lite(none)       1.769     1 s    5 s   38 s    58 s
//   gemini/gemini-3.8-flash(high)              376     3 s   20 s   43 s    85 s
//
// O `gemini-3.5-flash-lite` é o caso que motivou isto: mediana de 1 s e cauda de
// 58 s. Ele é o PRIMEIRO degrau do combo `barroso-quick`, e quem chama é o
// `zydon-ai` pelo WhatsApp. Enquanto ele pendura, o segundo degrau
// (`cx/gpt-5.6-luna`) nunca é tentado, e o teto de 60 s do barroso-keys estoura
// primeiro: 503 para o usuário depois de um minuto, sem que a alternativa que
// existia para exatamente este caso tenha sido tocada.
//
// CORREÇÃO (2026-09-21, medido): a distribuição NÃO é bimodal, como esta nota
// afirmava antes. Medido no HAProxy em 3 h de produção (8.472 requisições, tempo
// até os headers): p50 9 ms, p90 3,6 s, p99 23,7 s, máx 75 s — uma cauda
// contínua, não dois ramos. E há sucesso real encostando no teto de quem chama:
// entre as 159 respostas 200 de `barroso-quick` na mesma janela, a mais lenta
// levou 59,6 s contra o orçamento de 60 s do barroso-keys.
//
// Isso não desfaz o argumento, mas muda o que ele prova. Cortar em T SEMPRE
// sacrifica algum sucesso legítimo; a questão é se o que se paga na espera vale
// o que se ganha. É exatamente o que E(T) responde, e é por isso que `C` (o
// custo da alternativa) é o termo decisivo: com o degrau seguinte respondendo em
// ~5 s, esperar 60 s por uma cauda de 3,1% deixa de compensar. O que NÃO se pode
// mais dizer é "não há resposta boa sendo cortada" — há, e os freios abaixo
// existem para manter esse número pequeno e consciente.
//
// ─── A CONTA ─────────────────────────────────────────────────────────────────
//
// A pergunta não é "qual quantil da cauda", é a do REINÍCIO ÓTIMO: qual T
// minimiza o tempo esperado até TER a resposta, contando o que se paga quando o
// corte acontece?
//
//   E(T) = E[min(X, T)] + P(X > T) × C          teto* = argmin_T E(T)
//
// `C` é o custo da alternativa: o tempo até o degrau seguinte responder. É a
// única coisa que um quantil não sabe, e é ela que vira o problema do avesso —
// com C ≈ 5 s, esperar 60 s pela cauda deixa de ser prudência.
//
// A conta é EXATA e O(n log n), sem varredura de grade: entre duas amostras
// consecutivas P(X > T) é constante e E[min(X,T)] cresce, então E(T) só pode cair
// EM CIMA de uma amostra observada. Basta percorrer as amostras ordenadas com
// soma prefixa.
//
// ─── OS TRÊS FREIOS, E POR QUE CADA UM EXISTE ────────────────────────────────
//
// Levada ao pé da letra, a fórmula DELETA modelo lento: para o
// `nvidia/z-ai/glm-5.3(max)` (mediana 16 s) o ótimo é cortar em segundos, o que
// significa que ele nunca mais responde. Só que a alternativa é OUTRO MODELO, e a
// fórmula não sabe nada sobre qualidade de resposta — trocar o modelo que atende
// é decisão de produto, não de latência, e um teto de timeout não tem autoridade
// para tomá-la em silêncio. Daí os freios:
//
// 1. PISO PELA MEDIANA (`PISO_MEDIANA_K`): o teto nunca desce abaixo de
//    k × mediana da própria dupla. Um modelo que está se comportando
//    NORMALMENTE sempre tem chance de responder; o que se corta é a cauda dele,
//    não ele.
//
// 2. PISO ABSOLUTO (`TETO_MINIMO_MS`): 20 s. O piso pela mediana sozinho não
//    basta porque a mediana aqui vem do journal, cuja resolução é de 1 SEGUNDO —
//    um degrau com mediana real de 1,4 s é gravado como 1 s, e 3 × 1 s = 3 s
//    cortaria 5,5% de sucessos legítimos do flash-lite. Aos 20 s o corte cai para
//    3,1%, e quase tudo que sobra é o ramo patológico. Este piso é o que mantém a
//    mudança conservadora: ela existe para matar a cauda de 60 s, não para
//    espremer o p90.
//
// 3. SÓ COM SAÍDA (`temSaidaDaqui`, no chamador): o teto só vale quando existe um
//    PRÓXIMO degrau para tentar. Cortar o ÚLTIMO degrau não troca uma espera por
//    uma alternativa — troca uma espera por um erro, o que é estritamente pior
//    para quem chamou. O último degrau espera o que for preciso.
//
// ─── AMOSTRA ─────────────────────────────────────────────────────────────────
//
// Só entra na conta a amostra PLENA: um degrau que COMPLETOU (com sucesso ou com
// erro do provider), nunca um que o próprio teto cortou. Sem isso a série vira
// uma catraca: o teto corta a cauda, a cauda sai da amostra, o teto seguinte é
// medido sobre a distribuição já truncada e desce de novo, até o piso. Quem
// aprende com o que cortou aprende só a cortar mais.
//
// Memória em processo e com TTL: quando as amostras envelhecem, a dupla volta ao
// teto configurado, que é a resposta certa para quem não se mediu agora. Não há
// persistência porque não há onde persistir — o `requestDetails` está desligado
// nesta instância (`ENABLE_REQUEST_LOGS=false`), e é ele que guardaria latência.

// Abaixo disto o ótimo é ruído amostral e não uma medição.
export const AMOSTRAS_MINIMAS = 40;
// Teto de memória por dupla. Amostra velha não descreve a fila de agora.
export const AMOSTRAS_MAX = 512;
export const AMOSTRA_TTL_MS = 6 * 60 * 60 * 1000;
// Custo esperado da alternativa: o degrau seguinte respondendo. As medianas
// medidas dos degraus que servem de alternativa ficam entre 0 s e 3 s; 5 s é
// deliberadamente acima delas, porque errar `C` para CIMA só compra paciência.
export const CUSTO_ALTERNATIVA_MS = 5_000;
export const PISO_MEDIANA_K = 3;
// Ver freio 2. Nenhum teto aprendido desce abaixo disto.
export const TETO_MINIMO_MS = 20_000;
// Margem aplicada quando o argmin cai na MAIOR amostra: ali a fórmula não
// escolheu um ponto de corte, ela disse "não corte dentro do que eu vi", e o
// máximo observado é só onde os dados terminaram.
export const MARGEM_NA_BORDA = 1.15;

export function chaveDoDegrau(provider, model) {
  return `${provider}/${model}`;
}

/**
 * argmin_T de E(T) = E[min(X,T)] + P(X>T)*C sobre as amostras observadas.
 * Exato e O(n log n): E(T) só pode cair em cima de uma amostra.
 * @returns {{ teto: number, naBorda: boolean }}
 */
export function otimoDe(amostras, custoAlternativaMs = CUSTO_ALTERNATIVA_MS) {
  const v = [...amostras].sort((a, b) => a - b);
  const n = v.length;
  let soma = 0;
  let melhorT = v[n - 1];
  let melhorE = Infinity;

  for (let i = 0; i < n; i++) {
    const T = v[i];
    soma += T;
    const sobrevivem = n - i - 1;
    const E = (soma + sobrevivem * T) / n + (sobrevivem / n) * custoAlternativaMs;
    if (E < melhorE) {
      melhorE = E;
      melhorT = T;
    }
  }

  return { teto: melhorT, naBorda: melhorT === v[n - 1] };
}

/**
 * Memória por (provider, model) das durações de degrau que COMPLETARAM.
 */
export class TetoDeDegrau {
  constructor({ agora = () => Date.now(), ttlMs = AMOSTRA_TTL_MS, tetoMinimoMs = TETO_MINIMO_MS } = {}) {
    this.agora = agora;
    this.ttlMs = ttlMs;
    this.tetoMinimoMs = tetoMinimoMs;
    this.series = new Map();
  }

  /**
   * Registra uma amostra PLENA — um degrau que completou por conta própria.
   * Um degrau cortado pelo teto NUNCA entra aqui: ver o bloco AMOSTRA.
   */
  registrarPlena(provider, model, duracaoMs) {
    if (!Number.isFinite(duracaoMs) || duracaoMs < 0) return;
    const chave = chaveDoDegrau(provider, model);
    let serie = this.series.get(chave);
    if (!serie) {
      serie = [];
      this.series.set(chave, serie);
    }
    serie.push({ ms: duracaoMs, ts: this.agora() });
    if (serie.length > AMOSTRAS_MAX) serie.splice(0, serie.length - AMOSTRAS_MAX);
  }

  amostrasVivas(provider, model) {
    const serie = this.series.get(chaveDoDegrau(provider, model));
    if (!serie) return [];
    const corte = this.agora() - this.ttlMs;
    const vivas = serie.filter((a) => a.ts >= corte);
    if (vivas.length !== serie.length) this.series.set(chaveDoDegrau(provider, model), vivas);
    return vivas.map((a) => a.ms);
  }

  /**
   * O teto para esta dupla, ou null quando não há medição suficiente — e aí o
   * chamador não impõe teto nenhum, que é o comportamento de antes desta mudança.
   *
   * `tetoConfiguradoMs` é o limite superior: aprender só pode ENCURTAR a espera.
   */
  tetoPara(provider, model, tetoConfiguradoMs = Infinity) {
    const amostras = this.amostrasVivas(provider, model);
    if (amostras.length < AMOSTRAS_MINIMAS) return null;

    const { teto, naBorda } = otimoDe(amostras);
    const ordenadas = [...amostras].sort((a, b) => a - b);
    const mediana = ordenadas[Math.floor(ordenadas.length / 2)];

    const candidato = naBorda ? teto * MARGEM_NA_BORDA : teto;
    const comPisos = Math.max(candidato, mediana * PISO_MEDIANA_K, this.tetoMinimoMs);

    // Aprender só encurta. Nunca esperamos mais do que já esperaríamos.
    const final = Math.min(comPisos, tetoConfiguradoMs);
    return Number.isFinite(final) ? Math.round(final) : null;
  }
}
