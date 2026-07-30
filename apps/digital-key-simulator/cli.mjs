#!/usr/bin/env node

const DEFAULT_API = "http://127.0.0.1:4180";
const SCHEMA_VERSION = "1.0.0";

function envelope(data) {
  return {
    ok: true,
    data,
    meta: {
      schemaVersion: SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
    },
  };
}

function parseArguments(argv) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags[name] = true;
      continue;
    }
    flags[name] = next;
    index += 1;
  }
  return { positionals, flags };
}

function parseJsonFlag(value, name) {
  if (value === undefined) {
    return {};
  }
  try {
    const parsed = JSON.parse(String(value));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("must be an object");
    }
    return parsed;
  } catch (error) {
    throw Object.assign(
      new Error(`--${name} 必须是 JSON 对象: ${error.message}`),
      { code: "VALIDATION_ERROR", exitCode: 3 },
    );
  }
}

function idempotencyKey(operation) {
  return `digital-key-cli-${operation}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
}

async function request(api, path, options = {}) {
  const response = await fetch(new URL(path, `${api.replace(/\/$/, "")}/`), {
    method: options.method ?? "GET",
    headers: {
      Accept: options.sse ? "text/event-stream" : "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (options.sse) {
    if (!response.ok || !response.body) {
      throw Object.assign(new Error(`HTTP ${response.status}`), {
        code: "HTTP_ERROR",
        exitCode: 1,
      });
    }
    for await (const chunk of response.body) {
      process.stdout.write(chunk);
    }
    return null;
  }

  const payload = await response.json().catch(() => ({
    ok: false,
    error: {
      code: "INVALID_RESPONSE",
      message: `服务返回了非 JSON 内容 (HTTP ${response.status})`,
      retryable: false,
    },
  }));
  if (!response.ok && payload.ok !== false) {
    payload.ok = false;
  }
  return payload;
}

async function main() {
  const { positionals, flags } = parseArguments(process.argv.slice(2));
  const command = positionals[0] ?? "help";
  const api = String(flags.api ?? process.env.DIGITAL_KEY_API ?? DEFAULT_API);

  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(
      `${JSON.stringify(
        envelope({
          name: "digital-key",
          defaultApi: DEFAULT_API,
          commands: [
            "registry",
            "schema",
            "query",
            "plan",
            "execute",
            "snapshot",
            "scenario",
            "diagnose",
            "events",
            "operation",
          ],
          usage: {
            registry: "digital-key registry [operation] [--api URL]",
            query:
              "digital-key query --operation NAME [--args JSON] [--api URL]",
            execute:
              "digital-key execute --operation NAME --args JSON --idempotency-key KEY",
          },
        }),
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  if (command === "registry" || command === "schema") {
    const operation =
      positionals[1] ?? (typeof flags.operation === "string" ? flags.operation : "");
    const path = operation
      ? `/api/agent/v1/registry/${encodeURIComponent(operation)}`
      : "/api/agent/v1/registry";
    return output(await request(api, path));
  }

  if (command === "operation") {
    const id = positionals[1] ?? flags.id;
    if (!id) {
      throw Object.assign(new Error("operation 需要操作 ID"), {
        code: "VALIDATION_ERROR",
        exitCode: 3,
      });
    }
    return output(
      await request(
        api,
        `/api/agent/v1/operations/${encodeURIComponent(String(id))}`,
      ),
    );
  }

  if (command === "events") {
    const search = new URLSearchParams();
    if (flags.after) {
      search.set("after", String(flags.after));
    }
    if (flags.operation) {
      search.set("operationId", String(flags.operation));
    }
    await request(api, `/api/agent/v1/events?${search}`, { sse: true });
    return 0;
  }

  const aliases = {
    snapshot: { kind: "query", operation: "lock.snapshot.get" },
    scenario: { kind: "execute", operation: "simulation.scenario.run" },
    diagnose: { kind: "execute", operation: "diagnostics.run.start" },
  };
  const alias = aliases[command];
  const kind = alias?.kind ?? command;
  if (!["query", "plan", "execute"].includes(kind)) {
    throw Object.assign(new Error(`未知命令: ${command}`), {
      code: "VALIDATION_ERROR",
      exitCode: 3,
    });
  }

  const operation = String(alias?.operation ?? flags.operation ?? "");
  if (!operation) {
    throw Object.assign(new Error(`${command} 需要 --operation`), {
      code: "VALIDATION_ERROR",
      exitCode: 3,
    });
  }
  const argumentsValue = parseJsonFlag(flags.args, "args");
  const body = {
    operation,
    arguments: argumentsValue,
    requestId:
      typeof flags["request-id"] === "string"
        ? flags["request-id"]
        : undefined,
  };
  if (kind !== "query") {
    body.idempotencyKey =
      typeof flags["idempotency-key"] === "string"
        ? flags["idempotency-key"]
        : idempotencyKey(operation);
    if (typeof flags.revision === "string") {
      body.revision = flags.revision;
    }
    if (typeof flags["plan-id"] === "string") {
      body.planId = flags["plan-id"];
    }
  }

  const path =
    kind === "query"
      ? "/api/agent/v1/query"
      : kind === "plan"
        ? "/api/agent/v1/commands:plan"
        : "/api/agent/v1/commands:execute";
  return output(await request(api, path, { method: "POST", body }));
}

function output(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (payload?.ok === false) {
    return payload.error?.code === "VALIDATION_ERROR" ? 3 : 1;
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        error: {
          code: error.code ?? "CLI_ERROR",
          message: error.message,
          retryable: false,
        },
        meta: {
          schemaVersion: SCHEMA_VERSION,
          timestamp: new Date().toISOString(),
        },
      })}\n`,
    );
    process.exitCode = error.exitCode ?? 1;
  });
