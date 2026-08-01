# 四路 UWB 串口采集监视工程

独立 CCS/SysConfig 工程，只检查四个 UWB 串口是否持续返回数据。
不解析 UWB 协议，不运行定位、标定、拨码、LED、蜂鸣器或门锁逻辑。

## 引脚

| 通道 | UART | TX | RX |
| --- | --- | --- | --- |
| UWB1 | UART1 | PA8 | PA9 |
| UWB2 | UART0 | PA0 | PA1 |
| UWB3 | UART2 | PA23 | PA24 |
| UWB4 | UART3 | PA26 | PA25 |

UART 均为 `921600 8N1`。MCU TX 接 UWB RX，MCU RX 接 UWB TX，
所有模块与地猛星共地。

屏幕使用：

- PB9：SCK
- PB8：SDA/MOSI
- PB6：CS
- PB20：RES
- PB24：DC/RS
- 屏幕 VCC、BL：3V3
- 屏幕 GND：GND

## 屏幕状态

- `WAIT`：上电后从未收到数据。
- `RX`：已经收到数据，但尚未达到连续增长确认条件。
- `OK`：连续 3 个 500 ms 周期字节计数均增长。
- `LOST`：曾经收到数据，但连续 1.5 s 未增长。

每个通道同时显示累计接收字节数。计数用于检查链路活动，不代表
完整帧数或有效测距数量。

## 导入 CCS

在 CCS 中选择 **Import Existing CCS Project**，导入本目录：

```text
code/c_uwb4_capture_monitor
```

先打开 `empty.syscfg` 检查无未解释警告，再执行 Debug Build。

## 验证边界

本工程默认使用 XDS110 目标配置。烧录前必须确认实际探针与
`targetConfigs/MSPM0G3507.ccxml` 一致。源码、SysConfig、构建和
实机四路 UART/屏幕必须分别记录验证结果。
