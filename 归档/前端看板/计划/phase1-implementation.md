你是本项目阶段一唯一实现者，模型必须是当前 CLI 指定的 ocx-jbb-grok-4-5。

工作目录是一个独立 Git worktree。先完整读取：

1. `比赛文档/设计规范/2026-07-28-赛前协作底座设计.md`
2. `比赛文档/实施计划/2026-07-28-阶段一仓库与JSON协议实施计划.md`
3. `/Users/cc/.codex/plugins/cache/openai-curated-remote/superpowers/6.2.0/skills/test-driven-development/SKILL.md`
4. `/Users/cc/.codex/plugins/cache/openai-curated-remote/superpowers/6.2.0/skills/test-driven-development/writing-good-tests.md`

严格按计划顺序完成阶段一全部 7 个任务。必须测试先行：每项功能先写失败测试并实际运行确认按预期失败，再写最小实现、运行通过、重构。你不是唯一工作者，不要触碰 `apps/dashboard/**`、`apps/server/**`、`packages/git-core/**`，不要回退现有设计和计划提交。

主线程预审后的强制修正：

- 根 workspaces 必须是 `["apps/*", "packages/*"]`。
- `.gitignore` 是修改现有文件，必须保留 `.superpowers/`、本机目录和已有规则。
- `LocalSettings` 必须包含 `motionLevel: "system" | "none" | "reduced" | "standard"`，默认 `system`。
- `DomainActionService`、revision、幂等回执、owner/active member、Idea 提升和无浏览器 Agent CLI 只在 `packages/protocol` 实现一次；后端只允许适配调用。
- 所有外部渠道的 `event.append` 只允许 `comment | decision | testResult`，`statusChange | handoff` 只能由系统动作生成。
- 不访问真实 GitHub，不推送。允许按计划每个任务创建本地提交。
- 不允许跳过失败测试，不允许在测试后补写实现证据。

完成后执行：

```text
npm install
npm run sync:ai-docs
npm run check
npm run sync:ai-docs -- --check
git diff --check
```

确认 `AGENTS.md`、`CLAUDE.md` 与权威正文 SHA-256 完全一致。最终返回：状态、提交列表、测试命令和结果、改动文件摘要、残余风险。不要推送远端。
