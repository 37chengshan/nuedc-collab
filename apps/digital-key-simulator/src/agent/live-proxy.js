import { DigitalKeyAgentError } from "./errors.js";

const LIVE_PATHS = {
  "recorder.status.get": "/api/status",
  "recorder.measurements.list": "/api/measurements",
  "recorder.sessions.list": "/api/sessions",
};

function assertLoopback4173(baseUrl) {
  const url = new URL(baseUrl);
  const loopback = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (!loopback.has(url.hostname) || url.port !== "4173") {
    throw new DigitalKeyAgentError(
      "LIVE_PROXY_TARGET_FORBIDDEN",
      "实机代理目标必须是本机 4173 端口",
      {
        status: 403,
        details: { baseUrl: url.origin },
      },
    );
  }
  return url.origin;
}

export class UwbRecorderReadOnlyProxy {
  constructor(options = {}) {
    this.baseUrl = assertLoopback4173(
      options.baseUrl ?? "http://127.0.0.1:4173",
    );
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async query(operation, argumentsValue = {}) {
    const path = LIVE_PATHS[operation];
    if (!path) {
      throw new DigitalKeyAgentError(
        "LIVE_MODE_READ_ONLY",
        `实机模式禁止操作：${operation}`,
        {
          status: 403,
          details: {
            operation,
            allowedOperations: Object.keys(LIVE_PATHS),
          },
        },
      );
    }
    const url = new URL(path, this.baseUrl);
    if (operation === "recorder.measurements.list") {
      const mapping = {
        limit: "limit",
        device: "device",
        sinceMs: "since_ms",
        sessionId: "session_id",
      };
      for (const [name, queryName] of Object.entries(mapping)) {
        const value = argumentsValue[name];
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(queryName, String(value));
        }
      }
    }

    let response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new DigitalKeyAgentError(
        "RECORDER_UNAVAILABLE",
        `无法读取 UWB Lab：${error.message}`,
        {
          status: 503,
          retryable: true,
          details: { url: url.toString() },
        },
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new DigitalKeyAgentError(
        "RECORDER_INVALID_RESPONSE",
        "UWB Lab 返回的不是有效 JSON",
        {
          status: 502,
          retryable: true,
          details: { status: response.status },
        },
      );
    }
    if (!response.ok || payload?.ok === false) {
      throw new DigitalKeyAgentError(
        payload?.error?.code ?? "RECORDER_REQUEST_FAILED",
        payload?.error?.message ?? `UWB Lab 返回 HTTP ${response.status}`,
        {
          status: response.status || 502,
          retryable: payload?.error?.retryable ?? response.status >= 500,
          details: payload?.error?.details ?? null,
        },
      );
    }
    return payload?.ok === true ? payload.data : payload;
  }
}

