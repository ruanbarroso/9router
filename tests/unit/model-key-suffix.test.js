import { describe, expect, it } from "vitest";
import { stripThinkingSuffix, getThinkingSuffix } from "open-sse/providers/modelKey.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { getPricingForModel } from "open-sse/providers/pricing.js";

describe("stripThinkingSuffix", () => {
  it("removes a trailing (level)", () => {
    expect(stripThinkingSuffix("gpt-5.6-terra(high)")).toBe("gpt-5.6-terra");
    expect(stripThinkingSuffix("gemini/gemini-3.8-flash(xhigh)")).toBe("gemini/gemini-3.8-flash");
  });

  it("leaves an unsuffixed id alone", () => {
    expect(stripThinkingSuffix("gpt-5.6-terra")).toBe("gpt-5.6-terra");
    expect(stripThinkingSuffix("")).toBe("");
  });

  it("only strips at the end, and only the outermost pair", () => {
    // A parenthesis in the middle is part of the name, whatever else it is.
    expect(stripThinkingSuffix("weird(name)model")).toBe("weird(name)model");
  });

  it("survives whitespace around the suffix", () => {
    expect(stripThinkingSuffix("gpt-5.6-terra (high) ")).toBe("gpt-5.6-terra");
    // Reading the level by slicing the match would return "high) " here.
    expect(getThinkingSuffix("gpt-5.6-terra(high) ")).toBe("high");
  });

  it("returns non-strings untouched rather than coercing", () => {
    expect(stripThinkingSuffix(null)).toBe(null);
    expect(stripThinkingSuffix(undefined)).toBe(undefined);
    expect(getThinkingSuffix(null)).toBe("");
  });
});

// The anchors from the plan. These are the two lookups measured to be wrong
// before the fix; if either number moves, the table changed and someone should
// look at why rather than update the expectation.
describe("a thinking suffix must not change what the tables answer", () => {
  it("capabilities: gpt-5.6-terra keeps its 272000 window", () => {
    const plain = getCapabilitiesForModel("codex", "gpt-5.6-terra");
    expect(plain.contextWindow).toBe(272000);
    expect(getCapabilitiesForModel("codex", "gpt-5.6-terra(high)").contextWindow).toBe(272000);
  });

  it("pricing: gemini-3.8-flash keeps input 1.5 / output 7.5", () => {
    const plain = getPricingForModel("gemini", "gemini-3.8-flash");
    expect(plain.input).toBe(1.5);
    expect(plain.output).toBe(7.5);

    // The bug this file exists for: a 3× undercount on the largest fleet.
    for (const level of ["none", "low", "medium", "high", "xhigh"]) {
      expect(getPricingForModel("gemini", `gemini-3.8-flash(${level})`)).toEqual(plain);
    }
  });

  it("agrees with the unsuffixed answer across the models production actually routes", () => {
    const models = [
      ["gemini", "gemini-3.8-flash"],
      ["gemini", "gemini-3.6-flash"],
      ["gemini", "gemini-3.5-flash-lite"],
      ["cx", "gpt-5.6-luna"],
      ["cx", "gpt-5.6-terra"],
      ["cc", "claude-sonnet-5"],
      ["cc", "claude-opus-4-8"],
      ["cc", "claude-haiku-4-5"],
      ["oc", "muse-spark-1.3-contributor-free"],
    ];
    for (const [provider, model] of models) {
      expect(getCapabilitiesForModel(provider, `${model}(high)`))
        .toEqual(getCapabilitiesForModel(provider, model));
      expect(getPricingForModel(provider, `${model}(high)`))
        .toEqual(getPricingForModel(provider, model));
    }
  });
});
