// Check if running in Node.js environment (has fs module)
const isNode = typeof process !== "undefined" && process.versions?.node && typeof window === "undefined";

// Check if logging is enabled via environment variable (default: false)
// ENABLE_REQUEST_LOGS turns on the DB-backed observability used by the dashboard
// (requestDetails + usageHistory.meta). It must NOT also turn on this file dumper:
// the dumps below write request/response bodies AND, because maskSensitiveHeaders is
// currently a pass-through, verbatim Authorization headers to disk. That is a
// credential and prompt spill, so it gets its own opt-in and stays off by default.
const LOGGING_ENABLED = typeof process !== "undefined" && process.env?.ENABLE_REQUEST_FILE_DUMPS === 'true';

let fs = null;
let path = null;
let LOGS_DIR = null;

// Lazy load Node.js modules (avoid top-level await)
async function ensureNodeModules() {
  if (!isNode || !LOGGING_ENABLED || fs) return;
  try {
    fs = await import("fs");
    path = await import("path");
    LOGS_DIR = path.join(typeof process !== "undefined" && process.cwd ? process.cwd() : ".", "logs");
  } catch {
    // Running in non-Node environment (Worker, Browser, etc.)
  }
}

// Format timestamp for folder name: 20251228_143045_123
function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${y}${m}${d}_${h}${min}${s}_${ms}`;
}

// Create log session folder: {sourceFormat}_{targetFormat}_{model}_{timestamp}
async function createLogSession(sourceFormat, targetFormat, model) {
  await ensureNodeModules();
  if (!fs || !LOGS_DIR) return null;
  
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
    
    const timestamp = formatTimestamp();
    const safeModel = (model || "unknown").replace(/[/:]/g, "-");
    const folderName = `${sourceFormat}_${targetFormat}_${safeModel}_${timestamp}`;
    const sessionPath = path.join(LOGS_DIR, folderName);
    
    fs.mkdirSync(sessionPath, { recursive: true });
    
    return sessionPath;
  } catch (err) {
    console.log("[LOG] Failed to create log session:", err.message);
    return null;
  }
}

// Write JSON file
function writeJsonFile(sessionPath, filename, data) {
  if (!fs || !sessionPath) return;
  
  try {
    const filePath = path.join(sessionPath, filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.log(`[LOG] Failed to write ${filename}:`, err.message);
  }
}

// Mask sensitive data in headers.
// These dumps land on disk as plain files, so anything not masked here is a
// credential at rest. Masking keeps a recognizable prefix/suffix (enough to tell
// two tokens apart when debugging) and drops the middle. Short values are replaced
// outright rather than partially shown: revealing 20 chars of a 24-char key is
// not redaction.
const SENSITIVE_HEADER_KEYS = [
  "authorization",
  "x-api-key",
  "api-key",
  "cookie",
  "set-cookie",
  "token",
  "secret",
  "x-goog-api-key",
  "x-auth",
  "proxy-authorization",
];

function maskHeaderValue(value) {
  const str = Array.isArray(value) ? value.join(", ") : String(value ?? "");
  if (!str) return str;
  if (str.length <= 20) return "[REDACTED]";
  return `${str.slice(0, 6)}…[REDACTED]…${str.slice(-4)}`;
}

function maskSensitiveHeaders(headers) {
  if (!headers) return {};
  // Accept a Headers instance as well as a plain object: logProviderResponse
  // receives whatever the provider handed back.
  const plain = typeof headers?.entries === "function"
    ? Object.fromEntries(headers.entries())
    : { ...headers };

  for (const key of Object.keys(plain)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_HEADER_KEYS.some((sk) => lowerKey.includes(sk))) {
      plain[key] = maskHeaderValue(plain[key]);
    }
  }
  return plain;
}

// No-op logger when logging is disabled
function createNoOpLogger() {
  return {
    sessionPath: null,
    logClientRawRequest() {},
    logRawRequest() {},
    logOpenAIRequest() {},
    logTargetRequest() {},
    logProviderResponse() {},
    appendProviderChunk() {},
    appendOpenAIChunk() {},
    logConvertedResponse() {},
    appendConvertedChunk() {},
    logError() {}
  };
}

/**
 * Create a new log session and return logger functions
 * @param {string} sourceFormat - Source format from client (claude, openai, etc.)
 * @param {string} targetFormat - Target format to provider (antigravity, gemini-cli, etc.)
 * @param {string} model - Model name
 * @returns {Promise<object>} Promise that resolves to logger object with methods to log each stage
 */
export async function createRequestLogger(sourceFormat, targetFormat, model) {
  // Return no-op logger if logging is disabled
  if (!LOGGING_ENABLED) {
    return createNoOpLogger();
  }
  
  // Wait for session to be created before returning logger
  const sessionPath = await createLogSession(sourceFormat, targetFormat, model);
  
  return {
    get sessionPath() { return sessionPath; },
    
    // 1. Log client raw request (before any conversion)
    logClientRawRequest(endpoint, body, headers = {}) {
      writeJsonFile(sessionPath, "1_req_client.json", {
        timestamp: new Date().toISOString(),
        endpoint,
        headers: maskSensitiveHeaders(headers),
        body
      });
    },
    
    // 2. Log raw request from client (after initial conversion like responsesApi)
    logRawRequest(body, headers = {}) {
      writeJsonFile(sessionPath, "2_req_source.json", {
        timestamp: new Date().toISOString(),
        headers: maskSensitiveHeaders(headers),
        body
      });
    },
    
    // 3. Log OpenAI intermediate format (source → openai)
    logOpenAIRequest(body) {
      writeJsonFile(sessionPath, "3_req_openai.json", {
        timestamp: new Date().toISOString(),
        body
      });
    },
    
    // 4. Log target format request (openai → target)
    logTargetRequest(url, headers, body) {
      writeJsonFile(sessionPath, "4_req_target.json", {
        timestamp: new Date().toISOString(),
        url,
        headers: maskSensitiveHeaders(headers),
        body
      });
    },
    
    // 5. Log provider response (for non-streaming or error)
    logProviderResponse(status, statusText, headers, body) {
      const filename = "5_res_provider.json";
      writeJsonFile(sessionPath, filename, {
        timestamp: new Date().toISOString(),
        status,
        statusText,
        headers: maskSensitiveHeaders(headers),
        body
      });
    },
    
    // 5. Append streaming chunk to provider response
    appendProviderChunk(chunk) {
      if (!fs || !sessionPath) return;
      try {
        const filePath = path.join(sessionPath, "5_res_provider.txt");
        fs.appendFileSync(filePath, chunk);
      } catch (err) {
        // Ignore append errors
      }
    },
    
    // 6. Append OpenAI intermediate chunks (target → openai)
    appendOpenAIChunk(chunk) {
      if (!fs || !sessionPath) return;
      try {
        const filePath = path.join(sessionPath, "6_res_openai.txt");
        fs.appendFileSync(filePath, chunk);
      } catch (err) {
        // Ignore append errors
      }
    },
    
    // 7. Log converted response to client (for non-streaming)
    logConvertedResponse(body) {
      writeJsonFile(sessionPath, "7_res_client.json", {
        timestamp: new Date().toISOString(),
        body
      });
    },
    
    // 7. Append streaming chunk to converted response
    appendConvertedChunk(chunk) {
      if (!fs || !sessionPath) return;
      try {
        const filePath = path.join(sessionPath, "7_res_client.txt");
        fs.appendFileSync(filePath, chunk);
      } catch (err) {
        // Ignore append errors
      }
    },
    
    // 6. Log error
    logError(error, requestBody = null) {
      writeJsonFile(sessionPath, "6_error.json", {
        timestamp: new Date().toISOString(),
        error: error?.message || String(error),
        stack: error?.stack,
        requestBody
      });
    }
  };
}

// Legacy functions for backward compatibility
export function logRequest() {}
export function logResponse() {}
export function logError(provider, { error, url, model, requestBody }) {
  if (!fs || !LOGS_DIR) return;
  
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
    
    const date = new Date().toISOString().split("T")[0];
    const logPath = path.join(LOGS_DIR, `${provider}-${date}.log`);
    
    const logEntry = {
      timestamp: new Date().toISOString(),
      type: "error",
      provider,
      model,
      url,
      error: error?.message || String(error),
      stack: error?.stack,
      requestBody
    };
    
    fs.appendFileSync(logPath, JSON.stringify(logEntry) + "\n");
  } catch (err) {
    console.log("[LOG] Failed to write error log:", err.message);
  }
}
