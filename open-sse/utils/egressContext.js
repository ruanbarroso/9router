/**
 * Ambient egress context.
 *
 * Some call trees have to reach the network through a specific proxy pool but
 * cannot be given the pool as an argument. Token refresh is the clearest case:
 * `refreshXaiToken` hands off to `XaiService`, which owns its own subtree of
 * bare `fetch()` calls, so no amount of parameter threading through
 * `tokenRefresh/providers.js` would ever reach them. The OAuth connect tree is
 * the same shape, 42 call sites wide.
 *
 * So the pool travels out-of-band: `runWithProxy` puts it in an
 * AsyncLocalStorage store, and the patched global fetch reads it back. Every
 * `fetch()` in that async chain is routed with no edit at the call site.
 *
 * The cost is that it is ambient — it applies to the WHOLE async chain,
 * including anything incidental that happens to run inside. Wrap the narrowest
 * body that does the network work, never a module body or a middleware, or an
 * unrelated request that merely shares the chain inherits the pool.
 *
 * Leaf module: node:async_hooks only, so any layer can import it.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const egressStorage = new AsyncLocalStorage();

/** The options bag for the current async chain, or null outside any store. */
export function getAmbientProxyOptions() {
  return egressStorage.getStore() ?? null;
}

/**
 * Run `fn` with `proxyOptions` as the ambient pool for its whole async chain.
 *
 * A null/undefined bag does NOT open an empty store: it runs `fn` inline so an
 * inner call inherits whatever outer store it is already in. Shadowing a real
 * pool with a blank one would quietly downgrade a nested call to direct egress,
 * which is the failure this module exists to prevent.
 */
export function runWithProxy(proxyOptions, fn) {
  if (!proxyOptions) return fn();
  return egressStorage.run(proxyOptions, fn);
}

/**
 * Run `fn` with NO ambient pool, even inside an outer store.
 * For the rare call that must not inherit — e.g. talking to a loopback service.
 */
export function runWithoutProxy(fn) {
  return egressStorage.run(undefined, fn);
}
