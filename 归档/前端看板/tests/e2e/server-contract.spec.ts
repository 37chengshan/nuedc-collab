import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const apiBaseURL = process.env.E2E_API_BASE_URL;
const cliCommand = process.env.E2E_AGENT_CLI_COMMAND;
const execFileAsync = promisify(execFile);

function api(path: string) {
  if (!apiBaseURL) throw new Error("E2E_API_BASE_URL is required for server contract tests.");
  return new URL(path, apiBaseURL).toString();
}

test.describe("本地 API、Agent CLI 与边界安全", () => {
  test.skip(!apiBaseURL, "集成服务未启动：设置 E2E_API_BASE_URL 后执行真实 HTTP 安全验收。");

  test("Host、Origin 和本地鉴权失败路径均被拒绝", async ({ request }) => {
    const host = await request.get(api("/api/health"), {
      headers: { Host: "example.com" },
    });
    expect(host.status()).toBeGreaterThanOrEqual(400);

    const origin = await request.get(api("/api/tasks"), {
      headers: { Origin: "https://example.com" },
    });
    expect(origin.status()).toBeGreaterThanOrEqual(400);

    const auth = await request.get(api("/api/tasks"), {
      headers: { Origin: apiBaseURL!, "X-Local-Auth": "definitely-wrong" },
    });
    expect(auth.status()).toBe(401);
    await expect(auth.json()).resolves.toMatchObject({ code: expect.any(String) });
  });

  test("Agent-native HTTP 能观察 capabilities，且 git 不在通用动作集合", async ({ request }) => {
    const health = await request.get(api("/api/health"));
    expect(health.ok()).toBeTruthy();
    const token = health.headers()["x-local-auth"] || (await health.json()).localAuthToken;
    expect(token).toBeTruthy();

    const capabilities = await request.get(api("/api/capabilities"), {
      headers: { "X-Local-Auth": token },
    });
    expect(capabilities.ok()).toBeTruthy();
    const body = await capabilities.json();
    expect(body).toMatchObject({
      domAutomationAllowed: false,
      directFileMutationAllowed: false,
      gitConfirmationRequired: true,
    });
    expect(body.actions.map((item: { name: string }) => item.name)).toContain("task.create");
    expect(body.actions.map((item: { name: string }) => item.name)).not.toContain("git.commit");
  });

  test("未 confirmed 的 Git 写请求被拒绝，confirmed 状态过期提示冲突", async ({ request }) => {
    const health = await request.get(api("/api/health"));
    const token = health.headers()["x-local-auth"] || (await health.json()).localAuthToken;
    const headers = { "X-Local-Auth": token, "Content-Type": "application/json" };

    const unconfirmed = await request.post(api("/api/git/push"), { headers, data: {} });
    expect(unconfirmed.status()).toBeGreaterThanOrEqual(400);

    const stale = await request.post(api("/api/git/push"), {
      headers,
      data: {
        confirmed: true,
        expectedHead: "0".repeat(40),
        expectedRemoteHead: "0".repeat(40),
      },
    });
    expect(stale.status()).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ code: "STALE_GIT_STATE" });
  });

  test("Agent CLI 输出结构化结果且不能暴露 git 领域动作", async () => {
    test.skip(!cliCommand, "设置 E2E_AGENT_CLI_COMMAND 后执行真实 CLI 验收。");
    const [command, ...args] = cliCommand!.split(/\s+/);
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 15_000,
    });
    const output = `${stdout}\n${stderr}`;
    expect(output).toMatch(/task\.create|capabilities|action/i);
    expect(output).not.toMatch(/\bgit\.(commit|pull|push)\b/i);
  });
});
