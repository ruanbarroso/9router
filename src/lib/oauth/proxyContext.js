/**
 * OAuth-facing names for the ambient egress context.
 *
 * The store itself lives in `open-sse/utils/egressContext.js` and is shared
 * with token refresh — that is deliberate. A connect flow and a later refresh
 * of the same account must not sit in two different AsyncLocalStorage
 * instances, or a refresh nested inside a connect would silently fall back to
 * direct egress.
 *
 * One semantic difference from the krouter original worth knowing, because the
 * mapping is otherwise 1:1: there, `runWithOAuthProxy(null, fn)` opened an
 * EMPTY store, clobbering any pool an outer caller had established (its own
 * comment said the opposite). Here a null bag runs `fn` inline and inherits the
 * outer store, so a provider helper called from inside another flow keeps the
 * egress it was given.
 */

import {
  getAmbientProxyOptions,
  runWithProxy,
} from "open-sse/utils/egressContext.js";

export const getOAuthProxyOptions = getAmbientProxyOptions;
export const runWithOAuthProxy = runWithProxy;
