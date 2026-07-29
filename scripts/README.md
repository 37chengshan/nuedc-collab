# 可重复调用脚本

## 统一入口

```bash
npm run agent -- help
npm run agent -- validate
npm run agent -- overview
```

## 13 个领域动作

`scripts/agent/` 中每个文件只映射一个协议动作，不包含 Git、DOM 或重复业务逻辑。

示例：

```bash
npm run build --workspace=@nuedc/agent-cli

node scripts/agent/task-create.mjs \
  --idempotency-key agent-task-create-20260729 \
  --payload '{"title":"检查电机驱动","module":"小车","priority":"high","owner":"37chengshan"}'

node scripts/agent/task-set-status.mjs \
  --idempotency-key agent-task-done-20260729 \
  --expected-revision <从list/show读取的revision> \
  --payload '{"id":"T-20260729-ABCD","to":"done","message":"验收条件已完成"}'

node scripts/agent/issue-create.mjs \
  --idempotency-key agent-issue-create-20260729 \
  --payload '{"title":"电机B无输出","severity":"high","blocking":true,"owner":"37chengshan","symptoms":["上电后PWM正常但无输出"]}'

node scripts/agent/event-append.mjs \
  --idempotency-key agent-progress-event-20260729 \
  --payload '{"entityType":"task","entityId":"T-20260729-ABCD","kind":"progress","message":"完成空载测试，下一步带载测试"}'
```

相同请求重试时复用相同 idempotency key；请求内容变化时必须换新 key。

## 安全 Git

```bash
npm run git:status
npm run git:pull
npm run git:commit -- --message "feat: 完成任务"
npm run git:push
```

脚本只执行固定 Git 命令模板，不接受任意 Git 参数。
