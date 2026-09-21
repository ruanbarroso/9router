// OpenAI-compatible error types mapping (client-facing)
export const ERROR_TYPES = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  402: { type: "billing_error", code: "payment_required" },
  403: { type: "permission_error", code: "insufficient_quota" },
  404: { type: "invalid_request_error", code: "model_not_found" },
  406: { type: "invalid_request_error", code: "model_not_supported" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  500: { type: "server_error", code: "internal_server_error" },
  502: { type: "server_error", code: "bad_gateway" },
  503: { type: "server_error", code: "service_unavailable" },
  504: { type: "server_error", code: "gateway_timeout" }
};

// Default error messages per status code (client-facing)
export const DEFAULT_ERROR_MESSAGES = {
  400: "Bad request",
  401: "Invalid API key provided",
  402: "Payment required",
  403: "You exceeded your current quota",
  404: "Model not found",
  406: "Model not supported",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway - upstream provider error",
  503: "Service temporarily unavailable",
  504: "Gateway timeout"
};

// Exponential backoff config for rate limits
export const BACKOFF_CONFIG = {
  base: 2000,
  max: 5 * 60 * 1000,
  maxLevel: 15
};

// Default cooldown for transient/unknown errors
export const TRANSIENT_COOLDOWN_MS = 30 * 1000;

// Hard cap for provider-reported rate limit cooldown (e.g. codex resets_at can be 5-6h)
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

// Cooldown durations (ms)
const COOLDOWN = {
  long: 2 * 60 * 1000,
  short: 5 * 1000,
};

/**
 * Unified error classification rules.
 * Checked top-to-bottom: text rules first (by order), then status rules.
 * Each rule: { text?, status?, cooldownMs?, backoff?, shouldFallback?, advanceCombo? }
 *   - text: substring match (case-insensitive) on error message
 *   - status: HTTP status code match
 *   - cooldownMs: fixed cooldown duration
 *   - backoff: true = use exponential backoff (rate limit)
 *   - shouldFallback: false = do NOT try the other accounts of this provider
 *   - advanceCombo: true = still try the NEXT MODEL of the combo
 *
 * shouldFallback and advanceCombo are separate on purpose. They answer two
 * different questions and a single boolean conflates them: "don't fan out across
 * this provider's accounts" is not "don't try the other models of the combo".
 */
export const ERROR_RULES = [
  // --- Text-based rules (checked first, order = priority) ---

  // OpenCode Zen free tier: deterministic product policy, identical for every
  // account (measured: 12/12 accounts, 0 successes). Fanning out burns all 12 in
  // ~3s for nothing, so no account fallback and no cooldown — the credential is
  // healthy. But the combo MUST advance: the next model is a different provider
  // and has no reason to fail.
  { text: "free tier can only be used from within opencode", shouldFallback: false, advanceCombo: true, cooldownMs: 0 },
  { text: "freetiererror",                                   shouldFallback: false, advanceCombo: true, cooldownMs: 0 },

  // Portão de primeiro byte do passthrough Claude: o upstream aceitou a
  // requisição, devolveu headers e fechou sem mandar um token. Isso não diz nada
  // contra a credencial — o default (30 s de TRANSIENT_COOLDOWN_MS) tiraria uma
  // conta saudável da rotação por uma queda de socket. Troca de conta na hora,
  // sem cooldown: a próxima tentativa é o que faz o cliente nunca ver a falha.
  { text: "upstream closed before first token", shouldFallback: true, cooldownMs: 0 },

  { text: "no credentials",           cooldownMs: COOLDOWN.long },
  { text: "request not allowed",      cooldownMs: COOLDOWN.short },
  { text: "improperly formed request", cooldownMs: COOLDOWN.long },
  { text: "rate limit",               backoff: true },
  { text: "too many requests",        backoff: true },
  { text: "quota exceeded",           backoff: true },
  { text: "capacity",                 backoff: true },
  { text: "overloaded",               backoff: true },

  // --- Status-based rules (fallback when text doesn't match) ---
  { status: 401, cooldownMs: COOLDOWN.long },
  { status: 402, cooldownMs: COOLDOWN.long },
  { status: 403, cooldownMs: COOLDOWN.long },
  { status: 404, cooldownMs: COOLDOWN.long },
  { status: 429, backoff: true },
];

// Backward compat: COOLDOWN_MS object (used by index.js re-export)
export const COOLDOWN_MS = {
  unauthorized: COOLDOWN.long,
  paymentRequired: COOLDOWN.long,
  notFound: COOLDOWN.long,
  transient: TRANSIENT_COOLDOWN_MS,
  requestNotAllowed: COOLDOWN.short,
};
