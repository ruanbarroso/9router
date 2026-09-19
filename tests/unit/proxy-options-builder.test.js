import { describe, expect, it } from "vitest";
import { toProxyOptions } from "../../src/lib/network/proxyOptions.js";

// The five keys proxyAwareFetch reads. Locked here because this bag used to be a
// literal copied into eight call sites, where a missing key was invisible.
const KEYS = [
  "connectionProxyEnabled",
  "connectionProxyUrl",
  "connectionNoProxy",
  "vercelRelayUrl",
  "strictProxy",
];

describe("toProxyOptions", () => {
  it("always emits exactly the five keys proxyAwareFetch consumes", () => {
    expect(Object.keys(toProxyOptions({})).sort()).toEqual([...KEYS].sort());
  });

  it("copies a resolved pool config verbatim, including strictProxy", () => {
    expect(toProxyOptions({
      source: "pool",
      proxyPoolId: "bk-a",
      proxyPool: { id: "bk-a" },
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.local:18080",
      connectionNoProxy: "localhost",
      strictProxy: true,
    })).toEqual({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.local:18080",
      connectionNoProxy: "localhost",
      vercelRelayUrl: "",
      strictProxy: true,
    });
  });

  it("drops resolver-internal keys rather than leaking proxyPool downstream", () => {
    const out = toProxyOptions({ source: "pool", proxyPoolId: "bk-a", proxyPool: { secret: 1 } });
    expect(out).not.toHaveProperty("proxyPool");
    expect(out).not.toHaveProperty("proxyPoolId");
    expect(out).not.toHaveProperty("source");
  });

  it("coerces truthy-but-not-true into false, matching the old literals", () => {
    const out = toProxyOptions({ connectionProxyEnabled: "yes", strictProxy: 1 });
    expect(out.connectionProxyEnabled).toBe(false);
    expect(out.strictProxy).toBe(false);
  });

  it("normalizes null/undefined string fields to empty strings", () => {
    expect(toProxyOptions({ connectionProxyUrl: null, connectionNoProxy: undefined, vercelRelayUrl: null }))
      .toMatchObject({ connectionProxyUrl: "", connectionNoProxy: "", vercelRelayUrl: "" });
  });

  it("survives a missing config instead of throwing", () => {
    expect(toProxyOptions(undefined).strictProxy).toBe(false);
    expect(toProxyOptions(null).connectionProxyEnabled).toBe(false);
  });

  it("lets a call site pin strictProxy off against a strict pool", () => {
    // This is the quota/usage/auto-ping case: degrade to direct, do not fail.
    expect(toProxyOptions({ strictProxy: true }, { strictProxy: false }).strictProxy).toBe(false);
  });

  it("lets a call site pin strictProxy on against a permissive pool", () => {
    expect(toProxyOptions({ strictProxy: false }, { strictProxy: true }).strictProxy).toBe(true);
  });

  it("falls back to the pool when the override object omits strictProxy", () => {
    // An empty bag must not be read as "false" — that is the fail-open bug this
    // whole change exists to close.
    expect(toProxyOptions({ strictProxy: true }, {}).strictProxy).toBe(true);
    expect(toProxyOptions({ strictProxy: true }, { other: 1 }).strictProxy).toBe(true);
  });

  it("treats an explicit undefined override as an omission, not as false", () => {
    // Fail-closed on purpose: a caller whose variable came out undefined keeps
    // the pool's strictProxy instead of quietly re-enabling direct egress.
    expect(toProxyOptions({ strictProxy: true }, { strictProxy: undefined }).strictProxy).toBe(true);
  });
});
