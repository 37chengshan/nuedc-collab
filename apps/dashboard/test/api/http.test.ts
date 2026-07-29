import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/api/http";
import { resetSession } from "@/api/session";

afterEach(() => {
  resetSession();
  vi.unstubAllGlobals();
});

describe("apiFetch local session recovery", () => {
  it("服务重启导致 token 失效时只重新协商并重试一次", async () => {
    const requests: Array<{ path: string; token: string | null }> = [];
    let healthCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const headers = new Headers(init?.headers);
      requests.push({ path, token: headers.get("X-Local-Auth") });

      if (path === "/api/health") {
        healthCount += 1;
        return new Response(JSON.stringify({ ok: true, sessionRequired: true }), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Local-Auth": healthCount === 1 ? "old-token" : "new-token" },
        });
      }
      if (headers.get("X-Local-Auth") === "old-token") {
        return new Response(JSON.stringify({
          code: "LOCAL_AUTH_REQUIRED",
          impact: "旧会话已失效",
          nextStep: "重新获取本地会话",
        }), { status: 401, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiFetch<{ ok: boolean }>("/api/tasks")).resolves.toEqual({ ok: true });
    expect(healthCount).toBe(2);
    expect(requests.filter((item) => item.path === "/api/tasks").map((item) => item.token)).toEqual([
      "old-token",
      "new-token",
    ]);
  });

  it("新 token 仍失败时不会无限重试", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/health") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Local-Auth": crypto.randomUUID() },
        });
      }
      return new Response(JSON.stringify({
        code: "LOCAL_AUTH_REQUIRED",
        impact: "会话无效",
        nextStep: "检查本地服务",
      }), { status: 401, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiFetch("/api/tasks")).rejects.toMatchObject({ code: "LOCAL_AUTH_REQUIRED" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
