/**
 * Combo entries, in every shape they arrive in.
 *
 * A combo's `models` column is a JSON array. It was written as `string[]`, and
 * most of it still is — but the dashboard and the CLI both write objects, and
 * production rows hold both shapes side by side:
 *
 *   ["cc/claude-opus-5", "kr/claude-opus-5"]                        // string
 *   [{"model":"gemini/gemini-3.8-flash","reasoning":"high"}, ...]   // dashboard
 *   [{"provider":"claude","model":"claude-sonnet-5",                // CLI
 *     "fullModel":"claude/claude-sonnet-5",
 *     "routedModel":"cc/claude-sonnet-5", "caps":{...}}]
 *
 * Everything downstream expects a string: the router does `model.includes("/")`,
 * which is where an object entry becomes `a.includes is not a function` and the
 * combo dies with `Model [object Object] threw error`.
 *
 * So normalise at the edge, into the one representation the whole tree already
 * understands — `"model(level)"`. The suffix is not a workaround: `parseSuffix`
 * in translator/concerns/thinkingUnified.js reads it as thinking intent, and
 * `getModelUpstreamId` preserves it across catalogue lookups. Turning
 * `{model, reasoning}` into that string means roughly forty call sites that
 * handle combo models keep receiving strings and need no change at all.
 *
 * Two deliberate differences from the krouter implementation this replaces:
 *   • the output is a **string**, not an object, so there is no parallel
 *     thinking pipeline to keep in step with capabilities.js and the clamp;
 *   • `normalizeComboEntries` returns **the same array instance** when nothing
 *     changed, which is both the fast path for already-string combos and what
 *     `combo-autoswitch.test.js` compares by identity.
 */

import { getThinkingSuffix, stripThinkingSuffix } from "../providers/modelKey.js";

// Levels the dashboard writes. Not a validator — `parseSuffix` decides what a
// level means, and an unrecognised one falls through to the client's intent
// rather than erroring. This exists so an empty or placeholder value does not
// become a meaningless `model()`.
export const COMBO_REASONING_LEVELS = [
  "none", "off", "auto", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
];

const isMeaningfulLevel = (value) => {
  const level = String(value ?? "").trim().toLowerCase();
  if (!level) return false;
  // A numeric budget is legal suffix content too ("model(8192)").
  return COMBO_REASONING_LEVELS.includes(level) || /^\d+$/.test(level);
};

/**
 * The routable model id an entry names, or "" when it names none.
 *
 * Field order matters and is not obvious. The CLI's `model` is the **bare** id
 * (`claude-sonnet-5`) — not routable on its own — while `routedModel` already
 * carries the provider *alias* the router expects (`cc/`). `fullModel` uses the
 * raw provider name (`claude/`), which routes nowhere. Preferring `model` or
 * `fullModel` here would store an id that cannot be dispatched, so `routedModel`
 * wins whenever it is present.
 */
export function getComboEntryModel(entry) {
  if (typeof entry === "string") return entry.trim();
  if (!entry || typeof entry !== "object") return "";

  const candidate = [entry.routedModel, entry.fullModel, entry.model, entry.id, entry.name]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .find(Boolean);
  if (!candidate) return "";

  // A bare id plus a provider field is still routable; compose it. Anything
  // that already carries a "/" is taken as written.
  if (!candidate.includes("/")) {
    const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
    if (provider) return `${provider}/${candidate}`;
  }
  return candidate;
}

/**
 * The reasoning level an entry asks for, or "" when it asks for none. A string
 * entry carries it in its suffix; an object entry in a field.
 */
export function getComboEntryReasoning(entry) {
  if (typeof entry === "string") return getThinkingSuffix(entry);
  if (!entry || typeof entry !== "object") return "";
  for (const value of [entry.reasoning, entry.thinking, entry.reasoningEffort, entry.effort]) {
    if (isMeaningfulLevel(value)) return String(value).trim().toLowerCase();
  }
  return "";
}

/**
 * One entry, in any shape, as `"model"` or `"model(level)"`.
 * Returns "" for an entry that names no model — callers drop those rather than
 * dispatching an empty id.
 */
export function normalizeComboEntry(entry) {
  const model = getComboEntryModel(entry);
  if (!model) return "";

  const level = getComboEntryReasoning(entry);
  if (!level) return model;

  // An entry that carries both a suffix and a field would otherwise become
  // `model(high)(low)`. The explicit field wins; the suffix is what it was
  // normalised from last time.
  return `${stripThinkingSuffix(model)}(${level})`;
}

/**
 * A whole `models` array, normalised.
 *
 * Returns the *same array instance* when every entry was already the string it
 * would normalise to — the common case for the combos that were written as
 * strings, and the identity `combo-autoswitch.test.js` relies on.
 */
export function normalizeComboEntries(entries) {
  if (!Array.isArray(entries)) return entries;

  let changed = false;
  const out = [];
  for (const entry of entries) {
    const normalized = normalizeComboEntry(entry);
    if (normalized !== entry) changed = true;
    // An entry naming no model is dropped, not dispatched as "".
    if (normalized) out.push(normalized);
  }
  return changed ? out : entries;
}

/**
 * The same normalisation, but reporting what it had to throw away.
 *
 * On read, dropping an entry that names no model is the right thing: the row
 * already exists and half a combo beats a 500. On write it is not — silently
 * storing four of the five models someone submitted is how the destructive
 * round-trips in the dashboard and the CLI happened in the first place. Writers
 * use this and refuse the request instead.
 *
 * @returns {{models: string[], dropped: unknown[]}}
 */
export function normalizeComboEntriesStrict(entries) {
  if (!Array.isArray(entries)) return { models: [], dropped: [] };

  const models = [];
  const dropped = [];
  for (const entry of entries) {
    const normalized = normalizeComboEntry(entry);
    if (normalized) models.push(normalized);
    else dropped.push(entry);
  }
  return { models, dropped };
}
