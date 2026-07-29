# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: git-safety.spec.ts >> Git 五步确认 >> 提交依次经过查看、填写、复核、确认、结果，并在确认后发送 confirmed
- Location: tests/e2e/git-safety.spec.ts:27:7

# Error details

```
TimeoutError: locator.click: Timeout 10000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: /下一步|继续/ })

```

# Page snapshot

```yaml
- generic [ref=e2]:
  - generic [ref=e3]:
    - complementary [ref=e4]:
      - generic [ref=e5]:
        - generic [ref=e6]:
          - img [ref=e8]
          - generic [ref=e12]:
            - paragraph [ref=e13]: 电赛协作台
            - paragraph [ref=e14]: 三台电脑 · 一个事实源
        - navigation "主导航" [ref=e16]:
          - generic [ref=e17]:
            - paragraph [ref=e18]: 协作
            - generic [ref=e19]:
              - link "工作台" [ref=e20] [cursor=pointer]:
                - /url: /
                - img [ref=e21]
                - generic [ref=e26]: 工作台
              - link "任务" [ref=e27] [cursor=pointer]:
                - /url: /tasks
                - img [ref=e28]
                - generic [ref=e31]: 任务
              - link "问题" [ref=e32] [cursor=pointer]:
                - /url: /issues
                - img [ref=e33]
                - generic [ref=e35]: 问题
              - link "想法" [ref=e36] [cursor=pointer]:
                - /url: /ideas
                - img [ref=e37]
                - generic [ref=e39]: 想法
          - generic [ref=e40]:
            - paragraph [ref=e41]: 证据
            - generic [ref=e42]:
              - link "提交历史" [ref=e43] [cursor=pointer]:
                - /url: /history
                - img [ref=e44]
                - generic [ref=e47]: 提交历史
              - link "参考资料" [ref=e48] [cursor=pointer]:
                - /url: /materials
                - img [ref=e49]
                - generic [ref=e51]: 参考资料
              - link "总体设计" [ref=e52] [cursor=pointer]:
                - /url: /design
                - img [ref=e53]
                - generic [ref=e63]: 总体设计
          - generic [ref=e64]:
            - paragraph [ref=e65]: 设置
            - link "设置" [ref=e67] [cursor=pointer]:
              - /url: /settings
              - img [ref=e68]
              - generic [ref=e71]: 设置
        - generic [ref=e73]:
          - generic [ref=e74]:
            - generic [ref=e75]:
              - generic [ref=e76]: 领先远端
              - generic [ref=e77]: "1111111"
              - generic [ref=e78]: main
              - generic [ref=e79]: 检查于 48分钟前
            - paragraph [ref=e80]: 有 1 个待提交改动
          - generic [ref=e81]:
            - button "检查远端" [ref=e82] [cursor=pointer]:
              - generic [ref=e83]: 检查远端
            - button "拉取" [disabled]:
              - generic: 拉取
            - button "提交" [ref=e84] [cursor=pointer]:
              - generic [ref=e85]: 提交
            - button "推送" [disabled]:
              - generic: 推送
    - generic [ref=e86]:
      - banner [ref=e87]:
        - generic [ref=e89]:
          - paragraph [ref=e90]: 工作台
          - paragraph [ref=e91]: 仓库脉搏、今日事项与协作摘要
        - generic [ref=e92]:
          - button "检查" [ref=e93] [cursor=pointer]:
            - generic [ref=e94]: 检查
          - button "提交" [ref=e95] [cursor=pointer]:
            - generic [ref=e96]: 提交
      - main [ref=e97]:
        - generic [ref=e99]:
          - generic [ref=e100]:
            - generic [ref=e101]:
              - heading "工作台" [level=1] [ref=e102]
              - paragraph [ref=e103]: 先看仓库状态，再决定今天该做什么。所有数字都来自当前 JSON 与 Git。
              - generic [ref=e104]:
                - generic [ref=e105]: Git · ahead
                - generic [ref=e106]: main · 1111111
                - generic [ref=e107]: 1/3 名 active 成员
            - generic [ref=e108]:
              - button "安全拉取" [ref=e109] [cursor=pointer]:
                - generic [ref=e110]: 安全拉取
              - button "检查并提交" [ref=e111] [cursor=pointer]:
                - generic [ref=e112]: 检查并提交
          - generic [ref=e113]:
            - generic [ref=e114]:
              - paragraph [ref=e115]: 未完成任务
              - paragraph [ref=e116]: "1"
              - paragraph [ref=e117]: 0 项进行中
            - generic [ref=e118]:
              - paragraph [ref=e119]: 阻塞问题
              - paragraph [ref=e120]: "1"
              - paragraph [ref=e121]: 1 个未解决
            - generic [ref=e122]:
              - paragraph [ref=e123]: 开放想法
              - paragraph [ref=e124]: "0"
              - paragraph [ref=e125]: 等待验证或提升为任务
            - generic [ref=e126]:
              - paragraph [ref=e127]: 本地提交
              - paragraph [ref=e128]: "1"
              - paragraph [ref=e129]: 有 1 个待提交改动
          - generic [ref=e131]:
            - img [ref=e132]
            - generic [ref=e134]:
              - paragraph [ref=e135]: 有 1 个待提交改动
              - paragraph [ref=e136]: 工作区 dirty · 本地领先 1 · 远端领先 0
          - generic [ref=e137]:
            - generic [ref=e138]:
              - generic [ref=e140]:
                - heading "当前主线" [level=2] [ref=e141]
                - paragraph [ref=e142]: 优先展示进行中、阻塞和高优先级任务。
              - generic [ref=e144]:
                - generic [ref=e145]:
                  - generic [ref=e146]:
                    - generic [ref=e147]: 待开始
                    - generic [ref=e148]: 高
                    - generic [ref=e149]: T-20260729-TEST
                  - paragraph [ref=e150]: 检查电源轨
                  - paragraph [ref=e151]: 电源 · tester
                - generic [ref=e152]: 48分钟前
            - generic [ref=e153]:
              - generic [ref=e154]:
                - heading "阻塞与风险" [level=2] [ref=e157]
                - generic [ref=e160]:
                  - img [ref=e161]
                  - generic [ref=e163]:
                    - paragraph [ref=e164]: 串口偶发丢帧
                    - paragraph [ref=e165]: I-20260729-TEST · tester
              - generic [ref=e166]:
                - heading "最近提交" [level=2] [ref=e169]
                - generic [ref=e171]:
                  - paragraph [ref=e172]: "feat: 初始化协作看板"
                  - paragraph [ref=e173]: 1111111 · tester
  - button "关闭对话框背景" [ref=e174] [cursor=pointer]
  - dialog "创建本地提交" [ref=e175]:
    - generic [ref=e176]:
      - generic [ref=e177]:
        - heading "创建本地提交" [level=2] [ref=e178]
        - paragraph [ref=e179]: 写操作只会在最后确认后发送，并携带 confirmed 与期望状态快照。
      - button "关闭" [ref=e180] [cursor=pointer]:
        - img [ref=e182]
    - generic [ref=e185]:
      - list "Git 确认步骤" [ref=e186]:
        - listitem [ref=e187]:
          - generic [ref=e188]: 查看
        - listitem [ref=e189]:
          - generic [ref=e190]: 填写
        - listitem [ref=e191]:
          - generic [ref=e192]: 复核
        - listitem [ref=e193]:
          - generic [ref=e194]: 确认
        - listitem [ref=e195]:
          - generic [ref=e196]: 结果
      - generic [ref=e197]:
        - paragraph [ref=e198]: 操作：创建本地提交
        - paragraph [ref=e199]: 影响范围：2 个文件
        - paragraph [ref=e200]:
          - text: expectedHead=1111111111111111111111111111111111111111
          - text: expectedRemoteHead=0000000000000000000000000000000000000000
          - text: expectedChangesHash=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
        - paragraph [ref=e201]: "说明：test: 五步确认"
        - paragraph [ref=e202]: 可逆性：提交可在本地回退；推送与快进拉取需额外协作处理。失败时不会自动重试。
    - generic [ref=e203]:
      - button "取消" [ref=e204] [cursor=pointer]:
        - generic [ref=e205]: 取消
      - button "上一步" [ref=e206] [cursor=pointer]:
        - generic [ref=e207]: 上一步
      - button "进入确认" [active] [ref=e208] [cursor=pointer]:
        - generic [ref=e209]: 进入确认
```

# Test source

```ts
  1  | import { expect, test } from "./fixtures/dashboard";
  2  | 
  3  | async function openGitWizard(page: import("@playwright/test").Page, action: RegExp) {
  4  |   await page.getByRole("button", { name: action }).first().click();
  5  |   await expect(page.getByRole("dialog")).toBeVisible();
  6  | }
  7  | 
  8  | test.describe("Git 五步确认", () => {
  9  |   test("未完成确认前不发送 Git 写请求，且不可越级", async ({ page }) => {
  10 |     const writes: string[] = [];
  11 |     await page.route("**/api/git/{pull,commit,push}", async (route) => {
  12 |       writes.push(new URL(route.request().url()).pathname);
  13 |       await route.fulfill({ status: 500, body: "不应在未确认阶段调用" });
  14 |     });
  15 | 
  16 |     await page.goto("/");
  17 |     await openGitWizard(page, /^提交$/);
  18 |     await expect(page.getByText(/查看|第 1 步/).first()).toBeVisible();
  19 |     await expect(page.getByRole("button", { name: /确认执行|确认提交/ })).toHaveCount(0);
  20 | 
  21 |     const next = page.getByRole("button", { name: /下一步|继续/ });
  22 |     await next.click();
  23 |     await expect(page.getByText(/填写|第 2 步/)).toBeVisible();
  24 |     await expect(writes).toEqual([]);
  25 |   });
  26 | 
  27 |   test("提交依次经过查看、填写、复核、确认、结果，并在确认后发送 confirmed", async ({ page }) => {
  28 |     const bodies: Array<Record<string, unknown>> = [];
  29 |     await page.route("**/api/git/commit", async (route) => {
  30 |       bodies.push(route.request().postDataJSON() as Record<string, unknown>);
  31 |       await route.fulfill({
  32 |         status: 200,
  33 |         contentType: "application/json",
  34 |         body: JSON.stringify({
  35 |           ok: true,
  36 |           operation: "commit",
  37 |           summary: "提交已完成",
  38 |           state: { worktree: "clean", topology: "ahead", connection: "online", severity: "ahead" },
  39 |         }),
  40 |       });
  41 |     });
  42 | 
  43 |     await page.goto("/");
  44 |     await openGitWizard(page, /^提交$/);
  45 |     await page.getByRole("button", { name: /下一步|继续/ }).click();
  46 |     await page.getByLabel(/提交说明|提交信息/).fill("test: 五步确认");
  47 |     await page.getByRole("button", { name: /下一步|继续/ }).click();
  48 |     await expect(page.getByText(/复核|第 3 步/).first()).toBeVisible();
> 49 |     await page.getByRole("button", { name: /下一步|继续/ }).click();
     |                                                        ^ TimeoutError: locator.click: Timeout 10000ms exceeded.
  50 |     await expect(page.getByText(/确认|第 4 步/).first()).toBeVisible();
  51 |     await page.getByRole("button", { name: /确认执行|确认提交/ }).click();
  52 |     await expect(page.getByText(/结果|提交已完成|已完成/)).toBeVisible();
  53 |     await expect.poll(() => bodies.length).toBe(1);
  54 |     expect(bodies[0]).toMatchObject({ confirmed: true });
  55 |     expect(bodies[0].expectedHead).toBeTruthy();
  56 |     expect(bodies[0].expectedChangesHash).toBeTruthy();
  57 |   });
  58 | 
  59 |   test("冲突状态会明确阻止危险 Git 操作并显示处理提示", async ({ page }) => {
  60 |     await page.route("**/api/git/status", (route) => route.fulfill({
  61 |       status: 200,
  62 |       contentType: "application/json",
  63 |       body: JSON.stringify({
  64 |         worktree: "conflict",
  65 |         topology: "diverged",
  66 |         connection: "online",
  67 |         head: "1".repeat(40),
  68 |         remoteHead: "2".repeat(40),
  69 |         ahead: 1,
  70 |         behind: 1,
  71 |         severity: "conflict",
  72 |         lastCheckedAt: "2026-07-29T09:30:00+08:00",
  73 |         conflictFiles: ["比赛管理/任务/T-20260729-TEST.json"],
  74 |         summary: "存在合并冲突，必须人工处理。",
  75 |       }),
  76 |     }));
  77 | 
  78 |     await page.goto("/");
  79 |     await expect(page.getByText(/冲突|必须人工处理/).first()).toBeVisible();
  80 |     await expect(page.getByRole("button", { name: /^拉取$/ })).toBeDisabled();
  81 |     await expect(page.getByRole("button", { name: /^推送$/ })).toBeDisabled();
  82 |   });
  83 | });
  84 | 
```