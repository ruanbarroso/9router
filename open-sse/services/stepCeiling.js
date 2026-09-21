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
// 2. PISO ABSOLUTO (`TETO_MINIMO_MS`): 5 s. Era 20 s, e a justificativa de
//    então era a RESOLUÇÃO DA FONTE: a mediana vinha do journal, gravado em
//    segundos inteiros, então um degrau com mediana real de 1,4 s virava 1 s e
//    3 × 1 s = 3 s cortaria 5,5% de sucessos legítimos. Essa premissa não vale
//    mais para esta série: ela é medida em processo com `Date.now()`, em
//    milissegundos, e a mediana agora sai da sobrevivência estimada e não de
//    uma lista enviesada de sobreviventes. Com a fonte precisa, o piso alto
//    deixou de proteger contra erro de medição e passou a ser só um chute
//    grande impedindo a medição de valer para modelos rápidos. 5 s continua
//    segurando o caso degenerado de série pequena e ruidosa.
//
// 3. SÓ COM SAÍDA (`temSaidaDaqui`, no chamador): o teto só vale quando existe um
//    PRÓXIMO degrau para tentar. Cortar o ÚLTIMO degrau não troca uma espera por
//    uma alternativa — troca uma espera por um erro, o que é estritamente pior
//    para quem chamou. O último degrau espera o que for preciso.
//
// ─── AMOSTRA ─────────────────────────────────────────────────────────────────
//
// Uma duração cortada pelo teto NÃO é uma duração observada. Tratá-la como se
// fosse vira catraca: o teto corta a cauda, a cauda sai da amostra, o teto
// seguinte é medido sobre a distribuição já truncada e desce de novo, até o
// piso. Quem aprende com o que cortou aprende só a cortar mais.
//
// A resposta a isso era DESCARTAR a cortada. Isso evita a catraca e cria o
// problema oposto — viés de sobrevivência: a série passa a descrever só quem
// respondeu, e para um degrau que pendura na maioria das vezes ela diz
// exatamente o contrário do que o tráfego real faz. Medido: das 29 quedas do
// degrau 1 do `barroso-chat`, 29 foram por teto e nenhuma por erro.
//
// As duas coisas são evitáveis ao mesmo tempo, porque a cortada não é ausência
// de informação: ela é `X > T`, uma observação CENSURADA À DIREITA. Ela entra
// na série marcada como tal e o Kaplan-Meier a usa como limite inferior, nunca
// como entrega. Ver o bloco CENSURA À DIREITA.
//
// Memória em processo e com TTL: quando as amostras envelhecem, a dupla volta ao
// teto configurado, que é a resposta certa para quem não se mediu agora. Não há
// persistência porque não há onde persistir — o `requestDetails` está desligado
// nesta instância (`ENABLE_REQUEST_LOGS=false`), e é ele que guardaria latência.

// Abaixo disto o ótimo é ruído amostral e não uma medição.
export const AMOSTRAS_MINIMAS = 20;
// Teto de memória por dupla. Amostra velha não descreve a fila de agora.
export const AMOSTRAS_MAX = 512;
export const AMOSTRA_TTL_MS = 6 * 60 * 60 * 1000;
// Custo esperado da alternativa: o degrau seguinte respondendo. As medianas
// medidas dos degraus que servem de alternativa ficam entre 0 s e 3 s; 5 s é
// deliberadamente acima delas, porque errar `C` para CIMA só compra paciência.
export const CUSTO_ALTERNATIVA_MS = 5_000;
export const PISO_MEDIANA_K = 3;
// Ver freio 2. Nenhum teto aprendido desce abaixo disto.
export const TETO_MINIMO_MS = 5_000;
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

// ─── CENSURA À DIREITA (2026-09-21) ─────────────────────────────────────────
//
// O bloco AMOSTRA acima resolve meio problema e cria outro. Está certo que uma
// duração CORTADA não é uma duração observada — usá-la como se fosse vira a
// catraca descrita lá. Mas jogá-la fora perde a única informação que ela tem, e
// que não é pouca: `X > teto`. Isso é uma observação CENSURADA À DIREITA, e a
// estatística de sobrevivência sabe exatamente o que fazer com ela.
//
// Por que isso importa aqui, medido em produção no `barroso-chat`: das 29
// quedas do degrau 1 (`muse-spark`), 29 foram por TETO e zero por erro. Se só
// a amostra plena entra na série, o teto aprende com os ~45% que responderam
// rápido e conclui "este degrau é rápido" — enquanto 55% das requisições reais
// estouram nele. É viés de sobrevivência puro: a série descreve os
// sobreviventes, não o tráfego.
//
// KAPLAN-MEIER dá a função de sobrevivência S(t) = P(X > t) sem inventar nada
// sobre a forma da distribuição, usando plenas e cortadas juntas:
//
//   S(t) = ∏ (1 - d_i / n_i)   para cada tempo de evento t_i <= t
//
// onde `n_i` é quem ainda estava "em risco" em t_i e `d_i` quantos
// completaram ali. Uma cortada em T não conta como evento — ela sai do
// conjunto de risco DEPOIS de T, o que é precisamente dizer "só sei que passou
// de T".
//
// Com S(t) estimado, E(T) deixa de ser uma média sobre sobreviventes e vira a
// conta certa sobre a distribuição real:
//
//   E[min(X,T)] = ∫₀ᵀ S(t) dt        P(X > T) = S(T)
//
// É a MESMA fórmula de reinício ótimo de antes; o que muda é que agora ela
// enxerga a cauda que o próprio teto vinha escondendo.

/**
 * Sobrevivência de Kaplan-Meier a partir de observações plenas e censuradas.
 * @param {{ms:number, cortada:boolean}[]} obs
 * @returns {{t:number, S:number}[]} degraus de S(t), t crescente
 */
export function kaplanMeier(obs) {
  const v = [...obs].sort((a, b) => a.ms - b.ms);
  const degraus = [];
  let emRisco = v.length;
  let S = 1;
  let i = 0;
  while (i < v.length) {
    const t = v[i].ms;
    let eventos = 0;
    let saem = 0;
    while (i < v.length && v[i].ms === t) {
      if (v[i].cortada) saem++;
      else eventos++;
      i++;
    }
    if (eventos > 0 && emRisco > 0) {
      S *= 1 - eventos / emRisco;
      degraus.push({ t, S });
    }
    emRisco -= eventos + saem;
  }
  return degraus;
}

/**
 * argmin_T de E(T) = E[min(X,T)] + S(T)·C sobre a sobrevivência estimada.
 *
 * Mesma fórmula de reinício ótimo de `otimoDe`, mas alimentada por
 * Kaplan-Meier, então a cauda censurada entra na conta em vez de sumir.
 * E[min(X,T)] = ∫₀ᵀ S(t)dt é exato por soma de retângulos: entre dois degraus
 * S é constante.
 */
export function otimoCensurado(obs, custoAlternativaMs = CUSTO_ALTERNATIVA_MS) {
  const km = kaplanMeier(obs);
  if (km.length === 0) return null;

  let integral = 0;
  let tAnt = 0;
  let SAnt = 1;
  let melhorT = km[km.length - 1].t;
  let melhorE = Infinity;

  for (const { t, S } of km) {
    // ∫ de tAnt até t, onde S valia SAnt.
    integral += SAnt * (t - tAnt);
    const E = integral + S * custoAlternativaMs;
    if (E < melhorE) {
      melhorE = E;
      melhorT = t;
    }
    tAnt = t;
    SAnt = S;
  }

  // Sobrevivência que nunca chega a zero significa cauda que não se fechou
  // dentro do observado: ali o argmin não escolheu ponto de corte, ele disse
  // "não corte dentro do que eu vi".
  return { teto: melhorT, naBorda: melhorT === km[km.length - 1].t, S: SAnt };
}

/**
 * Memória por (provider, model) das durações de degrau, plenas e censuradas.
 */
export class TetoDeDegrau {
  constructor({ agora = () => Date.now(), ttlMs = AMOSTRA_TTL_MS, tetoMinimoMs = TETO_MINIMO_MS } = {}) {
    this.agora = agora;
    this.ttlMs = ttlMs;
    this.tetoMinimoMs = tetoMinimoMs;
    this.series = new Map();
  }

  #registrar(provider, model, duracaoMs, cortada) {
    if (!Number.isFinite(duracaoMs) || duracaoMs < 0) return;
    const chave = chaveDoDegrau(provider, model);
    let serie = this.series.get(chave);
    if (!serie) {
      serie = [];
      this.series.set(chave, serie);
    }
    serie.push({ ms: duracaoMs, ts: this.agora(), cortada });
    if (serie.length > AMOSTRAS_MAX) serie.splice(0, serie.length - AMOSTRAS_MAX);
  }

  /**
   * Registra uma amostra PLENA — um degrau que completou por conta própria.
   */
  registrarPlena(provider, model, duracaoMs) {
    this.#registrar(provider, model, duracaoMs, false);
  }

  /**
   * Registra uma amostra CENSURADA — o teto cortou em `duracaoMs` e a única
   * coisa que se sabe é `X > duracaoMs`. Não é uma duração observada e nunca
   * entra na conta como se fosse: ver o bloco CENSURA À DIREITA.
   */
  registrarCortada(provider, model, duracaoMs) {
    this.#registrar(provider, model, duracaoMs, true);
  }

  /** Observações vivas com o marcador de censura preservado. */
  observacoesVivas(provider, model) {
    const serie = this.series.get(chaveDoDegrau(provider, model));
    if (!serie) return [];
    const corte = this.agora() - this.ttlMs;
    const vivas = serie.filter((a) => a.ts >= corte);
    if (vivas.length !== serie.length) this.series.set(chaveDoDegrau(provider, model), vivas);
    return vivas.map((a) => ({ ms: a.ms, cortada: !!a.cortada }));
  }

  amostrasVivas(provider, model) {
    return this.observacoesVivas(provider, model).filter((o) => !o.cortada).map((o) => o.ms);
  }

  /**
   * O teto para esta dupla, ou null quando não há medição suficiente — e aí o
   * chamador não impõe teto nenhum, que é o comportamento de antes desta mudança.
   *
   * `tetoConfiguradoMs` NÃO é mais limite superior: ver APRENDER TAMBÉM PODE
   * ALONGAR, abaixo. Ele é o que vale na AUSÊNCIA de medição, e quem existe
   * para limitar a espera de quem chamou é o orçamento, no chamador.
   */
  tetoPara(provider, model, tetoConfiguradoMs = Infinity) {
    const obs = this.observacoesVivas(provider, model);
    // A censura conta para o mínimo: um degrau que estourou 30 vezes é 30
    // observações do comportamento dele, não zero. Exigir 40 PLENAS de um
    // degrau que pendura na maioria das vezes é o mesmo que nunca aprender
    // justamente sobre quem mais precisa de teto.
    if (obs.length < AMOSTRAS_MINIMAS) return null;

    const otimo = otimoCensurado(obs);
    if (!otimo) return null;
    const { teto, naBorda } = otimo;

    // Mediana pela sobrevivência (primeiro t com S <= 0.5), não pela lista de
    // plenas: com muita censura a mediana das plenas é otimista por construção.
    const km = kaplanMeier(obs);
    const medianaKM = km.find((d) => d.S <= 0.5)?.t ?? null;

    const candidato = naBorda ? teto * MARGEM_NA_BORDA : teto;
    // O piso pela mediana só existe quando há mediana estimável: se S nunca
    // desce a 0,5, mais da metade das tentativas NÃO completa, e aí não há
    // "comportamento normal" para proteger — é o caso patológico que o teto
    // existe para cortar.
    const pisos = [this.tetoMinimoMs];
    if (medianaKM !== null) pisos.push(medianaKM * PISO_MEDIANA_K);
    // O piso pela mediana protege contra cortar um modelo lento cedo demais,
    // mas ele é um MÚLTIPLO (3×) e sozinho não é um valor defensável: para uma
    // mediana de 90 s ele pediria 270 s, muito além de qualquer coisa já
    // observada. Esperar além do que o degrau JAMAIS levou não compra resposta
    // nenhuma — depois do máximo observado não há massa de probabilidade que a
    // série conheça. A cauda medida é o limite honesto.
    const maxObservado = Math.max(...obs.map((o) => o.ms));
    const comPisos = Math.min(Math.max(candidato, ...pisos), maxObservado * MARGEM_NA_BORDA);

    // APRENDER TAMBÉM PODE ALONGAR (2026-09-21).
    //
    // Antes isto era `Math.min(comPisos, tetoConfiguradoMs)`: aprender só
    // encurtava. Parecia conservador e não era. Com o configurado em 12 s, um
    // degrau cuja medição diz "entrega em 15 s" era cortado em 12 s PARA
    // SEMPRE — e cada corte gerava outra censura em 12 s, que confirmava o
    // corte. O teto deixava de medir o modelo e passava a medir a si mesmo.
    //
    // O valor configurado é o que se faz SEM MEDIÇÃO: um palpite calibrado à
    // mão, e foi justamente ele que ficou velho quando a chain mudou de 3 para
    // 4 degraus. Onde há medição suficiente, ela é a melhor resposta que
    // existe — para os dois lados. Esperar 15 s por quem entrega em 15 s não é
    // esperar demais; é a única forma de ter a resposta.
    //
    // Quem limita o alongamento é o ORÇAMENTO, não este palpite: o chamador já
    // faz `min(teto, fatia_do_rateio, sobra)`, então nada aqui pode estourar o
    // prazo de quem chamou. É a fronteira certa — o orçamento é um fato sobre
    // o cliente, o teto configurado era só um chute sobre o modelo.
    const final = comPisos;
    return Number.isFinite(final) ? Math.round(final) : null;
  }
}
