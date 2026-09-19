/**
 * Build the proxyOptions bag that `proxyAwareFetch` consumes, from a config
 * resolved by `resolveConnectionProxyConfig` (or any object with the same keys).
 *
 * This is the write side of the contract `connectionProxy.js` reads; the two are
 * siblings on purpose. It lives in its own leaf module — with no imports at all —
 * for two reasons:
 *   1. Callers on OAuth/catalog paths must not drag the DB layer in just to shape
 *      an options object.
 *   2. Four tests replace `@/lib/network/connectionProxy` with an exhaustive
 *      `vi.mock` factory. Exporting from there would make this function
 *      `undefined` in those suites the moment a call site imported it.
 *
 * `strictProxy` defaults to the pool's own setting. Pass it explicitly only where
 * falling back to direct egress is a deliberate decision, so that intent stays
 * visible at the call site instead of being lost in a copied literal.
 */
export function toProxyOptions(cfg, overrides = {}) {
  const src = cfg || {};
  return {
    connectionProxyEnabled: src.connectionProxyEnabled === true,
    connectionProxyUrl: src.connectionProxyUrl || "",
    connectionNoProxy: src.connectionNoProxy || "",
    vercelRelayUrl: src.vercelRelayUrl || "",
    // `undefined` counts as "not overridden", not as "false". A caller passing a
    // variable that happens to be undefined inherits the pool's strict setting
    // rather than silently unlocking direct egress — the whole point of the bag.
    strictProxy: overrides.strictProxy === undefined
      ? src.strictProxy === true
      : overrides.strictProxy === true,
  };
}
