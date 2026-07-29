# Agent 与脚本速查

## 初始化

```bash
npm run agent -- init-member --username 你的GitHub用户名 --roles vision,testing --local
```

`--local` 只写入被 Git 忽略的 `.本机配置/settings.json`。三台电脑分别执行一次。

## 记录读写

```bash
npm run agent -- list tasks
npm run agent -- list issues
npm run agent -- list ideas
npm run agent -- show 记录ID
npm run agent -- validate
npm run overview
```

所有创建/更新通过：

```bash
npm run agent -- action 动作名 \
  --idempotency-key 至少16字符的唯一键 \
  --expected-revision 更新动作需要的64位revision \
  --payload 'JSON对象'
```

动作名：

- 任务：`task.create`、`task.update`、`task.setStatus`、`task.handoff`
- 问题：`issue.create`、`issue.update`、`issue.handoff`
- 想法：`idea.create`、`idea.update`、`idea.promoteToTask`
- 进度/测试/交接记录：`event.append`
- 成员与本机设置：`member.update`、`settings.update`

`scripts/agent/` 中每个动作都有一个可重复调用的薄包装，参数与统一 CLI 相同。

## 安全 Git

```bash
npm run git:status
npm run git:pull
npm run git:commit -- --message "feat: 完成任务"
npm run git:push
```

自动化环境可用 `--dry-run` 查看影响；真正写操作必须交互输入中文确认短语，或显式传入 `--confirm`。
