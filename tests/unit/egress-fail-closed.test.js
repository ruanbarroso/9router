import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertDirectEgressAllowed,
  isPrivateEgressTarget,
  isProxyRequired,
  isUpstreamHeadersTimeout,
} from "../../open-sse/utils/egressPolicy.js";

describe("isProxyRequired", () => {
  it.each(["1", "true", "TRUE", "yes", "on"])("accepts %s as enabled", (v) => {
    expect(isProxyRequired({ NINEROUTER_REQUIRE_PROXY: v })).toBe(true);
  });

  it.each(["0", "false", "", "no", undefined])("treats %s as disabled", (v) => {
    expect(isProxyRequired({ NINEROUTER_REQUIRE_PROXY: v })).toBe(false);
  });

  it("still honours the deprecated KROUTER_ name", () => {
    // The production systemd unit sets this. Dropping it in the same release as
    // the rename would silently disarm the policy on the one host that needs it.
    expect(isProxyRequired({ KROUTER_REQUIRE_PROXY: "1" })).toBe(true);
  });

  it("is disabled when neither name is set", () => {
    expect(isProxyRequired({})).toBe(false);
  });
});

describe("isPrivateEgressTarget", () => {
  const PRIVATE = [
    "http://127.0.0.1:20128/v1",
    "http://localhost:20128/",
    "https://app.localhost/",
    "http://10.1.2.3/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data",  // cloud metadata
    "http://100.64.0.5:18080/",                 // CGNAT: where the relays live
    "http://100.127.255.255/",
    "http://[::1]:8080/",
    "http://[fc00::1]/",
    "http://[fd12:3456::1]/",
    "http://[fe80::1]/",
  ];
  it.each(PRIVATE)("treats %s as inside the perimeter", (u) => {
    expect(isPrivateEgressTarget(u)).toBe(true);
  });

  const PUBLIC = [
    "https://api.anthropic.com/v1/messages",
    "https://chatgpt.com/backend-api/codex/responses",
    "http://8.8.8.8/",
    "http://172.32.0.1/",      // just outside 172.16/12
    "http://100.128.0.1/",     // just outside 100.64/10
    "http://100.63.255.255/",  // just below 100.64/10
    "http://11.0.0.1/",
    "http://126.255.255.255/", // just below 127/8
    "http://[2001:4860::1]/",  // public IPv6
  ];
  it.each(PUBLIC)("treats %s as outside the perimeter", (u) => {
    expect(isPrivateEgressTarget(u)).toBe(false);
  });

  it("does not mistake a hostname that merely looks numeric-ish", () => {
    expect(isPrivateEgressTarget("https://10.0.0.1.evil.com/")).toBe(false);
  });

  it("rejects malformed input instead of throwing", () => {
    expect(isPrivateEgressTarget("not a url")).toBe(false);
    expect(isPrivateEgressTarget(undefined)).toBe(false);
  });

  it("does not resolve hostnames — a private-looking name is still public", () => {
    // Deliberate: a DNS lookup on this path would cost latency on every request
    // and is exactly what a closed firewall may block.
    expect(isPrivateEgressTarget("https://localhost.attacker.net/")).toBe(false);
  });
});

describe("assertDirectEgressAllowed", () => {
  const ON = { NINEROUTER_REQUIRE_PROXY: "1" };

  it("is a no-op when the policy is off", () => {
    expect(() => assertDirectEgressAllowed("https://api.anthropic.com/", "test", {})).not.toThrow();
  });

  it("blocks public targets when the policy is on", () => {
    expect(() => assertDirectEgressAllowed("https://api.anthropic.com/", "test", ON))
      .toThrow(/Direct connection refused/);
  });

  it("names the exit that escaped, so the log points at a code path", () => {
    expect(() => assertDirectEgressAllowed("https://api.anthropic.com/", "vercel-relay", ON))
      .toThrow(/vercel-relay/);
  });

  it("tags the error with a code callers can branch on", () => {
    try {
      assertDirectEgressAllowed("https://api.anthropic.com/", "test", ON);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e.code).toBe("EGRESS_DIRECT_BLOCKED");
    }
  });

  it("never puts the path or query in the message", () => {
    // Tokens ride in query strings; this error goes to logs.
    try {
      assertDirectEgressAllowed("https://api.example.com/v1/x?access_token=SECRET", "test", ON);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e.message).not.toContain("SECRET");
      expect(e.message).not.toContain("access_token");
      expect(e.message).toContain("https://api.example.com");
    }
  });

  it("allows the relay range even under the policy", () => {
    expect(() => assertDirectEgressAllowed("http://100.64.0.5:18080/", "vercel-relay", ON)).not.toThrow();
  });
});

describe("isUpstreamHeadersTimeout", () => {
  it("recognises undici's code", () => {
    expect(isUpstreamHeadersTimeout({ code: "UND_ERR_HEADERS_TIMEOUT" })).toBe(true);
  });

  it("recognises it through a cause chain", () => {
    expect(isUpstreamHeadersTimeout(new TypeError("fetch failed", {
      cause: { code: "UND_ERR_HEADERS_TIMEOUT" },
    }))).toBe(true);
  });

  it("recognises it by message", () => {
    expect(isUpstreamHeadersTimeout(new Error("Headers Timeout Error"))).toBe(true);
  });

  it("does not claim an ordinary connection failure", () => {
    expect(isUpstreamHeadersTimeout(new Error("ECONNREFUSED"))).toBe(false);
    expect(isUpstreamHeadersTimeout({ code: "ECONNRESET" })).toBe(false);
    expect(isUpstreamHeadersTimeout(null)).toBe(false);
  });

  it("terminates on a self-referential cause chain", () => {
    const e = new Error("loop");
    e.cause = e;
    expect(isUpstreamHeadersTimeout(e)).toBe(false);
  });
});

// ─── proxyAwareFetch wiring ────────────────────────────────────────────────
// Imported after the pure tests so the global-fetch patch lands late.

describe("proxyAwareFetch — the four direct-egress exits", () => {
  let proxyAwareFetch;
  let realFetch;

  beforeEach(async () => {
    realFetch = globalThis.fetch;
    ({ proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js"));
    process.env.NINEROUTER_REQUIRE_PROXY = "1";
  });

  afterEach(() => {
    delete process.env.NINEROUTER_REQUIRE_PROXY;
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("exit 1: blocks a relay that is not in the trusted range", async () => {
    await expect(proxyAwareFetch("https://api.anthropic.com/v1/messages", {}, {
      vercelRelayUrl: "https://my-relay.vercel.app/api",
    })).rejects.toThrow(/vercel-relay/);
  });

  it("exit 4: blocks a request with no proxy configured at all", async () => {
    await expect(proxyAwareFetch("https://api.anthropic.com/v1/messages", {}, null))
      .rejects.toThrow(/no-proxy-configured/);
  });

  // The two below let the request reach the real network stack, so they must
  // pick targets that fail FAST: an unroutable public IP would hang until the
  // 5s vitest timeout and read as an unrelated flake. A closed loopback port
  // gives ECONNREFUSED, and `.invalid` is a reserved never-resolvable TLD.
  // Neither assertion is about the network — only about which error comes back.

  it("allows loopback through, so local calls keep working", async () => {
    const err = await proxyAwareFetch("http://127.0.0.1:1/health", {}, null).catch((e) => e);
    expect(err?.code).not.toBe("EGRESS_DIRECT_BLOCKED");
  });

  it("does nothing when the policy is off", async () => {
    delete process.env.NINEROUTER_REQUIRE_PROXY;
    const err = await proxyAwareFetch("https://blocked.invalid/", {}, null).catch((e) => e);
    expect(err?.code).not.toBe("EGRESS_DIRECT_BLOCKED");
  });

  it("blocks that same public target once the policy is back on", async () => {
    // Pairs with the test above: same URL, opposite env, opposite outcome —
    // otherwise "not blocked" could just mean the guard never ran at all.
    const err = await proxyAwareFetch("https://blocked.invalid/", {}, null).catch((e) => e);
    expect(err?.code).toBe("EGRESS_DIRECT_BLOCKED");
  });

  it("rejects a SOCKS proxy url at the edge with a clear message", async () => {
    await expect(proxyAwareFetch("https://api.anthropic.com/", {}, {
      connectionProxyEnabled: true,
      connectionProxyUrl: "socks5://proxy.local:1080",
    })).rejects.toThrow(/SOCKS proxies are not supported/);
  });

  it("does not echo proxy credentials when rejecting SOCKS", async () => {
    const err = await proxyAwareFetch("https://api.anthropic.com/", {}, {
      connectionProxyEnabled: true,
      connectionProxyUrl: "socks5://user:hunter2@proxy.local:1080",
    }).catch((e) => e);
    expect(err.message).not.toContain("hunter2");
  });
});
