import { describe, expect, it } from "vitest";
import {
  getComboEntryModel,
  getComboEntryReasoning,
  normalizeComboEntry,
  normalizeComboEntries,
} from "open-sse/services/comboEntry.js";
import { parseSuffix } from "open-sse/translator/concerns/thinkingUnified.js";

// The exact rows in production, copied from the combos table. If normalisation
// ever stops producing a dispatchable id for one of these, the gateway serves
// 500s for that combo.
const PRODUCTION_ROWS = {
  "barroso-quick": [
    { model: "gemini/gemini-3.5-flash-lite", reasoning: "none" },
    { model: "cx/gpt-5.6-luna", reasoning: "none" },
  ],
  "barroso-chat": [
    { model: "oc/muse-spark-1.3-contributor-free", reasoning: "xhigh" },
    { model: "gemini/gemini-3.8-flash", reasoning: "high" },
  ],
  "claude-opus-5": ["cc/claude-opus-5", "kr/claude-opus-5"],
};

describe("getComboEntryModel", () => {
  it("passes a string entry through", () => {
    expect(getComboEntryModel("cc/claude-opus-5")).toBe("cc/claude-opus-5");
    expect(getComboEntryModel("  cc/claude-opus-5  ")).toBe("cc/claude-opus-5");
  });

  it("reads the dashboard shape", () => {
    expect(getComboEntryModel({ model: "gemini/gemini-3.8-flash", reasoning: "high" }))
      .toBe("gemini/gemini-3.8-flash");
  });

  // The subtle one. `model` on a CLI entry is the bare id and routes nowhere;
  // `fullModel` uses the raw provider name ("claude/") rather than the alias
  // the router dispatches on ("cc/"). Only routedModel is dispatchable.
  it("prefers routedModel over fullModel and the bare id for the CLI shape", () => {
    const cliEntry = {
      provider: "claude",
      model: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      fullModel: "claude/claude-sonnet-5",
      routedModel: "cc/claude-sonnet-5",
      caps: { vision: true },
    };
    expect(getComboEntryModel(cliEntry)).toBe("cc/claude-sonnet-5");
  });

  it("composes provider + bare id when no routed field is present", () => {
    expect(getComboEntryModel({ provider: "cc", model: "claude-sonnet-5" }))
      .toBe("cc/claude-sonnet-5");
  });

  it("does not compose when the id already carries a provider", () => {
    expect(getComboEntryModel({ provider: "claude", model: "cc/claude-sonnet-5" }))
      .toBe("cc/claude-sonnet-5");
  });

  it("returns empty for an entry that names no model", () => {
    expect(getComboEntryModel({ reasoning: "high" })).toBe("");
    expect(getComboEntryModel(null)).toBe("");
    expect(getComboEntryModel(42)).toBe("");
  });
});

describe("getComboEntryReasoning", () => {
  it("reads the field on an object and the suffix on a string", () => {
    expect(getComboEntryReasoning({ model: "x", reasoning: "xhigh" })).toBe("xhigh");
    expect(getComboEntryReasoning("gemini/gemini-3.8-flash(high)")).toBe("high");
  });

  it("treats an empty or placeholder level as no level", () => {
    expect(getComboEntryReasoning({ model: "x", reasoning: "" })).toBe("");
    expect(getComboEntryReasoning({ model: "x", reasoning: "   " })).toBe("");
    expect(getComboEntryReasoning({ model: "x" })).toBe("");
  });

  it("accepts a numeric budget, which is legal suffix content", () => {
    expect(getComboEntryReasoning({ model: "x", reasoning: "8192" })).toBe("8192");
  });
});

describe("normalizeComboEntry", () => {
  it("produces model(level) that parseSuffix reads back", () => {
    const out = normalizeComboEntry({ model: "gemini/gemini-3.8-flash", reasoning: "high" });
    expect(out).toBe("gemini/gemini-3.8-flash(high)");

    // The round trip is the whole point: the suffix has to mean something.
    const parsed = parseSuffix(out);
    expect(parsed.cleanModel).toBe("gemini/gemini-3.8-flash");
    expect(parsed.override).toEqual({ mode: "level", level: "high" });
  });

  it('carries "none" through as an explicit disable, not as a dropped level', () => {
    const out = normalizeComboEntry({ model: "cx/gpt-5.6-luna", reasoning: "none" });
    expect(out).toBe("cx/gpt-5.6-luna(none)");
    expect(parseSuffix(out).override).toEqual({ mode: "none" });
  });

  it("does not stack suffixes when an entry has both a suffix and a field", () => {
    expect(normalizeComboEntry({ model: "cx/gpt-5.6-luna(low)", reasoning: "high" }))
      .toBe("cx/gpt-5.6-luna(high)");
  });

  it("leaves a plain string untouched, byte for byte", () => {
    expect(normalizeComboEntry("cc/claude-opus-5")).toBe("cc/claude-opus-5");
    expect(normalizeComboEntry("cc/claude-opus-5(max)")).toBe("cc/claude-opus-5(max)");
  });

  it("returns empty for an entry naming no model", () => {
    expect(normalizeComboEntry({ reasoning: "high" })).toBe("");
  });
});

describe("normalizeComboEntries", () => {
  it("preserves array identity when nothing changed", () => {
    const already = PRODUCTION_ROWS["claude-opus-5"];
    // Identity, not just equality: combo-autoswitch compares by reference.
    expect(normalizeComboEntries(already)).toBe(already);
  });

  it("returns a new array when something changed", () => {
    const rows = PRODUCTION_ROWS["barroso-chat"];
    const out = normalizeComboEntries(rows);
    expect(out).not.toBe(rows);
    expect(out).toEqual([
      "oc/muse-spark-1.3-contributor-free(xhigh)",
      "gemini/gemini-3.8-flash(high)",
    ]);
  });

  it("drops an entry that names no model instead of dispatching an empty id", () => {
    expect(normalizeComboEntries(["cc/claude-opus-5", { reasoning: "high" }]))
      .toEqual(["cc/claude-opus-5"]);
  });

  it("is idempotent — normalising twice changes nothing and reuses the array", () => {
    const once = normalizeComboEntries(PRODUCTION_ROWS["barroso-chat"]);
    expect(normalizeComboEntries(once)).toBe(once);
  });

  it("leaves a non-array alone rather than inventing one", () => {
    expect(normalizeComboEntries(null)).toBe(null);
    expect(normalizeComboEntries(undefined)).toBe(undefined);
  });

  it("every production row normalises to dispatchable strings", () => {
    for (const [name, rows] of Object.entries(PRODUCTION_ROWS)) {
      for (const model of normalizeComboEntries(rows)) {
        expect(typeof model, `${name} entry`).toBe("string");
        // `model.includes("/")` is the router call that threw on objects.
        expect(model.includes("/"), `${name}: ${model}`).toBe(true);
      }
    }
  });
});
