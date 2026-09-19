// Concurrency stress test — simulate many parallel saveRequestUsage / saveRequestDetail
// to verify atomic counter, no data loss, no race conditions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-concurrent-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(async () => {
  // Fechar o handle do SQLite ANTES do rmSync: no Windows um arquivo com
  // handle aberto não pode ser apagado, o rmSync dava EPERM e derrubava o
  // arquivo de teste inteiro no teardown mesmo com todos os testes passando.
  try {
    const { getAdapter } = await import("@/lib/db/driver.js");
    (await getAdapter())?.close?.();
  } catch { /* teardown não deve mascarar falha de teste */ }
  // O adapter vive em `global._dbAdapter` (driver.js:4) e sobrevive ao
  // `vi.resetModules()`; sem zerar, o próximo arquivo reusa o handle fechado.
  global._dbAdapter = { instance: null, initPromise: null, logged: false };
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("DB Concurrency — atomic safety", () => {
  it("100 parallel saveRequestUsage → no count loss", async () => {
    const N = 100;
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(db.saveRequestUsage({
        // `connectionId` único por requisição. `0d216689` ("deduplicate
        // identical usage writes") colapsa escritas indistinguíveis, e a chave
        // de dedupe (usageRepo.js:257-272) é
        // timestamp+provider+model+connectionId+apiKey+tokens. Cem escritas
        // idênticas disparadas no mesmo milissegundo batem TODAS na mesma
        // chave: o resultado era 2, e isso é a dedupe funcionando, não perda
        // de escrita. Requisições reais concorrentes vêm de conexões
        // diferentes — é esse cenário que este teste quer medir.
        provider: "openai", model: "gpt-4", connectionId: `c1-${i}`,
        tokens: { prompt_tokens: 10, completion_tokens: 5 },
        endpoint: "/v1/chat", status: "ok",
      }));
    }
    await Promise.all(promises);

    const stats = await db.getUsageStats("24h");
    expect(stats.totalRequests).toBe(N);
    expect(stats.byProvider.openai.requests).toBe(N);
    expect(stats.byProvider.openai.promptTokens).toBe(N * 10);

    const hist = await db.getUsageHistory({ provider: "openai" });
    expect(hist.length).toBe(N);
  });

  it("200 parallel saveRequestDetail → all flushed", async () => {
    await db.updateSettings({ enableObservability: true, observabilityBatchSize: 10 });

    const N = 200;
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(db.saveRequestDetail({
        id: `det-${i}`, provider: "openai", model: "gpt-4",
        connectionId: "c1", status: "ok",
        tokens: { prompt_tokens: 1 }, request: { i }, response: { ok: true },
      }));
    }
    await Promise.all(promises);

    // Wait for any timer-based flush
    await new Promise((r) => setTimeout(r, 6000));

    const list = await db.getRequestDetails({ provider: "openai", pageSize: 500 });
    expect(list.pagination.totalItems).toBeGreaterThanOrEqual(N);
  }, 15000);

  it("mixed concurrent: usage + details + connections + aliases", async () => {
    const ops = [];
    for (let i = 0; i < 50; i++) {
      ops.push(db.saveRequestUsage({
        // `connectionId` único pelo mesmo motivo do primeiro teste: com
        // `model: m-${i % 3}` e connectionId fixo, as 50 escritas caíam em 3
        // chaves de dedupe e o total vinha 48.
        provider: "anthropic", model: `m-${i % 3}`, connectionId: `c2-${i}`,
        tokens: { prompt_tokens: 20 }, status: "ok",
      }));
      ops.push(db.setModelAlias(`a-${i}`, `target-${i}`));
      ops.push(db.disableModels("openai", [`d-${i}`]));
    }
    await Promise.all(ops);

    const aliases = await db.getModelAliases();
    expect(Object.keys(aliases).filter((k) => k.startsWith("a-")).length).toBe(50);

    const disabled = await db.getDisabledByProvider("openai");
    expect(disabled.length).toBeGreaterThanOrEqual(50);

    const stats = await db.getUsageStats("24h");
    expect(stats.byProvider.anthropic.requests).toBe(50);
  }, 30000);

  it("updateSettings parallel → no merge loss", async () => {
    const N = 50;
    await db.updateSettings({ counter: 0 });
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(db.updateSettings({ [`field${i}`]: `v${i}` }));
    }
    await Promise.all(promises);
    const s = await db.getSettings();
    for (let i = 0; i < N; i++) {
      expect(s[`field${i}`]).toBe(`v${i}`); // all updates preserved
    }
  });

  it("OAuth refresh race: parallel updateProviderConnection on same id", async () => {
    const conn = await db.createProviderConnection({
      provider: "oauth-test", authType: "oauth", email: "x@y.com",
      accessToken: "initial", refreshToken: "rt-initial",
    });

    // 20 parallel updates each with a unique field
    const N = 20;
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(db.updateProviderConnection(conn.id, { [`marker${i}`]: i }));
    }
    await Promise.all(promises);

    const after = await db.getProviderConnectionById(conn.id);
    for (let i = 0; i < N; i++) {
      expect(after[`marker${i}`]).toBe(i); // no field lost
    }
    expect(after.refreshToken).toBe("rt-initial"); // base preserved
  });

  it("addCustomModel race: parallel duplicate adds → only 1 inserted", async () => {
    const N = 30;
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(db.addCustomModel({ providerAlias: "racep", id: "racemodel", type: "llm", name: "r" }));
    }
    const results = await Promise.all(promises);
    const trueCount = results.filter((r) => r === true).length;
    expect(trueCount).toBe(1); // exactly one wins
    const all = await db.getCustomModels();
    expect(all.filter((m) => m.providerAlias === "racep" && m.id === "racemodel").length).toBe(1);
  });

  it("updatePricing race: parallel adds different models → all merged", async () => {
    const N = 30;
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(db.updatePricing({ "race-prov": { [`m${i}`]: { input: i, output: i * 2 } } }));
    }
    await Promise.all(promises);
    const p = await db.getPricing();
    for (let i = 0; i < N; i++) {
      expect(p["race-prov"][`m${i}`]).toEqual({ input: i, output: i * 2 });
    }
  });

  it("daily summary aggregates correctly under parallel writes", async () => {
    const N = 50;
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(db.saveRequestUsage({
        // Idem: sem o sufixo, as 50 escritas viravam 1.
        provider: "google", model: "gemini-pro", connectionId: `cG-${i}`,
        tokens: { prompt_tokens: 100, completion_tokens: 50 },
        status: "ok",
      }));
    }
    await Promise.all(promises);

    const stats = await db.getUsageStats("7d");
    const g = stats.byProvider.google;
    expect(g).toBeDefined();
    expect(g.requests).toBe(N);
    expect(g.promptTokens).toBe(N * 100);
    expect(g.completionTokens).toBe(N * 50);
  });

  it("escritas realmente idênticas são deduplicadas (0d216689)", async () => {
    // O outro lado da moeda dos três testes acima: quando a chave de dedupe
    // coincide de verdade, colapsar é o comportamento desejado — é o que evita
    // que um retry contabilize a mesma requisição duas vezes. Timestamp fixo
    // para não depender do relógio.
    const timestamp = new Date().toISOString();
    const entry = () => ({
      timestamp, provider: "dedupe-prov", model: "m", connectionId: "cD",
      tokens: { prompt_tokens: 7, completion_tokens: 3 }, status: "ok",
    });

    await Promise.all(Array.from({ length: 20 }, () => db.saveRequestUsage(entry())));

    const hist = await db.getUsageHistory({ provider: "dedupe-prov" });
    expect(hist.length).toBe(1);
  });
});
