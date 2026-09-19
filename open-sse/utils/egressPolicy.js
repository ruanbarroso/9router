/**
 * Fail-closed egress policy.
 *
 * When the host firewall only permits outbound traffic through a proxy, any code
 * path that reaches the internet directly does not leak — it hangs or dies with
 * an opaque `fetch failed`. That is worse than a leak to debug, because the
 * error names neither the path that escaped nor the rule that stopped it.
 *
 * With NINEROUTER_REQUIRE_PROXY enabled, every direct-egress exit announces
 * itself by name instead. This is a diagnostic guard, not a security boundary:
 * the firewall is the boundary. Keep it cheap and keep it honest.
 *
 * Leaf module by design — no imports, so it can be used from any layer.
 */

// Legacy alias: the production systemd unit still sets KROUTER_REQUIRE_PROXY.
// Honoured for one release so the unit file and this rename can land separately.
const ENV_KEYS = ["NINEROUTER_REQUIRE_PROXY", "KROUTER_REQUIRE_PROXY"];

/** Read on every call: tests toggle it, and it is read far off the hot path. */
export function isProxyRequired(env = process.env) {
  for (const key of ENV_KEYS) {
    const raw = String(env?.[key] ?? "").trim().toLowerCase();
    if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  }
  return false;
}

function ipv4ToInt(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

// CIDRs that the firewall either permits or that never leave the box.
// 100.64.0.0/10 is carrier-grade NAT — where this deployment's relay proxies
// live, and the one range the firewall opens. 169.254.0.0/16 is link-local,
// which includes cloud metadata endpoints.
const V4_RANGES = [
  ["127.0.0.0", 8],
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["169.254.0.0", 16],
  ["100.64.0.0", 10],
];

// Both sides of the comparison must be unsigned. JS bitwise operands are
// coerced to int32, so `ipv4ToInt("172.16.0.0") & mask` comes back NEGATIVE for
// any base at or above 128.0.0.0 while the lookup below applies `>>> 0`. That
// mismatch silently exempted 172.16/12, 192.168/16 and 169.254/16 — the three
// ranges failed open while 10/8 and 127/8, which fit in 31 bits, looked fine.
const V4_MASKS = V4_RANGES.map(([base, bits]) => {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return [(ipv4ToInt(base) & mask) >>> 0, mask];
});

/**
 * True when the target is a literal address that stays inside the trusted
 * perimeter. Hostnames are deliberately NOT resolved: a DNS lookup here would
 * add latency to every request and, under a closed firewall, is exactly the
 * thing that may not work.
 */
export function isPrivateEgressTarget(urlString) {
  let host;
  try {
    host = new URL(String(urlString)).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;

  if (host === "localhost" || host.endsWith(".localhost")) return true;

  // URL() keeps IPv6 literals in brackets.
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);

  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  // fc00::/7 (unique local) and fe80::/10 (link local).
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;

  const asInt = ipv4ToInt(host);
  if (asInt === null) return false;
  return V4_MASKS.some(([net, mask]) => (asInt & mask) >>> 0 === net);
}

export class DirectEgressBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "DirectEgressBlockedError";
    this.code = "EGRESS_DIRECT_BLOCKED";
  }
}

function describeTarget(urlString) {
  try {
    const u = new URL(String(urlString));
    return `${u.protocol}//${u.host}`; // never the path — tokens ride in query strings
  } catch {
    return "<unparseable url>";
  }
}

/**
 * Throw if this direct-egress exit is not permitted.
 * `via` names the exit, so the error says which path escaped.
 */
export function assertDirectEgressAllowed(targetUrl, via, env = process.env) {
  if (!isProxyRequired(env)) return;
  if (isPrivateEgressTarget(targetUrl)) return;
  throw new DirectEgressBlockedError(
    `[Egress] Direct connection refused by NINEROUTER_REQUIRE_PROXY: ${via} → ${describeTarget(targetUrl)}. ` +
    `This path bypassed the proxy pool; route it through proxyOptions or add the host to noProxy.`
  );
}

/**
 * Distinguish "the upstream is slow" from "the proxy is broken".
 *
 * Without this, a model that takes a while to emit its first token is reported
 * as a proxy failure, which sends whoever reads the log to the wrong system.
 * undici surfaces this as UND_ERR_HEADERS_TIMEOUT, sometimes only on `.cause`.
 */
export function isUpstreamHeadersTimeout(error) {
  for (let e = error, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (e.code === "UND_ERR_HEADERS_TIMEOUT") return true;
    if (typeof e.message === "string" && e.message.includes("Headers Timeout Error")) return true;
  }
  return false;
}
