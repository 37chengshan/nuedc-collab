export type AgentArguments = Record<string, unknown>;

interface AgentEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
    details?: unknown;
  };
}

export interface DigitalKeyAgentClient {
  registry<T = unknown>(): Promise<T>;
  operation<T = unknown>(operationId: string): Promise<T>;
  query<T = unknown>(
    operation: string,
    argumentsValue?: AgentArguments,
  ): Promise<T>;
  plan<T = unknown>(
    operation: string,
    argumentsValue?: AgentArguments,
    idempotencyKey?: string,
  ): Promise<T>;
  execute<T = unknown>(
    operation: string,
    argumentsValue?: AgentArguments,
    options?: { idempotencyKey?: string },
  ): Promise<T>;
  cancel<T = unknown>(operationId: string): Promise<T>;
  events<T = unknown>(after?: number, limit?: number): Promise<T>;
  subscribe(
    listener: (event: MessageEvent) => void,
    options?: { after?: number; operationId?: string },
  ): () => void;
  createIdempotencyKey(operation: string): string;
}

const endpoint = {
  registry: "/api/agent/v1/registry",
  query: "/api/agent/v1/query",
  plan: "/api/agent/v1/commands:plan",
  execute: "/api/agent/v1/commands:execute",
  events: "/api/agent/v1/events",
} as const;

function createIdempotencyKey(operation: string) {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `digital-key-ui-${operation.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}-${suffix}`;
}

function createRequestId(operation: string) {
  return `ui-request-${operation.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? ((await response.json()) as AgentEnvelope<T> | T)
    : ((await response.text()) as T);

  if (!response.ok) {
    const envelope = payload as AgentEnvelope<T>;
    throw new Error(
      envelope.error?.message ?? `Agent 服务返回 HTTP ${response.status}`,
    );
  }

  if (payload && typeof payload === "object" && "ok" in payload) {
    const envelope = payload as AgentEnvelope<T>;
    if (!envelope.ok) {
      throw new Error(envelope.error?.message ?? "Agent 操作失败");
    }
    return envelope.data as T;
  }
  return payload as T;
}

function planIdOf(plan: unknown) {
  if (!plan || typeof plan !== "object") {
    return undefined;
  }
  const value = plan as Record<string, unknown>;
  const planId = value.planId ?? value.commandPlanId ?? value.id;
  return typeof planId === "string" ? planId : undefined;
}

export function createAgentClient(): DigitalKeyAgentClient {
  return {
    registry: () => request(endpoint.registry),

    operation: (operationId) =>
      request(
        `/api/agent/v1/operations/${encodeURIComponent(operationId)}`,
      ),

    query: (operation, argumentsValue = {}) =>
      request(endpoint.query, {
        method: "POST",
        body: JSON.stringify({
          operation,
          arguments: argumentsValue,
          requestId: createRequestId(operation),
        }),
      }),

    plan: (operation, argumentsValue = {}, idempotencyKey) =>
      request(endpoint.plan, {
        method: "POST",
        body: JSON.stringify({
          operation,
          arguments: argumentsValue,
          requestId: createRequestId(operation),
          idempotencyKey:
            idempotencyKey ?? createIdempotencyKey(`${operation}-plan`),
        }),
      }),

    async execute(operation, argumentsValue = {}, options = {}) {
      const idempotencyKey =
        options.idempotencyKey ?? createIdempotencyKey(operation);
      const requestId = createRequestId(operation);
      const plan = await request(endpoint.plan, {
        method: "POST",
        body: JSON.stringify({
          operation,
          arguments: argumentsValue,
          requestId,
          idempotencyKey,
        }),
      });
      return request(endpoint.execute, {
        method: "POST",
        body: JSON.stringify({
          operation,
          arguments: argumentsValue,
          requestId,
          idempotencyKey,
          planId: planIdOf(plan),
        }),
      });
    },

    async cancel(operationId) {
      return request(
        `/api/agent/v1/operations/${encodeURIComponent(operationId)}:cancel`,
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );
    },

    events: (after = 0, limit = 200) => {
      const search = new URLSearchParams({
        after: String(after),
        limit: String(limit),
      });
      return request(`${endpoint.events}?${search}`);
    },

    subscribe(listener, options = {}) {
      const search = new URLSearchParams({ stream: "true" });
      if (options.after !== undefined) {
        search.set("after", String(options.after));
      }
      if (options.operationId) {
        search.set("operationId", options.operationId);
      }
      const source = new EventSource(`${endpoint.events}?${search}`);
      source.onmessage = listener;
      for (const type of [
        "state.changed",
        "operation.queued",
        "operation.started",
        "operation.succeeded",
        "operation.failed",
        "operation.cancelled",
      ]) {
        source.addEventListener(type, listener as EventListener);
      }
      return () => source.close();
    },

    createIdempotencyKey,
  };
}

export const agentClient = createAgentClient();

if (typeof window !== "undefined") {
  window.digitalKeyAgent = {
    ...(window.digitalKeyAgent ?? {}),
    v1: agentClient,
  };
}
