/**
 * The thinking suffix, split off a model id.
 *
 * A routed model id may carry its reasoning level as a trailing `(level)` —
 * `gemini/gemini-3.8-flash(high)`. `config/providerModels.js` already treats
 * this as contract: `getModelUpstreamId` strips the suffix to look the model
 * up and re-appends it so `applyThinking` downstream still sees it.
 *
 * The capability and pricing tables never learned that. Both start with an
 * exact-key lookup, so a suffixed id misses the entry written for the model
 * and falls through to a glob that matches a *different* model:
 *
 *   getCapabilitiesForModel("codex", "gpt-5.6-terra")        → contextWindow 272000
 *   getCapabilitiesForModel("codex", "gpt-5.6-terra(high)")  → contextWindow 400000
 *   getPricingForModel("gemini", "gemini-3.8-flash")         → input 1.5 / output 7.5
 *   getPricingForModel("gemini", "gemini-3.8-flash(high)")   → input 0.5 / output 3
 *
 * The pricing case is a 3× undercount, on the largest fleet here. It is a
 * pre-existing bug rather than a new one, but it is currently rare: it needs a
 * suffixed id to reach those functions. Normalising object combo entries into
 * `model(level)` strings makes that the common case, so this has to land with
 * it, not after.
 *
 * Leaf module on purpose: no imports at all. `capabilities.js` and
 * `pricing.js` are imported by nearly everything, including `providerModels.js`
 * itself — anything with an edge would risk a cycle.
 */

// The same pattern `getModelUpstreamId` uses, deliberately: two readings of the
// same id must not disagree about where the model name ends.
// The capture holds the level without its parentheses. The match itself may
// carry trailing whitespace (`\s*$`), so reading the level by slicing the match
// would hand back `"high) "` for `"model(high) "` — capture, don't slice.
const THINKING_SUFFIX = /\(([^()]+)\)\s*$/;

/**
 * `"gpt-5.6-terra(high)"` → `"gpt-5.6-terra"`. Ids without a suffix, and
 * non-strings, come back untouched.
 */
export function stripThinkingSuffix(model) {
  if (typeof model !== "string") return model;
  const match = model.match(THINKING_SUFFIX);
  if (!match) return model;
  return model.slice(0, match.index).trim();
}

/**
 * The level inside the suffix, or `""` when there is none.
 * `"gpt-5.6-terra(high)"` → `"high"`.
 */
export function getThinkingSuffix(model) {
  if (typeof model !== "string") return "";
  const match = model.match(THINKING_SUFFIX);
  return match ? match[1].trim() : "";
}
