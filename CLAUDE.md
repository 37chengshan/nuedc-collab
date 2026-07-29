# 电赛协作仓库顶层规则

本文件与 `AGENTS.md` 必须保持完全一致。修改后执行 `npm run sync:ai-docs`。

## 项目目标

服务三名队员在三台电脑上通过 GitHub 协作。当前日期为 2026-07-29，比赛题目尚未公布。不得虚构题目要求、最终方案、测试结果或已完成状态；题目公布后再补充详细方案文档和可视化设计。

## 目录导航

- `比赛管理/任务|问题|想法|事件|成员/`：一条记录一个 JSON 文件。
- `比赛管理/Schema/`：机器可读 JSON Schema。
- `比赛管理/模板/`：只用于复制参考，不参与活动数据加载。
- `比赛文档/`：人类协作与比赛资料。
- `比赛设计/`：题目公布后的总体设计。
- `参考资料/` 与 `reference-code/`：文档和代码参考。
- `packages/protocol/`：唯一领域校验、原子写入与动作实现。
- `packages/agent-cli/`：Agent/成员统一命令入口。
- `packages/git-core/` 与 `scripts/git-safe.mjs`：安全 Git 状态机和确认流程。
- `scripts/agent/`：13 个可重复调用的动作薄包装。
- `生成内容/`：由 `npm run overview` 重新生成的总览。
- `归档/前端看板/`：暂停的前端，不属于当前活动范围。

## JSON 通讯协议

1. 每项任务、问题、想法、事件和成员各占一个 `.json`，禁止改成巨型共享 JSON。
2. 文件名必须等于记录 ID；成员文件名必须等于 GitHub username。
3. `owner`、`author`、`actor`、`participants` 必须填写 GitHub username。
4. 任务 ID：`T-YYYYMMDD-XXXX`；问题：`I-YYYYMMDD-XXXX`；想法：`A-YYYYMMDD-XXXX`；事件：`E-YYYYMMDD-HHMMSS-XXXX`。
5. 时间使用带时区 ISO 8601。状态、优先级和字段以 `比赛管理/Schema/` 为准。
6. 进度、测试、决策和交接写成独立事件；不要反复改写历史事件。
7. 写操作优先调用 `npm run agent -- ...` 或 `scripts/agent/*.mjs`，禁止 Agent 绕过协议直接写业务 JSON。
8. 更新动作必须使用最新 revision；重复请求必须复用同一 idempotency key，不同请求不得复用。

## 常用 Agent 动作

```bash
npm run agent -- help
npm run agent -- list tasks
npm run agent -- show T-20260729-ABCD
npm run agent -- validate
npm run agent -- overview
```

创建动作示例：

```bash
npm run agent -- action task.create \
  --idempotency-key agent-task-20260729-0001 \
  --payload '{"title":"完成电机空载测试","module":"小车","priority":"high","owner":"37chengshan"}'
```

更新、完成、关闭和交接使用对应动作：`task.update`、`task.setStatus`、`task.handoff`、`issue.update`、`issue.handoff`、`idea.update`、`event.append`。13 个稳定包装见 `scripts/agent/`。

## Git 安全规则

1. Git 写流程固定为：查看 → 填写 → 复核 → 输入中文确认短语 → 查看结果。
2. 拉取只允许 `fetch` 后的 `merge --ff-only`；工作区脏、存在冲突或历史分叉时立即停止。
3. 提交前必须展示文件列表和 diff 摘要，并通过 JSON 校验。
4. 推送前必须重新获取远端状态并展示将推送的提交。
5. 禁止 force push、`reset --hard`、自动 rebase、自动解决冲突和静默覆盖。
6. 不得将 Token、密码、SSH 私钥、`.env` 或 `.本机配置/` 提交。

## Agent 禁止事项

- 不得修改或删除他人未说明的改动。
- 不得把前端归档重新设为默认构建，除非用户明确恢复前端工作。
- 不得把 `node_modules`、缓存、构建产物或本机配置加入 Git。
- 不得在题目未公布时写“最终方案已确定”。
- 不得跳过测试后宣称完成。

## 完成检查

```bash
npm run sync:ai-docs
npm run schemas
npm run typecheck
npm run test
npm run test:integration
npm run validate
npm run overview
npm run git:status
```
