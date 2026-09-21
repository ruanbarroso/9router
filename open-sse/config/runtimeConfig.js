// HTTP status codes
export const HTTP_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_ACCEPTABLE: 406,
  REQUEST_TIMEOUT: 408,
  RATE_LIMITED: 429,
  SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504
};

// Re-export error config (backward compat)
export { ERROR_TYPES, DEFAULT_ERROR_MESSAGES, BACKOFF_CONFIG, COOLDOWN_MS } from "./errorConfig.js";

// Cache TTLs (seconds)
export const CACHE_TTL = {
  userInfo: 300,    // 5 minutes
  modelAlias: 3600  // 1 hour
};

// Memory management config
export const MEMORY_CONFIG = {
  sessionTtlMs: 2 * 60 * 60 * 1000,
  sessionCleanupIntervalMs: 30 * 60 * 1000,
  dnsCacheTtlMs: 5 * 60 * 1000,
  proxyDispatchersMaxSize: 20,
};

// Parse a positive integer env override, falling back to a default.
function envMs(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function envUrl(name, def) {
  const raw = process.env[name]?.trim();
  return raw || def;
}

// SearXNG endpoint used by the unauthenticated web-search provider.
// Configure this for a separate Docker service or remote SearXNG instance.
export const SEARXNG_URL = envUrl("SEARXNG_URL", "http://localhost:8888/search");

// Inter-chunk stall timeout (once tokens are flowing). Generous headroom so
// slow reasoning models aren't aborted mid-stream. Env: STREAM_STALL_TIMEOUT_MS.
export const STREAM_STALL_TIMEOUT_MS = envMs("STREAM_STALL_TIMEOUT_MS", 360 * 1000);

// Time-to-first-token timeout (prompt prefill). Env: STREAM_FIRST_CHUNK_TIMEOUT_MS.
export const STREAM_FIRST_CHUNK_TIMEOUT_MS = envMs("STREAM_FIRST_CHUNK_TIMEOUT_MS", 200 * 1000);

// Portão de PRIMEIRO BYTE do passthrough Claude: quanto esperar pelo primeiro
// chunk do upstream ANTES de commitar o 200 para o cliente.
//
// O que ele resolve: quando o upstream morre depois dos headers e antes do
// primeiro token, o gateway já mandou 200 e não tem mais como trocar o status —
// o Claude Code recebe corpo vazio e reclama de "empty or malformed response
// (HTTP 200)", e alguém precisa entrar lá e pedir para continuar. Segurando o
// 200 até o primeiro byte, essa falha vira um `{ success: false }` no laço de
// contas de `src/sse/handlers/chat.js` e o retry é invisível para o cliente.
//
// Por que 3 s e por que só Claude: o TTFT do `claude` tem p99 = 2.824 ms
// (medido em 2.261 requisições), então 3.000 ms cobre 99,4% do tráfego e só 13
// requisições esperariam o teto. Um portão global seria outra coisa: o p90
// global é 18,3 s e o p50 do codex é 26,7 s — a espera cairia dentro da corrida
// de COMBO_STEP_CEILING_MS (12 s) e comeria o degrau seguinte.
//
// Estourar o teto NÃO é erro: o portão desiste e commita o 200 exatamente como
// antes, então o pior caso é o comportamento de hoje.
// Env: CLAUDE_FIRST_BYTE_GATE_MS.
export const CLAUDE_FIRST_BYTE_GATE_MS = envMs("CLAUDE_FIRST_BYTE_GATE_MS", 3000);

// Fetch connect timeout: abort if upstream doesn't return response headers within this duration
export const FETCH_CONNECT_TIMEOUT_MS = envMs("FETCH_CONNECT_TIMEOUT_MS", 60 * 1000);

// Teto DE PARTIDA de um degrau de combo que tem para onde cair. Vale desde a
// primeira requisição, sem esperar medição — o teto aprendido de
// `services/stepCeiling.js` só pode ENCURTAR daqui para baixo.
//
// Por que precisa existir um valor fixo: quem chama este gateway no caminho do
// zydon-ai é o barroso-keys, com um orçamento de 60 s. Gastar a cauda inteira
// num degrau custa o 503 — com o degrau seguinte, que existia exatamente para
// isto, nunca tentado.
//
// Por que 12 s (era 25 s, medido no journal de 2026-09-21, 6h30 de tráfego):
// o degrau 1 do `barroso-chat` (`muse-spark`) respondeu 1.311 vezes com p50 3 s,
// p90 11 s, p95 15 s, e estourou o teto 310 vezes — 310 requisições pagando
// 25 s ANTES de a chain começar. Com o custo real de cair para o resto da chain
// medido no mesmo journal (degrau 2 p50 9 s, degrau 3 p50 2 s — o degrau 3 é
// rápido, ao contrário do que o agregado do keys sugeria), minimizar
// E(T) = E[min(X,T)] + P(X>T)·C dá ótimo raso entre 4 s e 9 s (E≈7,7 s) contra
// E=10,7 s em 25 s.
//
// Não peguei o mínimo da curva: o ganho de 12 s para 5 s é de 0,7 s por
// requisição, mas leva a queda para o degrau 2 de 25% para 39% do tráfego — e
// o degrau 2 é justamente o que morreu de quota (`all 43 accounts locked`) no
// incidente que originou tudo isto. 12 s fica a 0,3 s do ótimo, economiza 2,3 s
// por requisição e move só +5 pp para o degrau frágil. O p90 do degrau 1 (11 s)
// cabe embaixo do teto, então quem hoje entrega no degrau 1 continua entregando.
//
// O aprendizado sozinho não cobre este caso: ele exige 40 amostras por dupla, o
// combo `barroso-quick` recebe ~22 chamadas por hora, e a série é em memória e
// zera a cada deploy. Proteção que só arma depois de uma hora de tráfego não
// protege a primeira hora — e era nela que os 503 estavam caindo.
// Env: COMBO_STEP_CEILING_MS. `envMs` só aceita inteiro POSITIVO, então não há
// como desligar por env — para afrouxar, suba o valor.
export const COMBO_STEP_CEILING_MS = envMs("COMBO_STEP_CEILING_MS", 12 * 1000);

// ORÇAMENTO TOTAL do combo: o prazo de quem CHAMOU, não o de um degrau.
//
// O teto acima corta um degrau pendurado, mas não sabe quanto do prazo do
// cliente já foi gasto pelos degraus anteriores. Medido em 2026-09-21 numa
// requisição real de `barroso-chat` que terminou em 503 (`d85a5695`): degrau 1
// (`muse-spark`) gastou 20,5 s no teto; degrau 2 (`gemini-3.8-flash`) levou 429
// em 4 contas seguidas até `all 43 accounts locked`, ~6 s, mais 2 s de cooldown;
// o degrau 3 (`gpt-5.6-luna`, p50 10 s / p90 69 s — o MAIS LENTO da chain)
// recebeu o bastão com ~30 s já queimados dos 60 s do barroso-keys. O keys
// desistiu em `upstream nao mandou headers em 60000 ms` enquanto o degrau 3
// ainda escrevia.
//
// Sem deadline o gateway segue abrindo degrau DEPOIS que o cliente foi embora:
// o trabalho não é só perdido, ele ocupa conta e quota que as requisições ainda
// vivas precisam — o que realimenta o 429 que derrubou o degrau 2.
//
// O prazo chega por header (`X-Deadline-Ms`, quanto o cliente ainda espera);
// este valor é o piso de segurança de quando NINGUÉM manda header: 0 = sem
// deadline, comportamento de antes. Deixar desligado por padrão é deliberado —
// um deadline inventado cortaria cliente sem prazo nenhum.
// Env: COMBO_TOTAL_BUDGET_MS.
export const COMBO_TOTAL_BUDGET_MS = envMs("COMBO_TOTAL_BUDGET_MS", 0);

// Margem descontada do deadline do cliente: rede, serialização e o próprio
// hop do gateway. Responder "não deu" 1,5 s antes do prazo é resposta; 200 ms
// depois dele é um socket morto.
export const COMBO_DEADLINE_MARGIN_MS = envMs("COMBO_DEADLINE_MARGIN_MS", 1500);

// Gemini native TTS fetch timeout: abort if Google does not return response headers in time.
export const GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS = envMs("GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS", 45 * 1000);

// Default token limits
export const DEFAULT_MAX_TOKENS = 64000;
export const DEFAULT_MIN_TOKENS = 32000;

export const TOKEN_SAVER_HEADER = "x-9router-token-saver";

// Retry config for 429 responses (legacy - kept for backward compatibility)
export const RETRY_CONFIG = {
  maxAttempts: 2,
  delayMs: 2000
};

// Default retry config by status code: { attempts, delayMs }
// Backward compat: if value is a number, treated as attempts with RETRY_CONFIG.delayMs
export const DEFAULT_RETRY_CONFIG = {
  429: { attempts: 0, delayMs: 0 },
  502: { attempts: 3, delayMs: 3000 },
  503: { attempts: 3, delayMs: 2000 },
  504: { attempts: 2, delayMs: 3000 }
};

// Normalize a retry entry to { attempts, delayMs }
export function resolveRetryEntry(entry) {
  if (entry == null) return { attempts: 0, delayMs: RETRY_CONFIG.delayMs };
  if (typeof entry === "number") return { attempts: entry, delayMs: RETRY_CONFIG.delayMs };
  return {
    attempts: entry.attempts || 0,
    delayMs: entry.delayMs != null ? entry.delayMs : RETRY_CONFIG.delayMs
  };
}

// Requests containing these texts will bypass provider
export const SKIP_PATTERNS = [
  "Please write a 5-10 word title for the following conversation:"
];
