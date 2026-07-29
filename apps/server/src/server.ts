import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOMAIN_ACTIONS,
  computeRevision,
  createProtocolRuntime,
  localSettingsPath,
  type DomainActionName,
  type ProtocolRuntime,
  type RecordEnvelope,
} from "@nuedc/protocol";
import {
  listDesign,
  listMaterials,
  readDesignContent,
  readMaterialContent,
  type WarningItem,
} from "./content.js";
import { createGitApi } from "./git.js";
import { ensureLocalIdentity } from "./identity.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3210;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const VALID_ACTIONS = new Set<string>(DOMAIN_ACTIONS);

interface ErrorBody {
  code: string;
  impact: string;
  nextStep: string;
  details: string;
}

interface StartServerOptions {
  host?: string;
  port?: number;
  repoRoot?: string;
  authToken?: string;
  githubUsernameDetector?: () => Promise<string | null>;
}

interface StartedServer {
  server: Server;
  port: number;
  host: string;
  repoRoot: string;
  localAuthToken: string;
  close(): Promise<void>;
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

function validateHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  try {
    const parsed = new URL(`http://${hostHeader}`);
    return isLocalHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function validateOrigin(originHeader: string | undefined): boolean {
  if (!originHeader) return true;
  try {
    const parsed = new URL(originHeader);
    return parsed.protocol === "http:" && isLocalHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function sameToken(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
  options: { origin?: string; authToken?: string } = {},
): void {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (options.origin) {
    headers["Access-Control-Allow-Origin"] = options.origin;
    headers.Vary = "Origin";
  }
  if (options.authToken) {
    headers["X-Local-Auth"] = options.authToken;
  }
  response.writeHead(status, headers);
  response.end(JSON.stringify(payload));
}

function responseOptions(origin: string | undefined, authToken?: string): { origin?: string; authToken?: string } {
  return {
    ...(origin ? { origin } : {}),
    ...(authToken ? { authToken } : {}),
  };
}

function mergeWarnings(
  warnings: WarningItem[],
  invalidFiles: Array<{ path: string; error: string }> = [],
): WarningItem[] {
  return [
    ...warnings,
    ...invalidFiles.map((item) => ({
      code: "INVALID_FILE",
      message: item.error,
      target: item.path,
    })),
  ];
}

function actionFailureStatus(code: string): number {
  switch (code) {
    case "STALE_ENTITY":
    case "IDEMPOTENCY_KEY_REUSED":
      return 409;
    case "OWNER_MISMATCH":
    case "INACTIVE_MEMBER":
      return 403;
    case "ACTION_NOT_SUPPORTED":
      return 404;
    case "ACTION_VALIDATION_FAILED":
    default:
      return 400;
  }
}

function actionFailureBody(action: string, idempotencyKey: string, code: string, message: string) {
  const impactByCode: Record<string, string> = {
    ACTION_VALIDATION_FAILED: "动作请求未通过协议校验。",
    ACTION_NOT_SUPPORTED: "当前服务不支持该动作。",
    STALE_ENTITY: "目标记录已经变化，当前提交不再安全。",
    IDEMPOTENCY_KEY_REUSED: "幂等键已用于其他请求，当前请求被拒绝。",
    OWNER_MISMATCH: "当前成员无权执行该动作。",
    INACTIVE_MEMBER: "当前本机成员未激活，禁止继续写入。",
    PROMOTED_TASK_ALREADY_EXISTS: "该想法已提升为任务。",
  };
  const nextStepByCode: Record<string, string> = {
    ACTION_VALIDATION_FAILED: "检查 payload、revision 与幂等键后重试。",
    ACTION_NOT_SUPPORTED: "改用 capabilities 中声明的领域动作。",
    STALE_ENTITY: "重新读取最新记录并再次确认后重试。",
    IDEMPOTENCY_KEY_REUSED: "为新请求生成新的幂等键。",
    OWNER_MISMATCH: "确认负责人或切换到有权限的成员后重试。",
    INACTIVE_MEMBER: "先在成员记录中恢复激活状态。",
    PROMOTED_TASK_ALREADY_EXISTS: "使用返回的现有任务继续协作。",
  };
  return {
    ok: false,
    action,
    idempotencyKey,
    code,
    error: {
      impact:
        code === "OWNER_MISMATCH" || code === "INACTIVE_MEMBER"
          ? message
          : impactByCode[code] ?? "动作执行失败。",
      nextStep: nextStepByCode[code] ?? "检查请求后重试。",
      details: message,
    },
    warnings: [],
    nextActions: [],
  };
}

async function maybeReadActor(runtime: ProtocolRuntime): Promise<string | undefined> {
  try {
    const settings = await runtime.repository.readLocalSettings();
    return settings.githubUsername;
  } catch {
    return undefined;
  }
}

async function findTask(runtime: ProtocolRuntime, id: string) {
  const result = await runtime.repository.listTasks();
  return result.items.find((item) => item.data.id === id) ?? null;
}

async function findIssue(runtime: ProtocolRuntime, id: string) {
  const result = await runtime.repository.listIssues();
  return result.items.find((item) => item.data.id === id) ?? null;
}

async function findIdea(runtime: ProtocolRuntime, id: string) {
  const result = await runtime.repository.listIdeas();
  return result.items.find((item) => item.data.id === id) ?? null;
}

function mapCapabilities(raw: Awaited<ReturnType<ProtocolRuntime["actions"]["capabilities"]>>) {
  return {
    protocolVersion: 1 as const,
    actor: raw.actor,
    actions: raw.actions.map((action) => ({
      name: action.action,
      description: action.label,
      requiresRevision: action.requiresRevision,
      requiresIdempotencyKey: true as const,
      schemaRef: `/api/schemas/actions/${encodeURIComponent(action.action)}`,
    })),
    domAutomationAllowed: false as const,
    directFileMutationAllowed: false as const,
    gitConfirmationRequired: true as const,
  };
}

async function withLatestEntity(runtime: ProtocolRuntime, action: string, id: string) {
  if (action.startsWith("task.")) return findTask(runtime, id);
  if (action.startsWith("issue.")) return findIssue(runtime, id);
  if (action.startsWith("idea.")) return findIdea(runtime, id);
  return null;
}

export async function startServer(options: StartServerOptions = {}): Promise<StartedServer> {
  const repoRoot = path.resolve(options.repoRoot ?? REPO_ROOT);
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const localAuthToken = options.authToken ?? randomBytes(24).toString("hex");
  const runtime = await createProtocolRuntime(repoRoot);
  await ensureLocalIdentity(runtime.repository, options.githubUsernameDetector);
  const git = createGitApi(repoRoot);

  const server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (!validateHost(request.headers.host)) {
      sendJson(response, 400, {
        code: "INVALID_HOST",
        impact: "请求 Host 非本地地址，已被拒绝。",
        nextStep: "仅通过 127.0.0.1 或 localhost 访问本地服务。",
        details: "Host 必须是本地回环地址。",
      });
      return;
    }
    if (!validateOrigin(origin)) {
      sendJson(response, 403, {
        code: "INVALID_ORIGIN",
        impact: "请求来源不是本地页面，已被拒绝。",
        nextStep: "仅从本机 dashboard 或本地开发页面访问该服务。",
        details: "Origin 必须是 http://127.0.0.1:* 或 http://localhost:*。",
      });
      return;
    }

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": origin ?? `http://${host}:${port}`,
        "Access-Control-Allow-Headers": "Content-Type, X-Local-Auth",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      });
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    const pathname = url.pathname;

    const requireAuth = pathname.startsWith("/api/") && pathname !== "/api/health";
    if (requireAuth && !sameToken(localAuthToken, request.headers["x-local-auth"] as string | undefined)) {
      sendJson(
        response,
        401,
        {
          code: "LOCAL_AUTH_REQUIRED",
          impact: "缺少有效的本地鉴权令牌。",
          nextStep: "先调用 /api/health 获取最新 X-Local-Auth，再重试请求。",
          details: "仅接受当前服务进程签发的本地会话令牌。",
        },
        responseOptions(origin),
      );
      return;
    }

    try {
      if (pathname === "/api/health" && request.method === "GET") {
        const actor = await maybeReadActor(runtime);
        sendJson(
          response,
          200,
          {
            ok: true,
            ...(actor ? { actor } : {}),
            sessionRequired: true,
            localAuthToken,
          },
          responseOptions(origin, localAuthToken),
        );
        return;
      }

      if (pathname === "/api/tasks" && request.method === "GET") {
        const result = await runtime.repository.listTasks();
        sendJson(response, 200, { items: result.items, warnings: mergeWarnings(result.warnings, result.invalidFiles) }, responseOptions(origin));
        return;
      }
      if (pathname.startsWith("/api/tasks/") && request.method === "GET") {
        const id = decodeURIComponent(pathname.slice("/api/tasks/".length));
        const item = await findTask(runtime, id);
        if (!item) {
          sendJson(response, 404, { code: "TASK_NOT_FOUND", impact: "未找到任务记录。", nextStep: "检查任务 ID 是否正确。", details: id }, responseOptions(origin));
          return;
        }
        sendJson(response, 200, item, responseOptions(origin));
        return;
      }

      if (pathname === "/api/issues" && request.method === "GET") {
        const result = await runtime.repository.listIssues();
        sendJson(response, 200, { items: result.items, warnings: mergeWarnings(result.warnings, result.invalidFiles) }, responseOptions(origin));
        return;
      }
      if (pathname.startsWith("/api/issues/") && request.method === "GET") {
        const id = decodeURIComponent(pathname.slice("/api/issues/".length));
        const item = await findIssue(runtime, id);
        if (!item) {
          sendJson(response, 404, { code: "ISSUE_NOT_FOUND", impact: "未找到问题记录。", nextStep: "检查问题 ID 是否正确。", details: id }, responseOptions(origin));
          return;
        }
        sendJson(response, 200, item, responseOptions(origin));
        return;
      }

      if (pathname === "/api/ideas" && request.method === "GET") {
        const result = await runtime.repository.listIdeas();
        sendJson(response, 200, { items: result.items, warnings: mergeWarnings(result.warnings, result.invalidFiles) }, responseOptions(origin));
        return;
      }
      if (pathname.startsWith("/api/ideas/") && request.method === "GET") {
        const id = decodeURIComponent(pathname.slice("/api/ideas/".length));
        const item = await findIdea(runtime, id);
        if (!item) {
          sendJson(response, 404, { code: "IDEA_NOT_FOUND", impact: "未找到想法记录。", nextStep: "检查想法 ID 是否正确。", details: id }, responseOptions(origin));
          return;
        }
        sendJson(response, 200, item, responseOptions(origin));
        return;
      }

      if (pathname === "/api/events" && request.method === "GET") {
        const result = await runtime.repository.listEvents();
        const entityType = url.searchParams.get("entityType");
        const entityId = url.searchParams.get("entityId");
        const items = result.items.filter((item) => {
          if (entityType && item.data.entityType !== entityType) return false;
          if (entityId && item.data.entityId !== entityId) return false;
          return true;
        });
        sendJson(response, 200, { items, warnings: mergeWarnings(result.warnings, result.invalidFiles) }, responseOptions(origin));
        return;
      }

      if (pathname === "/api/members" && request.method === "GET") {
        const result = await runtime.repository.listMembers();
        sendJson(response, 200, { items: result.items, warnings: mergeWarnings(result.warnings, result.invalidFiles) }, responseOptions(origin));
        return;
      }

      if (pathname === "/api/settings" && request.method === "GET") {
        const settings = await runtime.repository.readLocalSettings();
        const envelope: RecordEnvelope<typeof settings> = {
          data: settings,
          relativePath: path.relative(repoRoot, localSettingsPath(repoRoot)).split(path.sep).join("/"),
          revision: computeRevision(settings),
        };
        sendJson(response, 200, envelope, responseOptions(origin));
        return;
      }

      if (pathname === "/api/capabilities" && request.method === "GET") {
        const capabilities = await runtime.actions.capabilities("server");
        sendJson(response, 200, mapCapabilities(capabilities), responseOptions(origin));
        return;
      }

      if (pathname.startsWith("/api/schemas/actions/") && request.method === "GET") {
        const action = decodeURIComponent(pathname.slice("/api/schemas/actions/".length));
        if (!VALID_ACTIONS.has(action)) {
          sendJson(response, 404, {
            code: "ACTION_NOT_SUPPORTED",
            impact: "未找到该领域动作的 Schema。",
            nextStep: "从 capabilities 列表中选择有效动作。",
            details: action,
          }, responseOptions(origin));
          return;
        }
        sendJson(response, 200, runtime.actions.actionSchema(action as DomainActionName), responseOptions(origin));
        return;
      }

      if (pathname.startsWith("/api/actions/") && request.method === "POST") {
        const action = decodeURIComponent(pathname.slice("/api/actions/".length));
        const body = (await readJsonBody(request)) as { idempotencyKey?: string; expectedRevision?: string; payload?: unknown };
        if (action.startsWith("git.") || !VALID_ACTIONS.has(action)) {
          sendJson(
            response,
            404,
            actionFailureBody(action, typeof body.idempotencyKey === "string" ? body.idempotencyKey : "invalid", "ACTION_NOT_SUPPORTED", "通用动作接口不接受 git.* 或未知动作。"),
            responseOptions(origin),
          );
          return;
        }
        const result = await runtime.actions.execute("server", action as DomainActionName, {
          idempotencyKey: body.idempotencyKey ?? "",
          ...(body.expectedRevision ? { expectedRevision: body.expectedRevision } : {}),
          payload: body.payload ?? {},
        });
        if (result.ok) {
          sendJson(response, 200, result, responseOptions(origin));
          return;
        }
        const payload = actionFailureBody(action, result.idempotencyKey, result.error?.code ?? "ACTION_VALIDATION_FAILED", result.error?.message ?? "动作执行失败");
        if (result.entities[0]) {
          const latest = await withLatestEntity(runtime, action, result.entities[0].id);
          if (latest) {
            Object.assign(payload, { latestEntity: latest });
          }
        }
        sendJson(response, actionFailureStatus(result.error?.code ?? "ACTION_VALIDATION_FAILED"), payload, responseOptions(origin));
        return;
      }

      if (pathname === "/api/git/status" && request.method === "GET") {
        sendJson(response, 200, await git.status(), responseOptions(origin));
        return;
      }
      if (pathname === "/api/git/log" && request.method === "GET") {
        sendJson(response, 200, await git.log(), responseOptions(origin));
        return;
      }
      if (pathname === "/api/git/diff" && request.method === "GET") {
        sendJson(response, 200, await git.diff(url.searchParams.get("commit") ?? undefined), responseOptions(origin));
        return;
      }
      if (pathname === "/api/git/fetch" && request.method === "POST") {
        sendJson(response, 200, await git.fetch(), responseOptions(origin));
        return;
      }
      if (pathname === "/api/git/pull" && request.method === "POST") {
        const body = (await readJsonBody(request)) as { confirmed?: true; expectedHead?: string | null; expectedRemoteHead?: string | null };
        const result = await git.pull(body);
        sendJson(response, result.ok ? 200 : 400, result, responseOptions(origin));
        return;
      }
      if (pathname === "/api/git/commit" && request.method === "POST") {
        const body = (await readJsonBody(request)) as {
          confirmed?: true;
          expectedHead?: string | null;
          expectedChangesHash?: string;
          files?: string[];
          message?: string;
        };
        const result = await git.commit(body);
        sendJson(response, result.ok ? 200 : 400, result, responseOptions(origin));
        return;
      }
      if (pathname === "/api/git/push" && request.method === "POST") {
        const body = (await readJsonBody(request)) as { confirmed?: true; expectedHead?: string | null; expectedRemoteHead?: string | null };
        const result = await git.push(body);
        sendJson(response, result.ok ? 200 : 400, result, responseOptions(origin));
        return;
      }

      if (pathname === "/api/materials" && request.method === "GET") {
        sendJson(response, 200, await listMaterials(repoRoot), responseOptions(origin));
        return;
      }
      if (pathname === "/api/materials/content" && request.method === "GET") {
        const relativePath = url.searchParams.get("path") ?? "";
        const content = await readMaterialContent(repoRoot, relativePath);
        sendJson(response, 200, content, responseOptions(origin));
        return;
      }

      if (pathname === "/api/design" && request.method === "GET") {
        const events = await runtime.repository.listEvents();
        const issues = await runtime.repository.listIssues();
        const design = await listDesign(repoRoot, {
          issueIds: issues.items.map((item) => item.data.id),
          decisionEventIds: events.items.filter((item) => item.data.kind === "decision").map((item) => item.data.id),
        });
        sendJson(response, 200, design, responseOptions(origin));
        return;
      }
      if (pathname === "/api/design/content" && request.method === "GET") {
        const relativePath = url.searchParams.get("path") ?? "";
        const content = await readDesignContent(repoRoot, relativePath);
        sendJson(response, 200, content, responseOptions(origin));
        return;
      }

      sendJson(response, 404, {
        code: "NOT_FOUND",
        impact: "未找到对应的 API 路由。",
        nextStep: "检查请求路径或参考 capabilities/resources 契约。",
        details: pathname,
      }, responseOptions(origin));
    } catch (error) {
      if (typeof error === "object" && error !== null && "status" in error && "body" in error) {
        const typed = error as { status: number; body: unknown };
        sendJson(response, typed.status, typed.body, responseOptions(origin));
        return;
      }
      const details = error instanceof Error ? error.message : String(error);
      const isPathError = /路径|白名单|仅支持/.test(details);
      sendJson(response, isPathError ? 400 : 500, {
        code: isPathError ? "INVALID_PATH" : "INTERNAL_SERVER_ERROR",
        impact: isPathError ? "请求的文件路径不合法或不在允许范围内。" : "服务端处理请求时发生异常。",
        nextStep: isPathError ? "检查 path 参数并限制在允许目录内。" : "查看技术详情并修复环境后重试。",
        details,
      }, responseOptions(origin));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  return {
    server,
    host,
    repoRoot,
    localAuthToken,
    port: address && typeof address === "object" ? address.port : port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export { DEFAULT_HOST, DEFAULT_PORT };
