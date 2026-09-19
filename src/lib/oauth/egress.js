/**
 * Egress for OAuth *connect* flows.
 *
 * A connect has no connection row yet, so there is no `providerSpecificData`
 * to read a pool from — that is what makes this different from token refresh
 * (`open-sse/services/tokenRefresh.js`, which resolves per credential). The
 * pool comes from the per-provider strategy instead:
 * `settings.providerStrategies[<provider>].proxyPoolId`.
 *
 * Imports are dynamic because both `@/lib/db` and `@/lib/network/connectionProxy`
 * reach the database, and a static edge would drag the DB layer into OAuth code
 * that also runs with no database open (the CLI).
 *
 * Nothing here throws. A host that blocks direct egress will fail at the
 * request itself, where `describeOAuthEgressFailure` can say which path was
 * taken — that is a far better failure than bricking every connect because a
 * settings read hiccupped.
 */

import { runWithOAuthProxy } from "./proxyContext.js";

/**
 * Memoised so the three modules are resolved once per process rather than once
 * per connect. Two concurrent resolutions each doing their own dynamic import
 * can end up on different module instances — seen here as one flow reading the
 * settings it was given and the other reading a second, freshly opened copy of
 * the database. Cleared on failure so a transient error does not poison every
 * later connect.
 */
let _modules = null;
function loadModules() {
  if (!_modules) {
    _modules = Promise.all([
      import("@/lib/db/index.js"),
      import("@/lib/network/connectionProxy.js"),
      import("@/lib/network/proxyOptions.js"),
    ]).catch((error) => {
      _modules = null;
      throw error;
    });
  }
  return _modules;
}

const DIRECT = (mode, poolId = "", detail = "") => ({
  proxyOptions: null,
  poolId,
  mode,
  detail,
});

/**
 * Resolve the egress decision for `providerName`, with enough context attached
 * to explain a later network failure. Always resolves; never rejects.
 */
export async function resolveOAuthEgress(providerName) {
  if (!providerName) return DIRECT("unconfigured");
  let poolId = "";
  try {
    const [{ getSettings }, { resolveConnectionProxyConfig }, { toProxyOptions }] = await loadModules();
    const settings = await getSettings();
    const raw = (settings?.providerStrategies || {})[providerName]?.proxyPoolId;
    poolId = typeof raw === "string" ? raw.trim() : "";
    if (!poolId) return DIRECT("unconfigured");

    const resolved = await resolveConnectionProxyConfig({ proxyPoolId: poolId });
    if (!resolved || (!resolved.connectionProxyUrl && !resolved.vercelRelayUrl)) {
      console.warn(
        `[oauth] proxy pool "${poolId}" for provider "${providerName}" resolved to no usable relay; OAuth will go direct`
      );
      return DIRECT("unresolved", poolId);
    }
    return { proxyOptions: toProxyOptions(resolved), poolId, mode: "pool", detail: "" };
  } catch (error) {
    const detail = error?.message || String(error);
    console.warn(
      `[oauth] proxy resolution failed for provider "${providerName}": ${detail}; OAuth will go direct`
    );
    return DIRECT("error", poolId, detail);
  }
}

/** Thin wrapper for call sites that only need the bag (or null for direct). */
export async function resolveOAuthProxyOptions(providerName) {
  return (await resolveOAuthEgress(providerName)).proxyOptions;
}

/**
 * Run `fn` with this provider's OAuth pool as the ambient egress.
 *
 * Wrap the NARROWEST body that does the network work. The store is ambient: it
 * applies to every `fetch()` in the same async chain, so a wrapper placed
 * around a whole handler — let alone a module body or middleware — would hand
 * the pool to unrelated calls that merely happen to run inside it.
 */
export async function withOAuthEgress(providerName, fn) {
  return runWithOAuthProxy(await resolveOAuthProxyOptions(providerName), fn);
}

// Network-level failures, as opposed to an answer from the OAuth server.
// undici surfaces most of these as a bare `fetch failed` whose cause holds the
// real code, so match the message and the cause chain.
const NETWORK_ERROR_PATTERN =
  /fetch failed|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|UND_ERR|other side closed/i;

function isNetworkError(error) {
  const seen = new Set();
  for (let e = error, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (seen.has(e)) break; // a self-referential cause chain must not spin
    seen.add(e);
    if (NETWORK_ERROR_PATTERN.test(`${e.message || ""} ${e.code || ""}`)) return true;
  }
  return false;
}

/**
 * Turn a network-level OAuth failure into a message that says which egress path
 * was taken and what to change. Returns null for anything that is not a network
 * failure — an `invalid_grant` from the provider is the provider talking, and
 * must reach the user unedited.
 *
 * This exists because the opposite — swallowing the egress decision and
 * surfacing a bare `fetch failed` — sent a real operator hunting a deployed,
 * working fix for half an hour: the code was live, the provider simply had no
 * pool configured, and nothing in the error said so.
 */
export function describeOAuthEgressFailure(error, egress, providerName = "") {
  if (!error || !isNetworkError(error)) return null;
  const base = error.message || String(error);
  const provider = providerName || "this provider";
  const label = `${base} — the ${provider} OAuth request could not reach the token endpoint`;
  switch (egress?.mode) {
    case "pool":
      return `${label} through proxy pool "${egress.poolId}". Check that the pool's relays are up and reachable from this host.`;
    case "unresolved":
      return `${label}: it went out direct because proxy pool "${egress.poolId}" (configured for "${provider}") resolved to no usable relay. Fix the pool or point providerStrategies.${provider}.proxyPoolId at a working one.`;
    case "error":
      return `${label}: it went out direct because resolving the configured proxy pool failed (${egress.detail}).`;
    case "unconfigured":
    default:
      return `${label}: it went out direct because no egress proxy pool is configured for "${provider}". If this host blocks direct outbound traffic, set providerStrategies.${provider}.proxyPoolId to a proxy pool and retry.`;
  }
}
