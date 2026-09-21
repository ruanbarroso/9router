// TETO DE PRIMEIRO BYTE — quanto esperar pelo primeiro chunk do upstream antes
// de commitar o 200 para o cliente.
//
// ─── POR QUE ISTO NÃO É UMA CONSTANTE ────────────────────────────────────────
//
// A primeira versão disto era `CLAUDE_FIRST_BYTE_GATE_MS = 3000`, justificada
// por um p99 de 2.824 ms que eu medi UMA VEZ e congelei num comentário. É o
// mesmo defeito que `stepCeiling.js` já tinha documentado e corrigido para o
// teto de degrau: um palpite calibrado à mão envelhece no dia seguinte, e
// quando envelhece ninguém percebe — ele só passa a cortar resposta boa (se o
// upstream ficou mais lento) ou a esperar à toa (se ficou mais rápido).
//
// Quem dita o teto é a MEDIÇÃO. Este módulo não inventa número nenhum: ele
// reusa a mesma máquina de `stepCeiling.js` (reinício ótimo com censura à
// direita e Kaplan-Meier) aplicada a outra grandeza — o tempo até o PRIMEIRO
// BYTE, não a duração do degrau inteiro.
//
// ─── SEM MEDIÇÃO, SEM TETO ───────────────────────────────────────────────────
//
// `tetoPara` devolve null abaixo de `AMOSTRAS_MINIMAS`, e aqui isso é levado ao
// pé da letra: sem amostra suficiente o portão NÃO ARMA e o caminho é
// exatamente o de antes (commita o 200, como sempre). Regressão zero por
// construção, e nenhum degrau fixo escondido atrás de um `??`.
//
// Diferença deliberada em relação a `combo.js`, que cai em `stepCeilingMs`
// quando não há medição: lá o teto configurado protege contra um degrau que
// pendura por minutos, e não ter teto é o pior caso. Aqui não ter teto é
// apenas o comportamento atual — a falha que o portão pega é rara (~0,5%) e o
// preço de esperá-la mais um pouco é baixo. Não há por que inventar partida
// fixa para comprar tão pouco.
//
// ─── O CUSTO DA ALTERNATIVA ──────────────────────────────────────────────────
//
// Cortar aqui não custa "o próximo degrau": custa uma nova tentativa na conta
// seguinte, dentro do laço de `src/sse/handlers/chat.js`. Como o corte só
// acontece ANTES do primeiro byte, o cliente não vê nada — nenhum byte saiu,
// nenhum 200 foi commitado. É por isso que o custo é o TTFT de outra conta, e
// não o prejuízo de uma resposta perdida.
//
// ─── A AMOSTRA ───────────────────────────────────────────────────────────────
//
// - PLENA: o primeiro byte chegou em `t` ms. É uma observação de verdade.
// - CENSURADA: o teto estourou em `t` ms e a única coisa que se sabe é
//   `TTFT > t`. Entra marcada, e o Kaplan-Meier a usa como limite inferior —
//   nunca como se fosse uma entrega. Sem isso o teto mediria a si mesmo:
//   corta a cauda, a cauda sai da amostra, o teto seguinte desce, até o piso.
//
// Um upstream que morreu sem mandar byte (o caso que o portão existe para
// pegar) NÃO é amostra de latência: ele não é "um TTFT muito grande", é uma
// falha. Registrá-lo alongaria o teto justamente por causa das requisições que
// nunca iam entregar.

import { TetoDeDegrau } from "./stepCeiling.js";

// Piso absoluto do portão. Existe pelo mesmo motivo que `TETO_MINIMO_MS` em
// `stepCeiling.js` — segurar o caso degenerado de série pequena e ruidosa —
// mas é menor porque a grandeza é outra: ali se mede a resposta inteira, aqui
// só o primeiro byte. Um piso de 5 s sobre um TTFT de mediana ~500 ms não
// protegeria medição nenhuma, só impediria o portão de valer para o tráfego
// rápido, que é a maior parte dele.
export const PISO_PRIMEIRO_BYTE_MS = 1_000;

// Série própria, separada da do teto de degrau: são grandezas diferentes da
// mesma dupla (provider, model) e misturá-las estragaria as duas.
const tetoDePrimeiroByte = new TetoDeDegrau({ tetoMinimoMs: PISO_PRIMEIRO_BYTE_MS });

/**
 * O teto medido para o primeiro byte desta dupla, ou null quando ainda não há
 * amostra suficiente — e aí o chamador não arma portão nenhum.
 */
export function tetoDePrimeiroByteMs(provider, model) {
  return tetoDePrimeiroByte.tetoPara(provider, model);
}

/** O primeiro byte chegou em `duracaoMs`. */
export function registrarPrimeiroByte(provider, model, duracaoMs) {
  tetoDePrimeiroByte.registrarPlena(provider, model, duracaoMs);
}

/** O teto estourou em `duracaoMs`: só se sabe que `TTFT > duracaoMs`. */
export function registrarPrimeiroByteCortado(provider, model, duracaoMs) {
  tetoDePrimeiroByte.registrarCortada(provider, model, duracaoMs);
}

/** Só para teste: zera a memória entre casos. */
export function _resetPrimeiroByte() {
  tetoDePrimeiroByte.series.clear();
  tetoDePrimeiroByte.desfechos.clear();
}
