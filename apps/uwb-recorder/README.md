# UWB Lab - Agent Native 数据与配置工具

这是 EWM550 / EWT550 的本地采集、配置和分析工具。串口只由本地服务占用，
Claude 风格网页和 Agent CLI 调用同一套 API，因此不会互相抢占 COM 口，也
不会出现网页看到一份数据、Agent 读取另一份数据的情况。

## 启动

先关闭官方 `UWB Setting V1.0` 等正在占用串口的软件，然后双击：

```text
start.cmd
```

它会：

1. 在后台启动本地采集服务。
2. 打开 `http://127.0.0.1:4173`。
3. 自动枚举 COM 口。

网页不再使用 Web Serial，因此不要求浏览器直接申请串口权限。

## 网页功能

- 串口枚举、连接、断开和波特率选择。
- `P0` 至 `P4` 五路距离、地址和 SNR 监控。
- 两路重点对比、最近 20 帧范围、中位数和同步时间差。
- 最近 300 帧曲线、暂停显示、清空图表和恢复全部视图。
- 进入/退出配置模式、参数读取/写入、复位、版本查询、休眠、掉电和恢复出厂。
- 角色 `0/1/2`、CH5/CH9、波特率、功率、从机数量、源地址和五个目标地址。
- 自定义 AT 指令终端。
- 服务端 JSONL 自动保存、历史会话、CSV 导出和删除。

## Agent CLI

所有核心功能都有 JSON CLI。默认服务地址：

```text
http://127.0.0.1:4173
```

在本目录运行：

```powershell
node cli.mjs status
node cli.mjs ports
node cli.mjs measurements --limit 100 --device 1 --since-ms 30000
node cli.mjs sessions
node cli.mjs parameters get
node cli.mjs schema
```

连接和控制：

```powershell
node cli.mjs connect --port COM6 --baud 115200 --dry-run
node cli.mjs connect --port COM6 --baud 115200
node cli.mjs action read
node cli.mjs action version
node cli.mjs command --text "AT+VERSION"
node cli.mjs disconnect
```

写参数前可先预览，不访问串口：

```powershell
node cli.mjs parameters set `
  --interval 100 `
  --role 1 `
  --channel 9 `
  --baud-code 4 `
  --power 3 `
  --responders 2 `
  --source 0A00 `
  --destinations "0100,0200,0000,0000,0000" `
  --dry-run
```

去掉 `--dry-run` 才会实际进入配置模式并发送指令。

恢复出厂和删除会话必须显式确认：

```powershell
node cli.mjs action restore --dry-run
node cli.mjs action restore --yes
node cli.mjs delete-session --session <ID> --yes
```

导出历史数据：

```powershell
node cli.mjs export --session <ID> --output D:\CCCCC\uwb-data.csv
```

## Agent Native 契约

- `stdout`：稳定 JSON envelope。
- Schema 版本：`1.0.0`。
- 自描述：`node cli.mjs schema [resource.action]`。
- 预执行：状态变更命令支持 `--dry-run`。
- 危险操作：恢复出厂和删除会话要求 `--yes`。
- 错误：包含稳定 `code`、`message`、`retryable` 和 `details`。
- API 地址：`GET /api/schema`。

退出码：

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `1` | 其他错误 |
| `2` | 参数校验失败 |
| `3` | 本地服务不可用 |
| `4` | 串口连接或占用错误 |
| `6` | 缺少危险操作确认 |

## 数据保存

服务端自动保存到：

```text
data\sessions\<session-id>.jsonl
data\sessions\<session-id>.meta.json
```

JSONL 同时保留测距帧、AT 发送记录、模块回复和连接状态。CSV 导出只包含测距
帧，字段为：

```text
timestamp,elapsed_ms,device,link_index,address,distance_cm,snr_db,raw
```

`raw` 是原始报文，后续更换滤波、标定或角度算法时可以重新计算。

## 验证

```powershell
npm run typecheck --workspace=@nuedc/uwb-recorder
npm test --workspace=@nuedc/uwb-recorder
```
