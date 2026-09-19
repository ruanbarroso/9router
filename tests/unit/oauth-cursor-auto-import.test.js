// GET /api/oauth/cursor/auto-import
//
// Este arquivo foi reescrito: os testes anteriores (de `d7e06c30`) checavam um
// contrato que a rota perdeu em TRÊS reescritas posteriores — `3f852775`
// (tirou o sql.js), `8312af79` (verificação de instalação no Linux) e
// `a6c764d7` (better-sqlite3 no lugar do CLI). O que eles pediam e não existe
// mais: a mensagem "not found in known macOS locations" (hoje a lista de
// caminhos conferidos), a mensagem "could not open it" (hoje o fallback
// `windowsManual`), o fallback por LIKE difuso (a rota consulta chaves exatas
// com `.get()`, não `.all()`), o caminho único hardcoded no Linux (hoje são
// dois candidatos) e o 400 de "Unsupported platform" (plataforma desconhecida
// cai no ramo Linux). Test bug, não bug de código.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fsPromises from "fs/promises";

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

vi.mock("os", () => ({
  default: { homedir: vi.fn(() => "/mock/home") },
  homedir: vi.fn(() => "/mock/home"),
}));

vi.mock("fs/promises", () => ({
  access: vi.fn(),
  constants: { R_OK: 4 },
}));

// `execFile` é consumido via `promisify` no topo do módulo da rota, então o
// mock precisa ter assinatura de callback — senão o CLI do sqlite3 seria
// executado de verdade. Rejeitar é o cenário normal: sem `sqlite3` no PATH a
// rota cai na estratégia 3.
const execFileMock = vi.fn((file, args, opts, cb) => {
  const done = typeof opts === "function" ? opts : cb;
  done(new Error("ENOENT"));
});
vi.mock("child_process", () => ({
  default: { execFile: execFileMock },
  execFile: execFileMock,
}));

const mockDbInstance = {
  prepare: vi.fn(),
  close: vi.fn(),
  __throwOnConstruct: false,
};

vi.mock("better-sqlite3", () => ({
  default: class MockDatabase {
    constructor() {
      if (mockDbInstance.__throwOnConstruct) throw new Error("SQLITE_CANTOPEN");
      return mockDbInstance;
    }
  },
}));

// Atalho para o formato que a rota realmente usa: `prepare(sql).get(key)`
// devolvendo `{ value }`, uma linha por chave consultada.
const rowsByKey = (map) => {
  mockDbInstance.prepare.mockReturnValue({
    get: vi.fn((key) => (key in map ? { value: map[key] } : undefined)),
  });
};

let GET;

describe("GET /api/oauth/cursor/auto-import", () => {
  const originalPlatform = process.platform;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDbInstance.__throwOnConstruct = false;
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    const mod = await import("../../src/app/api/oauth/cursor/auto-import/route.js");
    GET = mod.GET;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  // ── Sondagem de caminhos ──────────────────────────────────────────────

  it("nenhum caminho acessível → found:false listando os candidatos conferidos", async () => {
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor database not found. Checked locations:");
    // Os dois candidatos de macOS precisam aparecer na mensagem — é ela que
    // diz ao usuário onde a rota procurou.
    // Separador agnóstico: `path.join` emite `\` no Windows e `/` no resto.
    expect(response.body.error).toMatch(/Cursor[\\/]User[\\/]globalStorage[\\/]state\.vscdb/);
    expect(response.body.error).toContain("Cursor - Insiders");
  });

  it("primeiro candidato ilegível → cai para o segundo em vez de desistir", async () => {
    let call = 0;
    vi.mocked(fsPromises.access).mockImplementation(async () => {
      if (++call === 1) throw new Error("ENOENT");
    });
    rowsByKey({
      "cursorAuth/accessToken": "insiders-token",
      "storage.serviceMachineId": "insiders-machine",
    });

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("insiders-token");
  });

  // ── Extração de tokens ────────────────────────────────────────────────

  it("extrai tokens pelas chaves exatas e fecha o banco", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    rowsByKey({
      "cursorAuth/accessToken": "test-token",
      "storage.serviceMachineId": "test-machine-id",
    });

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("test-token");
    expect(response.body.machineId).toBe("test-machine-id");
    expect(mockDbInstance.close).toHaveBeenCalled();
  });

  it("desembrulha valores codificados como string JSON", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    rowsByKey({
      "cursorAuth/accessToken": '"json-token"',
      "storage.serviceMachineId": '"json-machine-id"',
    });

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("json-token");
    expect(response.body.machineId).toBe("json-machine-id");
  });

  it("usa as chaves alternativas quando a primeira de cada lista não existe", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    rowsByKey({
      "cursorAuth/token": "alt-token",
      "telemetry.machineId": "alt-machine",
    });

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("alt-token");
    expect(response.body.machineId).toBe("alt-machine");
  });

  // ── Fallbacks ─────────────────────────────────────────────────────────

  it("banco existe mas não abre → fallback manual com o caminho encontrado", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    mockDbInstance.__throwOnConstruct = true;

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.windowsManual).toBe(true);
    expect(response.body.dbPath).toContain("state.vscdb");
  });

  it("banco abre mas não tem os tokens → fallback manual, não erro", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    rowsByKey({});

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.windowsManual).toBe(true);
  });

  it("token sem machineId não conta como sucesso parcial", async () => {
    vi.mocked(fsPromises.access).mockResolvedValue();
    rowsByKey({ "cursorAuth/accessToken": "só-o-token" });

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.windowsManual).toBe(true);
  });

  // ── Linux: verificação de instalação (8312af79) ───────────────────────

  it("linux com config presente mas Cursor não instalado → recusa importar", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    // O `state.vscdb` é legível; o `.desktop` não. Com `which cursor` também
    // falhando (mock de execFile rejeita), a rota conclui que o Cursor não
    // está instalado e não toca no banco.
    vi.mocked(fsPromises.access).mockImplementation(async (p) => {
      if (String(p).endsWith(".desktop")) throw new Error("ENOENT");
    });

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("does not appear to be installed");
    expect(mockDbInstance.prepare).not.toHaveBeenCalled();
  });

  it("linux com o .desktop presente segue para a extração", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    vi.mocked(fsPromises.access).mockResolvedValue();
    rowsByKey({
      "cursorAuth/accessToken": "linux-token",
      "storage.serviceMachineId": "linux-machine",
    });

    const response = await GET();

    expect(response.body.found).toBe(true);
    expect(response.body.accessToken).toBe("linux-token");
  });

  // ── Plataformas ───────────────────────────────────────────────────────

  it("win32 sonda os quatro caminhos de AppData", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.body.found).toBe(false);
    expect(vi.mocked(fsPromises.access)).toHaveBeenCalledTimes(4);
  });

  it("plataforma desconhecida cai no ramo genérico (não é mais 400)", async () => {
    Object.defineProperty(process, "platform", { value: "freebsd", writable: true });
    vi.mocked(fsPromises.access).mockRejectedValue(new Error("ENOENT"));

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.body.found).toBe(false);
    expect(response.body.error).toMatch(/\.config[\\/]Cursor/);
  });
});
