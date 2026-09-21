import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../utils/stream.js";
import { pipeWithDisconnect } from "../../utils/streamHandler.js";
import { PROVIDERS } from "../../config/providers.js";
import { HTTP_STATUS, STREAM_STALL_TIMEOUT_MS, CLAUDE_FIRST_BYTE_GATE_MS } from "../../config/runtimeConfig.js";
import { createErrorResult } from "../../utils/error.js";
import { buildAbortedResponsesTerminalBytes } from "../../utils/responsesStreamHelpers.js";
import { buildStreamErrorBytes } from "../../utils/streamHelpers.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats, formatDoneLine } from "./requestDetail.js";
import { saveRequestDetail } from "@/lib/usageDb.js";
import { SSE_HEADERS_CORS as SSE_HEADERS } from "../../utils/sseConstants.js";

// Codex returns Responses API SSE → which client format to translate INTO, by request sourceFormat.
// Gemini-family all map to ANTIGRAVITY decoder; unknown sources fall back to OPENAI.
const CODEX_SOURCE_TO_TARGET = {
  [FORMATS.OPENAI_RESPONSES]: FORMATS.OPENAI_RESPONSES,
  [FORMATS.CLAUDE]: FORMATS.CLAUDE,
  [FORMATS.ANTIGRAVITY]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI_CLI]: FORMATS.ANTIGRAVITY,
};

/**
 * Determine which SSE transform stream to use based on provider/format.
 */
function buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, customToolNames, model, connectionId, body, onStreamComplete, apiKey, credentials }) {
  const isDroidCLI = userAgent?.toLowerCase().includes("droid") || userAgent?.toLowerCase().includes("codex-cli");
  // Responses-API providers (e.g. codex) emit Responses SSE → translate into client format
  const isResponsesProvider = PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES;
  const needsCodexTranslation = isResponsesProvider && targetFormat === FORMATS.OPENAI_RESPONSES && !isDroidCLI;

  if (needsCodexTranslation) {
    const codexTarget = CODEX_SOURCE_TO_TARGET[sourceFormat] || FORMATS.OPENAI;
    return createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, codexTarget, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames, credentials);
  }

  if (needsTranslation(targetFormat, sourceFormat)) {
    return createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, customToolNames, credentials);
  }

  return createPassthroughStreamWithLogger(provider, reqLogger, model, connectionId, body, onStreamComplete, apiKey);
}

/**
 * Wait for the upstream's first chunk before the caller commits HTTP 200.
 *
 * Returns one of:
 *   { outcome: "byte", body }   — a chunk arrived; `body` re-assembles it with
 *                                 the rest of the upstream, so nothing is lost.
 *   { outcome: "timeout", body } — the ceiling passed with no byte. NOT a
 *                                 failure: `body` is the untouched upstream and
 *                                 the caller proceeds exactly as before.
 *   { outcome: "empty", message } — upstream ended (EOF or error) without ever
 *                                 sending a byte. This is the case worth
 *                                 catching: no 200 has been sent yet, so it can
 *                                 still become a retry.
 *
 * Same peek-before-commit shape as `codex.js` `_peekSseTransientError` and
 * `qoder.js` `peekFirstQoderFrame`.
 */
async function gateOnFirstByte(upstreamBody, ceilingMs) {
  const reader = upstreamBody.getReader();

  // `pending` is the in-flight first read, if the ceiling won the race. It MUST
  // be consumed before any further read(): dropping it would silently swallow
  // the first chunk of a slow-but-healthy response.
  const rebuild = (prefix, pending = null) => new ReadableStream({
    start(controller) {
      for (const c of prefix) controller.enqueue(c);
    },
    async pull(controller) {
      try {
        const { done, value } = pending ? await (() => { const p = pending; pending = null; return p; })() : await reader.read();
        if (done) { controller.close(); return; }
        controller.enqueue(value);
      } catch (e) { controller.error(e); }
    },
    cancel(reason) {
      try { reader.cancel(reason); } catch { /* noop */ }
    },
  });

  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ceilingMs);
  });

  try {
    const firstRead = reader.read();
    const race = await Promise.race([firstRead.then((r) => ({ read: r })), timeout]);

    if (race.timedOut) {
      // The read is still pending and still owns the lock; hand the caller a
      // stream that consumes that same pending read before continuing.
      return { outcome: "timeout", body: rebuild([], firstRead) };
    }

    const { done, value } = race.read;
    if (done || !value || (value.byteLength ?? value.length ?? 0) === 0) {
      return { outcome: "empty", message: "upstream closed before first token" };
    }
    return { outcome: "byte", body: rebuild([value]) };
  } catch (e) {
    return { outcome: "empty", message: `upstream closed before first token: ${e?.message || e}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Handle streaming response — pipe provider SSE through transform stream to client.
 */
export async function handleStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, userAgent, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, customToolNames, streamController, onStreamComplete, streamDetailId, settled = { done: false }, pxpipe, reqTag, log, credentials }) {
  const reportSuccess = () => {
    if (!onRequestSuccess) return;
    Promise.resolve()
      .then(onRequestSuccess)
      .catch(err => {
        console.error("[ChatCore] onRequestSuccess failed:", err?.message || err);
      });
  };

  // When upstream returns HTML/text instead of SSE (e.g. Cloudflare 5xx error
  // page), piping it through the SSE transform stream causes Next.js
  // "failed to pipe response" and crashes the chat router. Read the body,
  // pull a short human-readable message from the <title>, sanitize it, and
  // return a clean JSON error instead. The message is stripped of HTML tags
  // and clamped so untrusted upstream text never reaches the client verbatim
  // (the UI may render error.message as HTML).
  const upstreamContentType = (providerResponse.headers.get('content-type') || '').toLowerCase();
  if (upstreamContentType && !upstreamContentType.includes('text/event-stream') && !upstreamContentType.includes('application/json')) {
    const bodyText = await providerResponse.text().catch(() => '');
    const titleMatch = bodyText.match(/<title>([^<]+)<\/title>/i);
    const sanitizedTitle = (titleMatch?.[1] || '').replace(/<[^>]*>/g, '').replace(/[\r\n]+/g, ' ').trim().slice(0, 160);
    const shortMsg = sanitizedTitle
      || (bodyText.length < 200 ? bodyText.replace(/<[^>]*>/g, '').trim().slice(0, 160) : `Upstream returned non-SSE response (${upstreamContentType})`);
    const status = providerResponse.status || 502;
    if (log?.errorLine) log.errorLine(reqTag, "✗", `BLOCKED ${status} · ${provider}/${model} · non-SSE (${upstreamContentType})\n    ${shortMsg}`);
    else console.warn(`[STREAM] ${provider} | ${model} | blocked pipe: ${shortMsg} [${status}]`);
    streamController?.handleError?.(new Error(`upstream non-SSE: ${status}`));
    return {
      success: false,
      response: new Response(JSON.stringify({ error: { message: `[${status}]: ${shortMsg}` } }), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }),
    };
  }

  // First-byte gate — Claude passthrough only. A stream that dies before its
  // first token is the one failure the gateway can still convert into a retry:
  // no byte has reached the client, so the 200 is not yet committed and
  // `{ success: false }` sends the request back through the account loop in
  // src/sse/handlers/chat.js. Scope and ceiling are justified in
  // CLAUDE_FIRST_BYTE_GATE_MS (claude TTFT p99 = 2,824ms); the rest of the
  // traffic (codex p50 = 26.7s) could never afford the wait.
  let upstreamBody = providerResponse.body;
  const isClaudePassthrough =
    sourceFormat === FORMATS.CLAUDE &&
    targetFormat === FORMATS.CLAUDE &&
    PROVIDERS[provider]?.format === FORMATS.CLAUDE;

  if (isClaudePassthrough && upstreamBody) {
    const gate = await gateOnFirstByte(upstreamBody, CLAUDE_FIRST_BYTE_GATE_MS);
    if (gate.outcome === "empty") {
      const msg = `[${provider}/${model}] ${gate.message}`;
      if (log?.errorLine) log.errorLine(reqTag, "⇄", `EMPTY STREAM · ${provider}/${model} · ${Date.now() - requestStartTime}ms → NEXT ACCOUNT`);
      else console.warn(`[STREAM] ${msg}`);
      streamController?.handleError?.(new Error(gate.message));
      // 502: upstream accepted then broke. The text rule in errorConfig.js keeps
      // this from cooling down a credential that did nothing wrong.
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, msg);
    }
    upstreamBody = gate.body;
  }

  // Only now is there evidence of a live stream. Moved off the optimistic path:
  // it used to clear the account's error state before a single byte existed.
  reportSuccess();

  const transformStream = buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, customToolNames, model, connectionId, body, onStreamComplete, apiKey, credentials });

  // Terminal bytes when the stream aborts after HTTP 200 was already sent, so the
  // client sees a real error instead of a silently truncated stream.
  // Responses passthrough keeps its own response.failed shape; every other client
  // format gets the OpenAI error frame + [DONE], or `event: error` for Claude.
  const isResponsesPassthrough = sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES;
  const onAbortTerminal = isResponsesPassthrough
    ? buildAbortedResponsesTerminalBytes
    : (message, opts) => buildStreamErrorBytes(HTTP_STATUS.GATEWAY_TIMEOUT, message, sourceFormat, { ...opts, model });
  const stallTimeoutMs = PROVIDERS[provider]?.stallTimeoutMs || STREAM_STALL_TIMEOUT_MS;

  // The abort path never reaches finalizeStream(), so onStreamComplete never
  // fires and the placeholder row below would stay "success" forever. Rewriting
  // the SAME id turns that silent row into the error it actually was — the
  // UPSERT in requestDetailsRepo gives the overwrite for free.
  const onStreamAborted = (reason, stats) => {
    if (settled.done) return;
    settled.done = true;
    if (log?.errorLine) log.errorLine(reqTag, "✗", `STREAM ABORTED · ${provider}/${model} · ${reason} · chunks=${stats?.chunkCount ?? 0} · ${stats?.durationMs ?? 0}ms`);
    else console.warn(`[STREAM] ABORTED ${provider}/${model} | ${reason} | chunks=${stats?.chunkCount ?? 0}`);

    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId, apiKey,
      endpoint: clientRawRequest?.endpoint,
      latency: { ttft: 0, total: Date.now() - requestStartTime },
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: "[Streaming - aborted before completion]",
      response: { content: "[Stream aborted]", thinking: null, type: "streaming" },
      pxpipe,
      status: "error",
      statusCode: HTTP_STATUS.GATEWAY_TIMEOUT,
      errorReason: reason
    }, { id: streamDetailId })).catch(err => {
      console.error("[RequestDetail] Failed to record aborted stream:", err.message);
    });
  };

  const transformedBody = pipeWithDisconnect({ body: upstreamBody }, transformStream, streamController, onAbortTerminal, stallTimeoutMs, onStreamAborted);

  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId, apiKey,
    endpoint: clientRawRequest?.endpoint,
    latency: { ttft: 0, total: Date.now() - requestStartTime },
    tokens: { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: "[Streaming - raw response not captured]",
    response: { content: "[Streaming in progress...]", thinking: null, type: "streaming" },
    pxpipe,
    status: "success"
  }, { id: streamDetailId })).catch(err => {
    console.error("[RequestDetail] Failed to save streaming request:", err.message);
  });

  return {
    success: true,
    response: new Response(transformedBody, { headers: SSE_HEADERS })
  };
}

/**
 * Build onStreamComplete callback for streaming usage tracking.
 */
export function buildOnStreamComplete({ provider, model, connectionId, apiKey, requestStartTime, body, stream, finalBody, translatedBody, clientRawRequest, pxpipe, reqTag, log }) {
  const streamDetailId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  // Completion and abort both rewrite the same row. They are near-exclusive, but
  // a partial EOF can reach flush() -> finalizeStream() and then still error, so
  // whichever lands first owns the outcome.
  const settled = { done: false };

  const onStreamComplete = (contentObj, usage, ttftAt) => {
    if (settled.done) return;
    settled.done = true;
    const latency = {
      ttft: ttftAt ? ttftAt - requestStartTime : Date.now() - requestStartTime,
      total: Date.now() - requestStartTime
    };
    const safeContent = contentObj?.content || "[Empty streaming response]";
    const safeThinking = contentObj?.thinking || null;

    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId, apiKey,
      endpoint: clientRawRequest?.endpoint,
      latency,
      tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: safeContent,
      response: { content: safeContent, thinking: safeThinking, type: "streaming" },
      pxpipe,
      status: "success"
    }, { id: streamDetailId })).catch(err => {
      console.error("[RequestDetail] Failed to update streaming content:", err.message);
    });

    // Persist stream usage to DB (no console line; the "📊 done" line below is authoritative)
    saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, latency, label: "STREAM USAGE", silent: true });
    if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage, latency }));
  };

  return { onStreamComplete, streamDetailId, settled };
}
