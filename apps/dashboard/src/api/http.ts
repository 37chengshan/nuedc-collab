import { ensureSession, getAuthToken } from "./session";

export class ApiError extends Error {
  status: number;
  code: string;
  impact: string;
  nextStep: string;
  details: string;
  payload?: unknown;

  constructor(init: {
    status: number;
    code: string;
    impact: string;
    nextStep: string;
    details?: string;
    payload?: unknown;
  }) {
    super(init.impact || init.code);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.impact = init.impact;
    this.nextStep = init.nextStep;
    this.details = init.details || "";
    this.payload = init.payload;
  }
}

function mapStatusToChinese(status: number, body: any): { code: string; impact: string; nextStep: string; details: string } {
  const code = body?.code || body?.error?.code || `HTTP_${status}`;
  const impact = body?.error?.impact || body?.impact || body?.message || `请求失败（${status}）`;
  const nextStep = body?.error?.nextStep || body?.nextStep || "请刷新页面后重试，或查看技术详情。";
  const details = body?.error?.details || body?.technicalDetails || body?.details || "";
  return { code, impact, nextStep, details };
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  options: { auth?: boolean; skipHealth?: boolean } = {},
): Promise<T> {
  const auth = options.auth !== false;
  if (auth && !options.skipHealth) {
    await ensureSession();
  }

  const headers = new Headers(init.headers || {});
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const token = getAuthToken();
  if (auth && token) headers.set("X-Local-Auth", token);

  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text };
    }
  }

  if (!res.ok) {
    const mapped = mapStatusToChinese(res.status, body);
    throw new ApiError({
      status: res.status,
      code: mapped.code,
      impact: mapped.impact,
      nextStep: mapped.nextStep,
      details: mapped.details,
      payload: body,
    });
  }

  return body as T;
}
