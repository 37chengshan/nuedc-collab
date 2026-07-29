import { expect, test } from "./fixtures/dashboard";

async function openGitWizard(page: import("@playwright/test").Page, action: RegExp) {
  await page.getByRole("button", { name: action }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

test.describe("Git 五步确认", () => {
  test("未完成确认前不发送 Git 写请求，且不可越级", async ({ page }) => {
    const writes: string[] = [];
    await page.route("**/api/git/{pull,commit,push}", async (route) => {
      writes.push(new URL(route.request().url()).pathname);
      await route.fulfill({ status: 500, body: "不应在未确认阶段调用" });
    });

    await page.goto("/");
    await openGitWizard(page, /^提交$/);
    await expect(page.getByText(/查看|第 1 步/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /确认执行|确认提交/ })).toHaveCount(0);

    const next = page.getByRole("button", { name: /下一步|继续/ });
    await next.click();
    await expect(page.getByText(/填写|第 2 步/)).toBeVisible();
    await expect(writes).toEqual([]);
  });

  test("提交依次经过查看、填写、复核、确认、结果，并在确认后发送 confirmed", async ({ page }) => {
    const bodies: Array<Record<string, unknown>> = [];
    await page.route("**/api/git/commit", async (route) => {
      bodies.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          operation: "commit",
          summary: "提交已完成",
          state: { worktree: "clean", topology: "ahead", connection: "online", severity: "ahead" },
        }),
      });
    });

    await page.goto("/");
    await openGitWizard(page, /^提交$/);
    await page.getByRole("button", { name: /下一步|继续/ }).click();
    await page.getByLabel(/提交说明|提交信息/).fill("test: 五步确认");
    await page.getByRole("button", { name: /下一步|继续/ }).click();
    await expect(page.getByText(/复核|第 3 步/).first()).toBeVisible();
    await page.getByRole("button", { name: /下一步|继续/ }).click();
    await expect(page.getByText(/确认|第 4 步/).first()).toBeVisible();
    await page.getByLabel(/我已阅读影响/).check();
    await page.getByRole("button", { name: /确认执行|确认提交/ }).click();
    await expect(page.getByText(/结果|提交已完成|已完成/)).toBeVisible();
    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0]).toMatchObject({ confirmed: true });
    expect(bodies[0].expectedHead).toBeTruthy();
    expect(bodies[0].expectedChangesHash).toBeTruthy();
  });

  test("冲突状态会明确阻止危险 Git 操作并显示处理提示", async ({ page }) => {
    await page.route("**/api/git/status", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        worktree: "conflict",
        topology: "diverged",
        connection: "online",
        head: "1".repeat(40),
        remoteHead: "2".repeat(40),
        ahead: 1,
        behind: 1,
        severity: "conflict",
        lastCheckedAt: "2026-07-29T09:30:00+08:00",
        conflictFiles: ["比赛管理/任务/T-20260729-TEST.json"],
        summary: "存在合并冲突，必须人工处理。",
      }),
    }));

    await page.goto("/");
    await expect(page.getByText(/冲突|必须人工处理/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /^拉取$/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: /^推送$/ })).toBeDisabled();
  });
});
