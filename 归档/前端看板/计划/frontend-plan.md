你是本项目正式前端实施计划作者，模型必须是 ocx-jbb-grok-4-5。只创建或修改：

`比赛文档/实施计划/2026-07-28-本地看板前端实施计划.md`

不要写前端产品代码，不要修改其他文件，不要推送。完成后创建本地提交：

`docs: 添加本地看板前端实施计划`

先完整读取：

1. 最新设计规范。
2. `.superpowers/brainstorm/47231-1785248419/content/claude-orange-priority-pages-v2.html`
3. `.superpowers/brainstorm/47231-1785248419/content/claude-orange-workbench-tasks-v3.html`
4. `/Users/cc/.agents/skills/open-design/SKILL.md`
5. `/Users/cc/.agents/skills/frontend-design/SKILL.md`
6. frontend-design 的 `references/create.md`、`surface.md`、`motion.md`、`interaction.md`、`responsive.md`、`typeset.md`、`color.md`
7. Superpowers writing-plans 与 TDD 规范。

为 `apps/dashboard/**` 写一份完整、可直接交给实现 agent 的 TDD 计划。技术栈为 React、Vite、TypeScript、Tailwind CSS 设计 token；可按必要性使用 React Router、TanStack Query、dnd-kit、Lucide，禁止大型动画运行时。

必须覆盖 8 个真实页面：

- 工作台
- 任务
- 问题
- 想法
- 提交历史
- 参考资料
- 总体设计
- 设置

必须覆盖所有 agent-native 领域动作、capabilities/schema discovery、资源 API、Git 状态/差异/历史，以及拉取、提交、推送的分步人类确认。网页不能复制领域校验，必须调用 API。

视觉与交互要求：

- Claude 陶土橙、暖白、合法衬线标题替代、中文无衬线正文，中等信息密度。
- Product surface，不做营销页入场表演。
- 抽屉、弹窗、popover、toast、hover、press、加载、成功、错误、冲突均有真实可触发状态。
- 100/150/200/250/300/400ms 动画节奏，只动 transform/opacity；支持 motionLevel 与 prefers-reduced-motion。
- Dialog 捕获焦点、Escape 关闭、焦点回到触发器；键盘和触控完成核心流程。
- 320、375、768、1024、1440、2560px 重排；触控目标至少 44px，移动表单字号至少 16px。
- loading/empty/error/success/disabled/overflow 全覆盖。
- 路由拆包，首屏压缩 JS 预算 250 KiB，重型资料预览/差异/画布懒加载。
- 所有按钮使用具体动词，所有中文错误给出影响与下一步。

计划必须列出精确文件、组件/Hook/API 类型、每一步失败测试、失败预期、最小实现、通过命令和提交建议。包含 Vitest + RTL、Playwright E2E、axe 可访问性、响应式、动作/焦点/动画 reduced-motion、bundle budget 与长任务性能测试。不得出现 TBD/TODO、“类似上文”或只画静态 mock。最终运行 `git diff --check`，创建上述本地提交，并返回提交 SHA 与自审结论。
