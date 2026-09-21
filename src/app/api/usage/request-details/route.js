import { NextResponse } from "next/server";
import { getRequestDetails } from "@/lib/usageDb";
import { getApiKeys } from "@/lib/db/repos/apiKeysRepo.js";
import { getProviderConnections } from "@/lib/db/repos/connectionsRepo.js";
import { getPricingForModel } from "@/lib/db/repos/pricingRepo.js";
import { calculateCostFromTokens } from "open-sse/providers/pricing.js";

// The raw key is a live credential, so it never leaves the server. Callers get
// the key's friendly name; unknown keys degrade to a masked prefix so a request
// is still attributable without disclosing a usable secret.
function maskApiKey(key) {
  if (!key || typeof key !== "string") return null;
  if (key.length <= 8) return `${key.charAt(0)}***`;
  return `${key.slice(0, 8)}***`;
}

/**
 * GET /api/usage/request-details
 * Query parameters: page, pageSize (1-100), provider, model, connectionId, status, startDate, endDate
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    
    const pageRaw = parseInt(searchParams.get("page"));
    const page = Number.isNaN(pageRaw) ? 1 : pageRaw;
    const pageSizeRaw = parseInt(searchParams.get("pageSize"));
    const pageSize = Number.isNaN(pageSizeRaw) ? 20 : pageSizeRaw;
    const provider = searchParams.get("provider");
    const model = searchParams.get("model");
    const connectionId = searchParams.get("connectionId");
    const status = searchParams.get("status");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    
    if (page < 1) {
      return NextResponse.json(
        { error: "Page must be >= 1" },
        { status: 400 }
      );
    }
    
    if (pageSize < 1 || pageSize > 100) {
      return NextResponse.json(
        { error: "PageSize must be between 1 and 100" },
        { status: 400 }
      );
    }
    
    const filter = {
      page,
      pageSize
    };
    
    if (provider) filter.provider = provider;
    if (model) filter.model = model;
    if (connectionId) filter.connectionId = connectionId;
    if (status) filter.status = status;
    if (startDate) filter.startDate = startDate;
    if (endDate) filter.endDate = endDate;
    
    const result = await getRequestDetails(filter);

    // Redact conversation payloads: the stored details include full request
    // bodies (user prompts, tool calls) and provider responses. Returning them
    // wholesale lets any dashboard-authenticated user (or, if requireLogin is
    // disabled, anyone) read every user's conversation history. Keep the
    // metadata (model, tokens, latency, status) but drop message content.
    // Resolve the stored identifiers into the names the dashboard shows. Both
    // lookups are best-effort: a deleted key or connection must not break the log.
    const [keys, connections] = await Promise.all([
      getApiKeys().catch(() => []),
      getProviderConnections().catch(() => []),
    ]);
    const keyNameByToken = new Map((keys || []).map((k) => [k.key, k.name]));
    const accountById = new Map(
      (connections || []).map((c) => [c.id, c.name || c.email || null])
    );

    // requestDetails has no cost column, so derive it here from the tokens it
    // does store. Pricing is memoized per provider|model for the page — a page
    // is at most 100 rows over a handful of models, so this is a few lookups.
    const pricingCache = new Map();
    async function costOf(provider, model, tokens) {
      if (!provider || !model || !tokens) return null;
      const cacheKey = `${provider}|${model}`;
      if (!pricingCache.has(cacheKey)) {
        pricingCache.set(cacheKey, await getPricingForModel(provider, model).catch(() => null));
      }
      const pricing = pricingCache.get(cacheKey);
      if (!pricing) return null;
      try {
        return calculateCostFromTokens(tokens, pricing);
      } catch {
        return null;
      }
    }

    const redactedDetails = [];
    for (const d of result.details || []) {
      const redacted = { ...d };
      for (const key of ["request", "providerRequest", "providerResponse", "response"]) {
        if (redacted[key] !== undefined) {
          redacted[key] = { redacted: true };
        }
      }
      redacted.apiKeyName = d.apiKey
        ? keyNameByToken.get(d.apiKey) || maskApiKey(d.apiKey)
        : null;
      redacted.accountName = d.connectionId ? accountById.get(d.connectionId) || null : null;
      redacted.cost = await costOf(d.provider, d.model, d.tokens);
      delete redacted.apiKey;
      redactedDetails.push(redacted);
    }

    return NextResponse.json({ ...result, details: redactedDetails });
  } catch (error) {
    console.error("[API] Failed to get request details:", error);
    return NextResponse.json(
      { error: "Failed to fetch request details" },
      { status: 500 }
    );
  }
}
