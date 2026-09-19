/**
 * Egress for model-catalog and quota lookups.
 *
 * These are the third egress surface, after chat (`sse/services/auth.js`) and
 * OAuth/refresh: listing a provider's models talks to the same upstream, from
 * the same host, and must leave through the same relay as that connection's
 * traffic. It did not, which on a host that blocks direct outbound traffic
 * turned every catalog refresh into an opaque `fetch failed` while chat kept
 * working — the kind of split that reads as "the provider is down".
 *
 * Unlike OAuth connect, a catalog lookup always has a connection row, so the
 * pool comes from `providerSpecificData` exactly as it does for chat.
 *
 * Nothing here throws. A catalog lookup is a convenience: the dashboard falls
 * back to the static model list, and failing the request because a pool could
 * not be read would be a worse outcome than showing that list.
 */

import { runWithProxy } from "open-sse/utils/egressContext.js";

// Memoised: the DB-touching modules are resolved once per process, not once per
// lookup, and concurrent lookups share one import instead of racing to their
// own module instances. Cleared on failure so a transient error does not
// poison every later lookup.
let _modules = null;
function loadModules() {
  if (!_modules) {
    _modules = Promise.all([
      import("@/lib/network/connectionProxy.js"),
      import("@/lib/network/proxyOptions.js"),
    ]).catch((error) => {
      _modules = null;
      throw error;
    });
  }
  return _modules;
}

/**
 * The proxy bag for this connection's catalog lookups, or null for direct.
 * Never rejects.
 */
export async function resolveCatalogEgress(connection) {
  const psd = connection?.providerSpecificData;
  if (!psd) return null;
  try {
    const [{ resolveConnectionProxyConfig }, { toProxyOptions }] = await loadModules();
    const resolved = await resolveConnectionProxyConfig(psd);
    if (!resolved || resolved.source === "none") return null;
    return toProxyOptions(resolved);
  } catch (error) {
    console.warn(
      `[catalog] proxy resolution failed for connection ${connection?.id ?? "?"}: ${error?.message || error}; catalog lookup will go direct`
    );
    return null;
  }
}

/**
 * Run `fn` with this connection's pool as the ambient egress.
 *
 * The store covers the whole async chain, so this belongs around the body that
 * does the lookup and nothing wider. Here that body is the entire catalog
 * request — including the token refresh it may trigger, which is the same
 * connection and so wants the same relay.
 */
export async function withCatalogEgress(connection, fn) {
  return runWithProxy(await resolveCatalogEgress(connection), fn);
}
