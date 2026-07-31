# 电赛三人协作仓库

这是比赛题目公布前的协作底座，当前重点是小车、天猛星/地猛星、K230 视觉与硬件准备。题目尚未公布，因此仓库只提供记录、交接、参考资料和安全 Git 流程，不预设最终比赛方案。

## 现在能做什么

- 每项任务、问题、想法、事件各自保存为一个 JSON 文件，降低三人同时编辑时的冲突概率。
- 成员与负责人统一填写真实 GitHub username。
- Agent 和队员通过同一套 CLI 创建、更新、完成、交接和校验记录。
- 安全查看、拉取、提交和推送；所有写步骤明确确认，冲突或分叉立即停止。
- 生成 `生成内容/当前总览.json` 与 Markdown 总览，供人阅读或未来网页解析。
- 本地协作台提供工作台、任务、问题、想法、提交历史、参考资料、总体设计和设置八个页面。
- 首次启动会优先通过 GitHub CLI 自动识别当前登录的 GitHub username，并写入不提交的本机配置。
- 旧版前端仍完整保留在 `归档/前端看板/`，活动实现位于 `apps/dashboard/`。

## 五分钟开始

```bash
npm install
npm run build

# 推荐：已执行 gh auth login 的电脑会在启动服务时自动识别 GitHub username
npm start

# 另开一个终端启动网页
npm run dev
# 浏览器打开 http://127.0.0.1:5173

# 如果没有安装或登录 GitHub CLI，再手动初始化
npm run agent -- init-member \
  --username 你的GitHub用户名 \
  --roles hardware,firmware \
  --responsibilities "小车主控,电机调试" \
  --local

npm run validate
npm run overview
npm run git:status
```

## UWB Lab（串口采集与自动标定）

UWB Lab 是独立的本地网页，包含串口连接、实时数据显示、45 秒采集、采集记录和自动标定功能。它与上面的协作台不是同一个页面：

- `http://127.0.0.1:5173`：比赛协作台。
- `http://127.0.0.1:4173`：UWB Lab。

从仓库根目录启动：

```bash
npm install
npm run uwb:lab
```

然后浏览器打开 `http://127.0.0.1:4173`。Windows 也可以直接双击 `apps/uwb-recorder/start.cmd`。

仓库中的 `apps/uwb-recorder/data/` 保存已采集的真实记录、会话和导出数据，新电脑拉取后可直接用于回放、分析和训练。

日常开始工作前：

```bash
npm run git:pull
```

完成工作后：

```bash
npm run validate
npm run git:commit -- --message "feat: 完成某项任务"
npm run git:push
```

## 目录

- `比赛管理/`：任务、问题、想法、事件、成员、模板与 JSON Schema。
- `比赛文档/`：协作手册、设备准备、方案模板和设计规范。
- `比赛设计/`：题目公布后填写总体方案与系统画布。
- `参考资料/`：硬件资料、焊接教程与外部仓库索引。
- `reference-code/`：允许使用英文目录名的参考代码。
- `packages/`：协议、Agent CLI 与安全 Git 核心代码。
- `apps/server/`：只监听本机回环地址的 API、身份识别和 Git 安全接口。
- `apps/dashboard/`：Claude 橙色本地协作台。
- `apps/uwb-recorder/`：UWB 串口实时显示、45 秒采集、记录回放和自动标定工具。
- `scripts/`：Agent 动作薄包装、安全 Git 与维护脚本。
- `生成内容/`：可重新生成的总览 JSON/Markdown。
- `归档/前端看板/`：旧版前端源码和恢复说明。

详细规则见 [比赛文档/协作手册/README.md](比赛文档/协作手册/README.md) 和根目录 `CLAUDE.md` / `AGENTS.md`。
