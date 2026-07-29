# 成员 GitHub 用户名与 JSON 文件责任约定

## 成员身份

当前仓库已登记的 active 成员只有：

| GitHub 用户名 | 角色 | 已登记职责 | 文件 |
| --- | --- | --- | --- |
| `37chengshan` | `coordinator` | 仓库协议与协作流程 | `比赛管理/成员/37chengshan.json` |

不要替另外两位成员编造用户名。两位成员在开始写任务、问题或想法前，必须用各自**真实 GitHub 用户名**登记为 active 成员；成员文件命名规则为：

仓库中的 `teammate-hardware` 与 `teammate-vision` 是明确标记为 inactive 的占位记录，不代表真实成员。

```text
比赛管理/成员/<githubUsername>.json
```

成员记录的字段为 `recordType`、`schemaVersion`、`githubUsername`、`roles`、`responsibilities`、`status`、`createdAt`、`updatedAt`。`githubUsername` 必须与文件名相同，不用姓名、昵称或电脑名替代。

建议队内填写这个分工表，并把结果写入各自成员记录的 `roles` 与 `responsibilities`：

| 成员 | 真实 GitHub 用户名 | 主责 | 备份/复核 | 本机设置中的用户名 |
| --- | --- | --- | --- | --- |
| 队长/协调 | `37chengshan` | 协作节奏、方案决策记录、冲突分派 | 全局状态复核 | `37chengshan` |
| 成员二 | 待本人填写 | 待赛题后填写的主责模块 | 另一模块复核 | 必须完全一致 |
| 成员三 | 待本人填写 | 待赛题后填写的主责模块 | 另一模块复核 | 必须完全一致 |

赛题公布前可登记 `hardware`、`firmware`、`vision`、`mechanical`、`testing`、`documentation` 等能力角色，但不把它们当作已确定的最终系统分工。

## 一项一文件与单写者

| 类型 | 目录与命名 | 谁能改主记录 | `owner` 的作用 |
| --- | --- | --- | --- |
| 任务 | `比赛管理/任务/T-日期-四位码.json` | 任意 active 成员 | 表示主要跟进人，不是权限锁 |
| 问题 | `比赛管理/问题/I-日期-四位码.json` | 任意 active 成员 | 表示主要排查人，不是权限锁 |
| 想法 | `比赛管理/想法/A-日期-四位码.json` | 任意 active 成员 | 表示主要验证人，不是权限锁 |
| 事件 | `比赛管理/事件/E-日期-时间-四位码.json` | 任意 active 成员创建新事件 | 事件中的 `actor` 记录实际操作者 |
| 成员 | `比赛管理/成员/<GitHub用户名>.json` | active 成员按流程维护 | 不替别人伪造身份 |

记录文件均为 UTF-8、两空格缩进、英文 camelCase 字段；数组无内容写 `[]`，未知内容省略字段，不写无意义 `null`。

## 创建、更新与关闭的必要字段

### 任务

任务最少要写清：`title`、`module`、`priority`、`description`、`acceptanceCriteria`。认领后补 `owner`；需要他人配合写 `participants`；被问题阻塞写 `blockingIssueIds`。

- 状态：`todo → doing → blocked / review → done`。
- 进入 `done` 前，`completedAcceptanceCriteria` 必须逐项覆盖 `acceptanceCriteria`；没有验收条件的任务可以直接完成。
- 代码或文档提交确实相关时，把短 SHA 填入 `relatedCommits`，不凭猜测填写。

### 问题

问题必须写清：可复现的 `symptoms`、是否 `blocking`、关联的 `linkedTaskIds`、临时 `workaround`（没有则空字符串）。解决后补 `resolution` 和必要的 `relatedCommits`。

- 状态：`open → investigating → blocked / resolved`。
- “暂时没空”不是 resolved；必须说明验证过的解决结果。

### 想法与事件

想法记录假设、替代方案或风险，不把未经验证结论写成事实。需要落地时再通过流程提升为任务。

事件只写增量证据，字段重点是：

```text
entityType、entityId、kind、actor、message、createdAt
```

`kind` 只能是 `comment`、`progress`、`statusChange`、`handoff`、`decision`、`testResult`。进度、交接、决定、测试都优先写事件，而不是多人同时改同一主记录。

## 本机身份和安全

Agent CLI 从 `.本机配置/settings.json` 读取本机 `githubUsername`，请求不应手工伪造 `actor`。用户名未登记为 active，或与本机设置不一致时，停止写入并先修正成员登记。`owner` 只用于分工展示；任何 active 成员都可以操作记录，但不能绕过 revision、幂等键、事件审计或 Git 人工确认。
