你是阶段二实施计划修订者，模型必须是 ocx-jbb-grok-4-5。只允许修改：

`比赛文档/实施计划/2026-07-28-阶段二Git与本地API实施计划.md`

不要写产品代码，不要修改其他文件，不要推送。完成后创建本地提交：

`docs: 修订阶段二 Git 与 API 实施计划`

先完整读取最新设计规范、阶段一计划和当前阶段二计划。修复以下架构冲突：

1. `packages/protocol` 已拥有唯一 `DomainActionService`、动作 Schema、revision、幂等、owner/active member、Idea 提升和 Agent CLI。
2. 删除阶段二在 `apps/server` 重复实现 `action-contracts.ts`、`idempotency-store.ts`、`domain-actions.ts`、`cli-actions.ts` 的计划。
3. 阶段二任务 4 只实现 HTTP/资源路由适配：从 `@nuedc/protocol` 创建 runtime，`GET /api/capabilities`、`GET /api/schemas/actions/:action`、`POST /api/actions/:action` 和资源便捷端点全部转发同一个动作服务。
4. 资源端点使用 `POST /api/ideas/:id/promote`，不得保留 `/convert`。
5. 通用动作绝不包含 Git；Git 写仍使用独立确认式端点。
6. 服务器测试使用真实 protocol runtime 或窄接口注入，验证 HTTP 与 protocol 返回完全一致，不重测或复制协议内部实现。
7. 阶段二写入范围保持 `packages/git-core/**` 与 `apps/server/**`。

同时检查阶段二任务 1—6 的接口依赖、命令、文件清单和验收是否自洽。保留 TDD 粒度，删除任何 TBD/TODO/旧动作名/重复职责。完成后运行 `git diff --check`，创建上述本地提交，只返回提交 SHA、修订摘要和自审结论。
