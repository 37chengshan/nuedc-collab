# 数字钥匙仿真工作台

独立运行的数字钥匙定位、门锁状态与 Agent-native 调试网页。

## 与 UWB Lab 的隔离关系

- 本应用目录：`apps/digital-key-simulator`
- 本应用地址：`http://127.0.0.1:4180`
- 现有 UWB Lab 地址：`http://127.0.0.1:4173`
- 本应用不打开串口、不修改 UWB 模块参数、不提供强制开锁。
- 实机模式只通过 HTTP GET 读取 UWB Lab 的状态、测量值和历史会话。
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

- 仿真模式：拖动钥匙、键盘移动、场景与故障注入。
- 实机模式：只读显示 `4173` 的串口状态和测量数据。
- 回放模式：读取本机 UWB Lab 历史会话，不生成虚假的实机误差结论。

## Agent-native

基础地址：`http://127.0.0.1:4180/api/agent/v1`

- `GET /registry`
- `POST /query`
- `POST /commands:plan`
- `POST /commands:execute`
- `GET /events`
- `GET /operations/{id}`
- `POST /operations/{id}:cancel`

浏览器公开 `window.digitalKeyAgent.v1`，网页按钮与外部 Agent 使用同一套命令注册、Schema、幂等、revision 和事件接口。

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
