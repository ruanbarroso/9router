import { describe, expect, it } from "vitest";
import { DefaultExecutor } from "open-sse/executors/default.js";

// The gemini format is the only one that puts the model id in the request path.
// Combo entries normalise to "model(level)", so a suffix that survives to
// buildUrl lands in the URL and Google answers 400
// `GenerateContentRequest.model: unexpected model name`.
const gemini = () =>
  new DefaultExecutor("gemini", {
    format: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/models",
  });

describe("gemini URL never carries a thinking suffix", () => {
  it("strips the suffix from the non-streaming path", () => {
    const url = gemini().buildUrl("gemini-3.5-flash-lite(none)", false);
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent"
    );
    expect(url).not.toContain("(");
  });

  it("strips the suffix from the streaming path, keeping alt=sse", () => {
    const url = gemini().buildUrl("gemini-3.8-flash(high)", true);
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse"
    );
  });

  it("leaves an unsuffixed id byte for byte", () => {
    expect(gemini().buildUrl("gemini-3.8-flash", false)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent"
    );
  });

  it("covers every level the dashboard can write", () => {
    for (const level of ["none", "off", "auto", "low", "medium", "high", "xhigh", "max", "ultra", "8192"]) {
      expect(gemini().buildUrl(`gemini-3.8-flash(${level})`, false)).not.toContain("(");
    }
  });
});
