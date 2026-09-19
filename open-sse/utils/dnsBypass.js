/**
 * DNS for the MITM bypass path.
 *
 * A handful of hosts (Kiro's CodeWhisperer endpoints, Copilot, Cursor, the
 * Gemini cloudcode endpoints) are commonly intercepted by a local MITM that
 * answers their names with 127.0.0.1. The bypass exists to get the real
 * address and open a socket straight to it — so it must not ask the resolver
 * that is doing the lying.
 *
 * Two things this module fixes about hardcoding 8.8.8.8:
 *
 * 1. **It is unreachable on a fail-closed host.** Where the firewall permits
 *    outbound traffic only through the relay, `8.8.8.8:53` is REJECT and every
 *    Kiro request becomes an opaque `fetch failed` — with nothing naming DNS
 *    as the step that failed. `NINEROUTER_DNS_SERVERS` points it at a resolver
 *    that is actually reachable, and the system resolver is tried last rather
 *    than not at all.
 *
 * 2. **A loopback answer must be refused, not cached.** This is the subtle
 *    one. A stub resolver (systemd-resolved, dnsmasq) synthesises `/etc/hosts`,
 *    so if it is in the list it will hand back exactly the 127.0.0.1 the
 *    bypass exists to route around — and the bypass would then dial the MITM
 *    on purpose, through a raw socket that no proxy setting can redirect.
 *    Refuse it and move to the next server.
 *
 * Leaf module: it imports only `node:dns`, so any layer can use it.
 */

// The production systemd unit predates the rename; honoured for one release so
// the unit file and this can land separately.
const ENV_KEYS = ["NINEROUTER_DNS_SERVERS", "KROUTER_DNS_SERVERS"];

// Last resort, not first choice: on a normal host it is the right answer, and
// on a fail-closed one it is the only resolver that is reachable at all.
export const SYSTEM_RESOLVER = "system";

const DEFAULT_DNS_SERVERS = ["8.8.8.8", "8.8.4.4", SYSTEM_RESOLVER];

const DNS_CACHE = new Map(); // Map, not object: hostnames are attacker-shaped.

/**
 * The ordered list of resolvers to try. `system` anywhere in the list means
 * "fall back to the process resolver at this point"; it is appended when the
 * operator's list omits it, because a list that only names unreachable servers
 * is a worse failure than one extra attempt.
 */
export function getDnsServers(env = process.env) {
  for (const key of ENV_KEYS) {
    const raw = String(env?.[key] ?? "").trim();
    if (!raw) continue;
    const servers = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (!servers.length) continue;
    if (!servers.includes(SYSTEM_RESOLVER)) servers.push(SYSTEM_RESOLVER);
    return servers;
  }
  return DEFAULT_DNS_SERVERS;
}

/** A loopback answer is the MITM returning through the bypass that avoids it. */
export function isLoopbackAddress(ip) {
  const value = String(ip ?? "").trim();
  if (!value) return true; // nothing usable is as bad as a spoof
  return value === "::1" || value.startsWith("127.");
}

/**
 * Resolve `hostname` to a real A record, trying each configured server in turn.
 *
 * Returns null when every attempt fails — the caller falls back to ordinary
 * proxied fetch, which is the correct outcome and better than throwing out of
 * a bypass that is itself a workaround.
 */
export async function resolveRealIP(hostname, options = {}) {
  const { env = process.env, ttlMs = 300_000, now = Date.now(), log = console } = options;

  const cached = DNS_CACHE.get(hostname);
  if (cached && now < cached.expiry) return cached.ip;

  const dns = options.dns || (await import("node:dns"));
  const servers = getDnsServers(env);
  const failures = [];

  for (const server of servers) {
    try {
      const resolver = server === SYSTEM_RESOLVER
        ? dns.promises
        : (() => {
            const r = new dns.promises.Resolver();
            r.setServers([server]);
            return r;
          })();

      const addresses = await resolver.resolve4(hostname);
      const ip = Array.isArray(addresses) ? addresses.find((a) => !isLoopbackAddress(a)) : null;
      if (!ip) {
        // Not an error the resolver would report: it answered, and the answer
        // is the spoof. Say so by name, or the next reader reads a clean
        // lookup followed by an inexplicable connection to localhost.
        failures.push(`${server}: loopback answer refused`);
        continue;
      }
      DNS_CACHE.set(hostname, { ip, expiry: now + ttlMs });
      return ip;
    } catch (error) {
      failures.push(`${server}: ${error?.message || error}`);
    }
  }

  log?.warn?.(
    `[ProxyFetch] DNS resolve failed for ${hostname} (${failures.join("; ")})`
  );
  return null;
}

/** Drop the cache. For tests, and for after a network change. */
export function clearDnsCache() {
  DNS_CACHE.clear();
}
