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
- 2～4 基站自动标定向导：77 个距离/角度测点、15 秒采集、前 2 秒丢弃。
- 同一 `keyId` 按链路和 120 ms 时间窗同步（允许完整地址不同）、Hampel/MAD 清洗、每路至少 100 组数据门槛。
- 测距模型自动选择、距离/角度补偿、独立验证和最差点重采提示。
- 固定偏差、P95 热力图、真实/滤波轨迹、动态误差、1 m/2 m 边界图。
- PNG、CSV、JSON 和 MSPM0 C 模型导出。

## 自动标定流程

默认两基站天线中心坐标为：

```text
A1 = (-125, +40) mm
A2 = (+125, +40) mm
圆柱外边界零点偏移 = 300 mm
```

网页中选择“标定”后按以下顺序操作：

1. 选择启用基站数 `2`、`3` 或 `4`，填写实测天线中心坐标。
2. 按扇区图把钥匙放到当前边界距离和角度。
3. 点击“开始当前点”，保持不动 15 秒；程序自动丢弃前 2 秒。
4. 每路获得至少 100 组同地址同步数据且波动合格后，进入下一点。
5. 完成 77 点后点击“迭代训练”，再用独立重采数据点击“独立验证”。
6. 验证通过后导出 `calibration_model_data.c/.h/.json`。

比赛距离指钥匙到圆柱外边界的距离。定位坐标半径按：

```text
位置半径 = 比赛边界距离 + 300 mm
```

正前方为 `+y`，右侧为正角，标定范围为 `-45°～+45°`。

## 2026-07-31 实测状态

当前最终采集目录的运行模型使用 68 组两基站真实数据：旧数据 18 组、新结构化
数据 50 组。现有稀疏实时模型的状态必须按以下方式理解：

- 距离数据覆盖 `0.5～3.0 m`；角度数据覆盖 1 m、2 m 的 `-45°～+45°`，
  另有两个 1.5 m 独立补测点。
- 距离模型使用双路 `k=2` 近邻与一号链路单调折线各 50% 融合，并在靠近
  已知标定原型时自动提高近邻权重。
- 同一物理距离和角度的重复采集整组留出后，1 m 附近 P95 约 `0.135 m`、
  最大误差 `0.200 m`；2 m 附近 P95 和最大误差约 `0.142 m`，边界跨错为 0。
- 实时结果每 500 ms 更新，并带小变化平滑和连续三次大跳变确认；仍需在真实
  板卡上完成长时间静止和动态接近验收。
- 当前角度显示与真实方向不一致，角度能力判定为不可用；页面显示数值不代表通过标定。
- 第二路数据低 SNR、高 MAD 或跳变时，距离降级为一号链路折线；角度保持
  上一次显示值，但仍标记为不可信且不参与开锁。
- 距离模型已同步导出到 MSPM0，CRC32 为 `1A5428E5`；可信角度仍需要第三
  基站和新的三路标定数据。

下一阶段正式采集与验收计划见：

```text
比赛文档/实验记录/C题/UWB/2026-07-30_下一阶段标定与验收计划.md
```

## 固定场地持续标定

4180 的“现场标定”不会直接打开串口，而是调用本服务：

```text
GET  /api/calibration/continuous
POST /api/calibration/continuous/setup
POST /api/calibration/continuous/points:capture
POST /api/calibration/continuous/models:activate
POST /api/calibration/continuous/models:rollback
```

流程约束：

- 门锁中心为场地原点，支持 2～4 个带高度的固定基站。
- 场地坐标改变时自动递增 revision，旧场地数据不会混入新模型。
- 每点先等待 2 秒稳定，再完整采集 15 秒，至少需要 100 组同地址同步数据。
- 新持续标定的真值是门锁中心到钥匙中心的距离，`boundaryOffsetMm` 固定为 `0`。
- 同一物理点最多使用最近 5 次合格记录，各物理点等权。
- 没有单独 validation 记录时使用逐物理点交叉验证，禁止直接用训练结果冒充验证。
- 候选模型只做旁路计算；只有通过距离、角度、1 m/2 m 边界、P95 退化和边界跨越门槛后才能原子热切换。
- 保留正式模型和最近两个历史版本，重启后恢复 active 模型。

这里与上方 77 点旧标定向导的 300 mm 圆柱外边界定义是两套明确分开的数据语义，旧流程保持兼容。

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
node cli.mjs schema calibration.train
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

自动标定 CLI：

```powershell
node cli.mjs calibration plan

node cli.mjs calibration capture `
  --distance 1 `
  --angle 0 `
  --anchors 2 `
  --dry-run `
  --idempotency-key capture-preview-1

node cli.mjs calibration train `
  --input-file D:\CCCCC\calibration-input.json `
  --idempotency-key train-1

node cli.mjs calibration validate `
  --input-file D:\CCCCC\validation-input.json `
  --idempotency-key validate-1

node cli.mjs calibration export `
  --input-file D:\CCCCC\trained-model.json `
  --output D:\CCCCC\firmware-model `
  --idempotency-key export-1
```

长时间训练进度输出到 `stderr`，最终只有一个 JSON envelope 输出到
`stdout`。同一幂等键重复执行会返回同一结果，不会重复训练或重复写入。

## Agent Native 契约

- `stdout`：稳定 JSON envelope。
- Schema 版本：`1.2.0`。
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
| `5` | 标定数据不足或需要补采 |
| `6` | 缺少危险操作确认 |
| `7` | 幂等键冲突 |
| `8` | 标定算法引擎不可用 |

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

## 模型部署到 MSPM0

网页或 CLI 导出的模型与
`code/c_digital_key_lock/calibration_model.h` 使用同一 900 字节
`CalibrationModelV1` ABI。部署步骤：

1. 用导出的 `calibration_model_data.c` 和
   `calibration_model_data.h` 替换固件目录中的同名文件。
2. 不要修改 `generated/ti_msp_dl_config.c/.h`。
3. 在固件目录运行 `build.ps1`。
4. 烧录生成的 `build/c_digital_key_lock.hex`。

固件上电会检查模型版本、尺寸和 CRC32；任何一项失败都会保持闭锁并显示标定
错误。审计 JSON 单独保存，不会作为字符串写入单片机 Flash。

## 验证

```powershell
npm run typecheck --workspace=@nuedc/uwb-recorder
npm test --workspace=@nuedc/uwb-recorder
node --test tests/uwb-session-replay.test.mjs
npm test --workspace=@nuedc/uwb-localization
```
