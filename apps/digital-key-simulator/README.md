# 数字钥匙仿真工作台

独立运行的数字钥匙定位、门锁状态与 Agent-native 调试网页。

## 与 UWB Lab 的隔离关系

- 本应用目录：`apps/digital-key-simulator`
- 本应用地址：`http://127.0.0.1:4180`
- 现有 UWB Lab 地址：`http://127.0.0.1:4173`
- 本应用不打开串口、不修改 UWB 模块参数、不提供强制开锁。
- 实机监看通过 HTTP GET 读取 UWB Lab 的状态、测量值和历史会话。
- “现场标定”只通过受控 Agent 命令请求 4173 采集和切换模型，COM 口仍只由 4173 占用。
- 两个网页可同时运行，拥有各自的入口、进程和界面。

## 启动

双击：

```text
apps/digital-key-simulator/start.cmd
```

或在仓库根目录运行：

```powershell
npm run dev --workspace=@nuedc/digital-key-simulator
```

## 工作模式

- 实机模式（默认）：只读显示电脑根据串口测距和最终标定模型生成的位置。
- 仿真模式：拖动钥匙、键盘移动、场景与故障注入。
- 回放模式：读取本机 UWB Lab 历史会话，不生成虚假的实机误差结论。
- 现场标定：固定门锁与 2～4 个基站，点选钥匙真值并安全训练候选模型。

## 实机数据链路

```text
UWB 基站
  → UWB Lab 串口采集
  → 电脑最终标定模型拟合距离/角度
  → /api/position
  → 数字钥匙工作台显示位置
```

- 工作台不从 `/api/measurements` 重新进行三边定位。
- `distanceM` 直接按 2026-07-31 最终标定约定作为门锁坐标原点到钥匙圆柱中心的距离，不再增加 300 mm。
- `angleValid=false` 时只显示距离和方向不确定提示，不生成虚假的横向坐标。
- 工作台会同时读取 `/api/status` 检查串口连接和最后一帧时间，防止把断线前的旧结果当成实时位置。

## Agent-native

基础地址：`http://127.0.0.1:4180/api/agent/v1`

- `GET /registry`
- `POST /query`
- `POST /commands:plan`
- `POST /commands:execute`
- `GET /events`
- `GET /operations/{id}`
- `POST /operations/{id}:cancel`

实机只读命令：

- `recorder.status.get`
- `recorder.position.get`
- `recorder.calibration.get`
- `recorder.measurements.list`
- `recorder.sessions.list`

浏览器公开 `window.digitalKeyAgent.v1`，网页按钮与外部 Agent 使用同一套命令注册、Schema、幂等、revision 和事件接口。

现场标定命令：

- `calibration.setup.configure`
- `calibration.point.capture`
- `calibration.candidate.get`
- `calibration.model.activate`
- `calibration.model.rollback`

`calibration.point.capture` 会先稳定 2 秒，再完整采集 15 秒。每个合格点保存真实坐标、串口原始测量和候选估计；新流程以门锁中心到钥匙中心为真实距离，不增加 300 mm。没有单独验证记录时，候选模型使用逐物理点交叉验证，未通过 0.30 m、10°、边界 0.20 m、P95 和边界跨越门槛时不会替换正式模型。

Agent Schema 版本：`1.1.0`。

CLI 示例：

```powershell
npm run cli --workspace=@nuedc/digital-key-simulator -- help
npm run cli --workspace=@nuedc/digital-key-simulator -- registry
npm run cli --workspace=@nuedc/digital-key-simulator -- snapshot
```

## 验证

```powershell
npm test --workspace=@nuedc/digital-key-simulator
npm run typecheck --workspace=@nuedc/digital-key-simulator
npm run build --workspace=@nuedc/digital-key-simulator
```
