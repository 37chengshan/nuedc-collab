# 安全 Git 五步确认

文件名保留旧编号以避免引用失效；当前流程使用命令行脚本，不依赖网站。

固定契约：

```text
查看 → 填写 → 复核 → 确认 → 结果
```

## 开始工作：安全拉取

```bash
npm run git:status
npm run git:pull
```

脚本先检查工作区，再要求输入“确认获取”；获取远端状态后，只有 `clean + behind` 才继续要求“确认拉取”，最终只执行 `merge --ff-only`。

以下情况会停止：未知改动、已有冲突、历史分叉、无远端、认证失败或网络失败。不要用 force、rebase、reset、stash 或自动 merge 绕过。

## 完成工作：查看并提交

```bash
npm run validate
npm run git:status
npm run git:commit -- --message "feat: 完成电机空载测试"
```

提交脚本会校验活动 JSON，展示分支、HEAD、文件和 diff 摘要，复核提交说明，并要求输入“确认提交”。状态变化会立即拒绝。

只提交部分文件时：

```bash
npm run git:commit -- \
  --message "docs: 更新K230测试记录" \
  --files "比赛管理/任务/T-20260729-ABCD.json,比赛管理/事件/E-20260729-120000-ABCD.json"
```

## 共享成果：安全推送

```bash
npm run git:push
```

脚本展示分支、领先数量和待推送提交，要求输入“确认推送”；随后重新 fetch。远端变化、工作区不干净、分叉或冲突都会停止，绝不 force push。

## 只查看不执行

```bash
npm run git:pull -- --dry-run
npm run git:commit -- --message "test: 演练" --dry-run
npm run git:push -- --dry-run
```

`--dry-run` 不执行写操作。非交互自动化如果没有精确的 `--confirm` 短语，也会安全停止。
