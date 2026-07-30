# 电赛协作仓库：AI 操作手册

先读事实，再改文件；先跑验证，再报完成；Git 写操作逐步确认。

本文件是仓库内所有 AI Agent 的顶层入口。`CLAUDE.md` 与 `AGENTS.md` 必须完全一致。修改后执行 `npm run sync:ai-docs`。

## 任务边界

本仓库服务三名队员在多台电脑上通过 GitHub 协作。AI 可以维护任务、问题、想法、事件、比赛文档、设计资料和代码，但必须守住以下边界：

- 以仓库当前内容为准，不用旧对话代替现场检查。
- 比赛题目未录入仓库前，不编造题目要求、最终方案或测试结论。
- 明确区分“已计划”“已编码”“构建通过”“上板通过”。
- 成员身份统一填写 GitHub username。
- 只改任务授权的文件，不覆盖队友未说明的工作。
- 不把参考代码当成已经验证的比赛代码。
- 不提交 AI 或开发过程记录，例如 `task_plan.md`、`progress.md`、`findings.md`、`process.md`、临时审查报告和推理草稿；只提交最终规范、正式文档、代码与可复现验证。

## 开工顺序

每次任务都按以下顺序开始：

1. 读取本文件，以及目标目录内更具体的 `AGENTS.md` 或 `CLAUDE.md`。
2. 运行 `git status --short`，确认分支和未提交改动。
3. 查看相关任务、问题、想法和最近事件，避免重复建档。
4. 确认目标模块、负责人、依赖、验收条件和题目依据。
5. 选择最小改动面，调用对应 Skill、脚本或 Agent 动作。
6. 完成修改后运行与风险匹配的验证，记录真实输出。
7. 提交前展示改动；推送前重新检查远端。

工作区脏、需求冲突、硬件信息不足、Git 历史分叉或验证失败时，停止高风险动作，用中文说明现场、风险和下一步。

## 事实来源

发生冲突时，按以下优先级裁决：

1. 比赛官方题目、规则及仓库内归档原文。
2. 当前硬件、原理图、数据手册、SDK 元数据和工程配置。
3. `比赛管理/` 中通过 Schema 校验的活动 JSON。
4. 当前源码、测试、构建产物和可复现命令输出。
5. `比赛文档/`、`比赛设计/`、`参考资料/` 和 `reference-code/`。
6. 对话、记忆和推测。

采用高优先级事实，并把冲突记录为问题或事件。

## 仓库地图

- `比赛管理/任务/`：一项任务一个 JSON。
- `比赛管理/问题/`：一个问题一个 JSON。
- `比赛管理/想法/`：一个想法一个 JSON。
- `比赛管理/事件/`：一条进度、测试、决策或交接一个 JSON。
- `比赛管理/成员/`：一个 GitHub username 一个 JSON。
- `比赛管理/Schema/`：活动数据字段与枚举的唯一来源。
- `比赛管理/模板/`：仅供复制，不参与活动数据加载。
- `比赛文档/`：规则、分工、实验记录和成员说明。
- `比赛设计/`：题目公布后的总体方案、接口和可视化设计。
- `参考资料/`：数据手册、教程和外部资料说明。
- `reference-code/`：参考代码，不代表已集成或已验证。
- `packages/protocol/`：领域校验、原子写入和动作实现。
- `packages/agent-cli/`：成员与 Agent 的统一命令入口。
- `packages/git-core/`、`scripts/git-safe.mjs`：安全 Git 状态机。
- `apps/server/`：仅监听本机回环地址的 API、GitHub 身份识别和安全 Git 接口。
- `apps/dashboard/`：活动中的 Claude 橙色八页面协作台。
- `scripts/agent/`：可重复调用的 Agent 动作包装。
- `.claude/skills/`、`.codex/skills/`：项目本地 Skill；同名副本必须同步。
- `生成内容/`：可重新生成的总览，不是人工维护的事实源。
- `归档/前端看板/`：旧版前端基线；保留但不参与当前默认构建。

## JSON 通讯协议

业务记录必须满足以下规则：

1. 每项任务、问题、想法、事件和成员各占一个 `.json`。禁止合并成共享大文件。
2. 文件名等于记录 ID；成员文件名等于 GitHub username。
3. `owner`、`author`、`actor`、`participants` 只填写 GitHub username。
4. `owner` 只表示主要负责人，不是权限锁；任意 active 成员均可操作记录，所有改动仍受 revision、幂等键和事件审计保护。
5. ID 格式固定：任务 `T-YYYYMMDD-XXXX`，问题 `I-YYYYMMDD-XXXX`，想法 `A-YYYYMMDD-XXXX`，事件 `E-YYYYMMDD-HHMMSS-XXXX`。
6. 时间使用带时区的 ISO 8601。字段、状态和优先级以 `比赛管理/Schema/` 为准。
7. 进度、测试、决策和交接追加为独立事件，不覆盖历史。
8. 通过 `npm run agent -- ...` 或 `scripts/agent/*.mjs` 写业务 JSON，不直接绕过协议改文件。
9. 更新时携带最新 `revision`。同一请求重试时复用 idempotency key；新请求使用新 key。
10. 模板和生成内容不得冒充活动记录。

## Agent 动作

先查看现状：

```bash
npm run agent -- help
npm run agent -- list tasks
npm run agent -- show <记录ID>
npm run agent -- validate
npm run agent -- overview
```

创建任务：

```bash
npm run agent -- action task.create \
  --idempotency-key <本次请求的唯一键> \
  --payload '{"title":"完成电机空载测试","module":"小车","priority":"high","owner":"<github-username>"}'
```

更新、完成、关闭和交接使用对应动作：`task.update`、`task.setStatus`、`task.handoff`、`issue.update`、`issue.handoff`、`idea.update`、`event.append`。优先复用 `scripts/agent/` 中已有包装，不重复造入口。

## 本地协作台

每台电脑先安装依赖并完成一次构建：

```bash
npm install
npm run build
```

启动本地 API：

```bash
npm start
```

服务只监听 `http://127.0.0.1:3210`。首次启动优先通过 `gh api user` 自动识别当前 GitHub CLI 登录用户，并把 username 写入不会提交的 `.本机配置/settings.json`。无法可靠识别时，使用 `npm run agent -- init-member ... --local` 手动初始化。

另开终端启动网页：

```bash
npm run dev
```

浏览器打开 `http://127.0.0.1:5173`。网页中的任务、问题、想法写操作必须调用 Agent-native 动作；Git 拉取、提交和推送必须走五步确认向导，最终一步由成员直接点击确认按钮。命令行脚本仍使用中文确认短语。

## C 题 UWB 当前基线与任务路由

截至 2026-07-30，C 题 UWB 必须以以下实测结论为准，不得沿用旧计划中的理想化结论：

- `apps/uwb-recorder/data/captures/` 已有 18 组两基站实测数据，基站间距 250 mm，当前完整地址为 `0100` 和 `0200`，可按低 4 位 `keyId=0` 与 120 ms 时间窗同步。
- 现有稀疏模型在 0.5～1.5 m 训练标定点上的最大距离误差约 0.112 m、P95 约 0.103 m；这只证明训练点拟合，尚未完成独立验证。
- 实时距离测量误差基本可接受，但显示仍有明显波动，不能写成“稳定性通过”。
- 当前角度虽然能显示数值，但与真实方向不符，结论为“角度不可用”。网页和固件必须保留独立的角度有效标志；角度未通过独立验证前不得参与开锁。
- 两基站完整地址不同是当前链路事实。融合应按 `keyId`、链路编号和时间窗执行，完整地址用于追溯，禁止重新加入“各基站完整地址必须相同”的错误条件。

后续工作按以下任务执行：

1. `T-20260730-11Y3`：扩展 0.5～3.0 m 距离标定并加密 1 m/2 m 边界。
2. `T-20260730-75QP`：完成多角度标定并判断 250 mm 两基站是否具备角度可观测性。
3. `T-20260730-CA0K`：整定实时滤波、坏链路降级与区域防抖。
4. `T-20260730-B5J4`：使用至少 35 个未参与训练的点独立验证并冻结 MSPM0 比赛模型。

正式采集网格、每点时长、质量门槛和失败后的三基站切换条件见
`比赛文档/实验记录/C题/UWB/2026-07-30_下一阶段标定与验收计划.md`。

## MSPM0 任务路由

遇到 TI MSPM0、Code Composer Studio、Keil、CMake/GCC/OpenOCD、SysConfig、DriverLib、天猛星或地猛星任务，先加载本地 Skill：

- Claude：`.claude/skills/mspm0-ccs/SKILL.md`
- Codex：`.codex/skills/mspm0-ccs/SKILL.md`

按该 Skill 识别工程入口，以 `.syscfg` 为配置源，保护生成文件，烧录前检测探针，谨慎处理特殊引脚，并区分源码、构建和实机验证。两份 Skill 不一致时，先同步，再改工程。

## Git 安全流程

网页 Git 写操作固定为：查看 → 填写 → 复核 → 点击确认 → 查看结果。确认点击前必须刷新最新 HEAD、远端状态和选中文件摘要；状态过期时保留填写内容，刷新后由成员再次点击确认。命令行脚本继续要求中文确认短语。

- 拉取：先 `fetch`，只执行 `merge --ff-only`。
- 提交：先展示文件列表和 diff 摘要，再运行 JSON 校验并填写提交说明。
- 推送：再次获取远端状态，展示待推送提交，再请求确认。
- 遇到冲突、分叉或阻碍拉取的本地改动：立即停止，保留现场并给出中文指引。
- 禁止 force push、`reset --hard`、自动 rebase、自动解冲突和静默覆盖。
- 禁止提交 Token、密码、SSH 私钥、`.env`、`.本机配置/`、缓存、依赖目录、构建产物和 AI/开发过程文件。

优先使用仓库封装：

```bash
npm run git:status
npm run git:pull
npm run git:commit
npm run git:push
```

## 完成标准

日常任务只运行相关检查。声称仓库级完成前，依次执行：

```bash
npm run sync:ai-docs
npm run schemas
npm run typecheck
npm run test
npm run test:integration
npm run test:smoke
npm run test:e2e -- --project=chromium
npm run validate
npm run overview
npm run git:status
```

逐项报告结果。未运行的检查标注“未验证”并说明原因；没有连接硬件，就不能写“上板通过”。

## 立即停止

出现以下情况时，停止相关写入、烧录、提交或推送：

- 题目、引脚、电压、外设实例、通信参数或探针选择存在高风险歧义。
- 改动可能覆盖队友未说明的工作。
- Schema、测试、构建、SysConfig 或硬件检查失败。
- Git 出现冲突、分叉、意外文件或疑似敏感信息。
- 请求要求修改生成文件、绕过协议、伪造结果或跳过必要确认。

保留现场，说明已知事实、失败位置和需要用户决定的事项。

## 交接格式

每轮工作结束后只回答四件事：

1. 改了什么，文件在哪里。
2. 跑了什么验证，结果如何。
3. 哪些内容未验证，有什么风险或阻塞。
4. 下一位成员可以直接执行什么命令或任务。
