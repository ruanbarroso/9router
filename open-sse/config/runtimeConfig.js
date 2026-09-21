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

// Fetch connect timeout: abort if upstream doesn't return response headers within this duration
export const FETCH_CONNECT_TIMEOUT_MS = envMs("FETCH_CONNECT_TIMEOUT_MS", 60 * 1000);

// Teto DE PARTIDA de um degrau de combo que tem para onde cair. Vale desde a
// primeira requisição, sem esperar medição — o teto aprendido de
// `services/stepCeiling.js` só pode ENCURTAR daqui para baixo.
//
// Por que 25 s e por que precisa existir um valor fixo: quem chama este gateway
// no caminho do zydon-ai é o barroso-keys, com um orçamento de 60 s. Medido em
// 3 h de produção (8.472 requisições, tempo até os headers no HAProxy): p50 9 ms,
// p90 3,6 s, p99 23,7 s, máx 75 s. Um degrau que passa de 25 s já está na cauda
// do p99, e gastar nela o orçamento inteiro de quem chamou custa o 503 — com o
// degrau seguinte, que existia exatamente para isto, nunca tentado.
//
// O aprendizado sozinho não cobre este caso: ele exige 40 amostras por dupla, o
// combo `barroso-quick` recebe ~22 chamadas por hora, e a série é em memória e
// zera a cada deploy. Proteção que só arma depois de uma hora de tráfego não
// protege a primeira hora — e era nela que os 503 estavam caindo.
// Env: COMBO_STEP_CEILING_MS. `envMs` só aceita inteiro POSITIVO, então não há
// como desligar por env — para afrouxar, suba o valor.
export const COMBO_STEP_CEILING_MS = envMs("COMBO_STEP_CEILING_MS", 25 * 1000);

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
