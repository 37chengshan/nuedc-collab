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
    await expect(page.getByText("填写", { exact: true })).toBeVisible();
    await expect(writes).toEqual([]);
  });

  test("提交依次经过查看、填写、复核、确认、结果，最终点击即发送 confirmed", async ({ page }) => {
    const bodies: Array<Record<string, unknown>> = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/git/commit" && request.method() === "POST") {
        bodies.push(request.postDataJSON() as Record<string, unknown>);
      }
    });

    await page.goto("/");
    await openGitWizard(page, /^提交$/);
    await page.getByRole("button", { name: /下一步|继续/ }).click();
    await page.getByLabel("比赛管理/任务/T-20260729-TEST.json").check();
    await page.getByLabel(/提交说明|提交信息/).fill("test: 五步确认");
    await page.getByRole("button", { name: /下一步|继续/ }).click();
    await expect(page.getByText(/复核|第 3 步/).first()).toBeVisible();
    await page.getByRole("button", { name: /下一步|继续/ }).click();
    await expect(page.getByText(/确认|第 4 步/).first()).toBeVisible();
    await expect(page.getByText(/点击“确认提交”后执行/)).toBeVisible();
    await page.getByRole("button", { name: /确认执行|确认提交/ }).click();
    await expect(page.getByText("已完成", { exact: true })).toBeVisible();
    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0]).toMatchObject({ confirmed: true });
    expect(bodies[0].expectedHead).toBeTruthy();
    expect(bodies[0].expectedChangesHash).toBeTruthy();
  });

  test("状态过期后可刷新并保留提交内容再次确认", async ({ page }) => {
    let attempts = 0;
    await page.route("**/api/git/commit", async (route) => {
      attempts += 1;
      if (attempts === 1) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            operation: "commit",
            code: "STALE_GIT_STATE",
            impact: "确认后文件或 Git 状态发生了变化，本次操作没有执行。",
            nextStep: "点击“刷新状态并重新确认”。",
            summary: "选中文件内容摘要已变化",
            state: {
              worktree: "dirty",
              topology: "ahead",
              connection: "online",
              head: "1".repeat(40),
              remoteHead: "0".repeat(40),
              ahead: 1,
              behind: 0,
              severity: "ahead",
              dirtyFiles: ["比赛管理/任务/T-20260729-TEST.json"],
              lastCheckedAt: "2026-07-29T12:00:00+08:00",
            },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          operation: "commit",
          summary: "提交成功",
          state: {
            worktree: "clean",
            topology: "ahead",
            connection: "online",
            head: "2".repeat(40),
            remoteHead: "0".repeat(40),
            ahead: 2,
            behind: 0,
            severity: "ahead",
            lastCheckedAt: "2026-07-29T12:00:01+08:00",
          },
        }),
      });
    });

    await page.goto("/");
    await openGitWizard(page, /^提交$/);
    await page.getByRole("button", { name: /下一步|继续/ }).click();
    await page.getByLabel("比赛管理/任务/T-20260729-TEST.json").check();
    await page.getByLabel(/提交说明|提交信息/).fill("fix: 保留提交说明");
    await page.getByRole("button", { name: /下一步|继续/ }).click();
    await page.getByRole("button", { name: /下一步|继续/ }).click();
    await page.getByRole("button", { name: "确认提交" }).click();

    await expect(page.getByText("STALE_GIT_STATE", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "刷新状态并重新确认" }).click();
    await expect(page.getByText("说明：fix: 保留提交说明", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "确认提交" }).click();
    await expect(page.getByText("已完成", { exact: true })).toBeVisible();
    expect(attempts).toBe(2);
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
    await page.getByRole("button", { name: "展开仓库同步" }).click();
    await expect(page.getByRole("button", { name: /^拉取$/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: /^推送$/ })).toBeDisabled();
  });
});
