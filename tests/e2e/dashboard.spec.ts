import { expect, test } from "./fixtures/dashboard";

const pages = [
  ["/", "工作台"],
  ["/tasks", "任务"],
  ["/issues", "问题"],
  ["/ideas", "想法"],
  ["/history", "提交历史"],
  ["/materials", "参考资料"],
  ["/design", "总体设计"],
  ["/settings", "设置"],
] as const;

async function openCreateDialog(page: import("@playwright/test").Page, name: RegExp) {
  await page.getByRole("button", { name }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

test.describe("八页面协作看板", () => {
  for (const [path, title] of pages) {
    test(`${title}可直接访问并提供主内容地标`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole("main")).toBeVisible();
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    });
  }

  test("工作台展示仓库、任务和问题摘要", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("检查电源轨", { exact: true })).toBeVisible();
    await expect(page.getByText("串口偶发丢帧", { exact: true })).toBeVisible();
    await expect(page.getByText(/有 1 个待提交改动/).first()).toBeVisible();
  });

  test("可创建任务并改变任务状态", async ({ page, dashboard }) => {
    await page.goto("/tasks");
    await openCreateDialog(page, /新建任务|创建任务/);
    await page.getByLabel(/标题/).fill("验收新任务");
    await page.getByLabel(/模块/).fill("测试");
    await page.getByRole("button", { name: /创建|保存/ }).click();
    await expect.poll(() => dashboard.requests.some((item) => item.action === "task.create")).toBe(true);

    const task = page.getByText("检查电源轨", { exact: true });
    await task.click();
    await page.getByRole("combobox", { name: /状态/ }).selectOption("doing");
    await page.getByRole("button", { name: /更新状态|保存/ }).click();
    await expect.poll(() => dashboard.requests.some((item) => item.action === "task.setStatus")).toBe(true);
  });

  test("可创建问题并保存严重度", async ({ page, dashboard }) => {
    await page.goto("/issues");
    await openCreateDialog(page, /新建问题|报告问题/);
    await page.getByLabel(/标题/).fill("验收问题");
    await page.getByLabel(/严重度/).selectOption("high");
    await page.getByRole("button", { name: /创建|保存/ }).click();
    await expect.poll(() => dashboard.requests.some((item) => item.action === "issue.create")).toBe(true);
  });

  test("可创建想法并提升为任务", async ({ page, dashboard }) => {
    await page.goto("/ideas");
    await openCreateDialog(page, /新建想法|创建想法/);
    await page.getByLabel(/标题/).fill("验收想法");
    await page.getByLabel(/模块/).fill("测试");
    await page.getByRole("button", { name: /创建|保存/ }).click();
    await expect.poll(() => dashboard.requests.some((item) => item.action === "idea.create")).toBe(true);

    await page.getByText("增加电源自检", { exact: true }).click();
    await page.getByRole("button", { name: /提升为任务|转为任务/ }).click();
    await expect.poll(() => dashboard.requests.some((item) => item.action === "idea.promoteToTask")).toBe(true);
  });

  test("提交历史可打开只读 diff", async ({ page }) => {
    await page.goto("/history");
    await page.getByText("feat: 初始化协作看板", { exact: true }).click();
    await expect(page.getByText(/README\.md/)).toBeVisible();
    await expect(page.getByText(/\+新内容/)).toBeVisible();
  });

  test("参考资料与总体设计可预览真实 API 资源", async ({ page }) => {
    await page.goto("/materials");
    await page.getByText("焊接与调试教程", { exact: true }).click();
    await expect(page.getByText(/先检查焊点/)).toBeVisible();

    await page.goto("/design");
    await page.getByText("系统总体方案", { exact: true }).click();
    await expect(page.getByText("视觉模块", { exact: true })).toBeVisible();
  });

  test("HTML 资料只在无权限沙箱 iframe 中预览", async ({ page }) => {
    await page.goto("/materials");
    await page.getByText("主板焊接教程 HTML", { exact: true }).click();
    const frame = page.getByTitle("HTML 沙箱预览");
    await expect(frame).toHaveAttribute("sandbox", "");
    await expect(page.frameLocator('iframe[title="HTML 沙箱预览"]').getByText("受限 HTML 教程")).toBeVisible();
  });

  test("设置页展示 Agent-native 能力和不可绕过的 Git 确认", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByText("task.create", { exact: true })).toBeVisible();
    await expect(page.getByText("idea.promoteToTask", { exact: true })).toBeVisible();
    await expect(page.getByText(/确认.*Git.*写操作|Git.*确认.*开启/)).toBeVisible();
  });

  test("桌面侧栏与 Git 状态区可收起并记住状态", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    await page.getByRole("button", { name: "收起侧栏" }).click();
    await expect(page.getByRole("button", { name: "展开侧栏" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("nuedc.sidebar.collapsed"))).toBe("true");

    await page.reload();
    await expect(page.getByRole("button", { name: "展开侧栏" })).toBeVisible();
    await page.getByRole("button", { name: "展开侧栏" }).click();

    await page.getByRole("button", { name: "展开仓库同步" }).click();
    await expect(page.getByRole("button", { name: "收起仓库同步" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("nuedc.git-panel.expanded"))).toBe("true");

    await page.reload();
    await expect(page.getByRole("button", { name: "收起仓库同步" })).toBeVisible();
  });
});
