/**
 * Live repro for issue #1933: MiMo Code Free returns HTTP 502 "MiMo bootstrap failed: 403".
 * Root cause: upstream gates on Chrome-like User-Agent. Without UA → 403 "Illegal access".
 * Hits real endpoints — no mocks. Free provider, safe to call.
 */
import { describe, it, expect } from "vitest";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { __test__ } from "../../open-sse/executors/mimo-free.js";

// Teste de rede real, sem mock: depende do que o upstream aceita HOJE, então
// passa a seguir a convenção dos outros testes ao vivo do repo
// (`tests/translator/real/*`, que usam `describe.skipIf(!RUN_REAL)`) em vez de
// rodar no `vitest run` padrão. Medido em 2026-09-19: o bootstrap ainda
// responde 200 com JWT, mas o chat recusa TODO id de modelo com
// `400 "Unsupported model ..."` — inclusive `mimo-auto`, o único da
// registry/mimo-free.js:23, e os ids atuais do models.dev
// (mimo-v2.5, mimo-v2.5-pro, mimo-v2-flash, mimo-v2-pro). O gate de
// anti-abuso por User-Agent que motivou o arquivo (#1933) não é mais o que
// barra: a superfície de chat do tier free mudou upstream. Isso é achado de
// PRODUTO, não bug de teste — e é por isso que não se conserta mudando a
// asserção: não há id conhecido que faça o 200 voltar. Rode com
// `RUN_REAL=1` para reconferir o upstream.
const RUN_REAL = process.env.RUN_REAL === "1";

const { BOOTSTRAP_URL, CHAT_URL, generateFingerprint, MIMO_SYSTEM_MARKER } = __test__;

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function bootstrapWith(ua) {
  const headers = { "Content-Type": "application/json" };
  if (ua) headers["User-Agent"] = ua;
  const r = await proxyAwareFetch(BOOTSTRAP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ client: generateFingerprint() }),
  });
  const data = await r.json();
  return { status: r.status, jwt: data.jwt };
}

async function chatWith(jwt, ua) {
  const headers = {
    "Content-Type": "application/json",
    "X-Mimo-Source": "mimocode-cli-free",
    Authorization: `Bearer ${jwt}`,
    Accept: "application/json",
  };
  if (ua) headers["User-Agent"] = ua;
  const body = {
    model: "mimo-auto",
    messages: [
      { role: "system", content: MIMO_SYSTEM_MARKER },
      { role: "user", content: "hi" },
    ],
    stream: false,
  };
  return proxyAwareFetch(CHAT_URL, { method: "POST", headers, body: JSON.stringify(body) });
}

describe.skipIf(!RUN_REAL)("MiMo Free bootstrap (live)", () => {
  it("bootstrap returns 200 with JWT", async () => {
    const { status, jwt } = await bootstrapWith(CHROME_UA);
    expect(status).toBe(200);
    expect(jwt).toBeTruthy();
  });
});

describe.skipIf(!RUN_REAL)("MiMo Free anti-abuse gate (live)", () => {
  it("chat WITH Chrome User-Agent → 200", async () => {
    const { jwt } = await bootstrapWith(CHROME_UA);
    const r = await chatWith(jwt, CHROME_UA);
    expect(r.status).toBe(200);
  });
});
