# C 题数字钥匙门锁固件

该工程面向 `MSPM0G3507 + CCS + SysConfig`。当前已经把
2026-07-31 两站 `145 mm` 现场标定候选、双 UART、四位拨码、
ST7735S、声光和锁执行器适配到源码。主机回归、SysConfig 生成和
CCS Debug 全量构建已通过；尚未烧录、测量目标板 WCET 或完成实机
验收。

## 当前两站实现

- 右站：`device1/0100=(+72.5, 0) mm`
- 左站：`device2/0200=(-72.5, 0) mm`
- `0.8 s` 窗口，每路取最低 3 个距离均值
- 43 个物理点等权原型、二维定点 4NN
- 每 `100 ms` 解算，每 `500 ms` 刷新显示
- 距离输出 `HIGH/MEDIUM/REJECT`
- 只有 `HIGH` 可设置 `auth_distance_valid`
- `REJECT` 最多保持上一可信距离 `500 ms`，授权立即失效
- 输出两个角度诊断候选，但 `angle_valid=false`、
  `angle_auth_valid=false` 固定成立
- 模型版本 `0x0100`，序列化长度 `384 B`，
  CRC32 `0x91F6EF14`

模型事实源和生成器：

- `calibration/two_station_20260731.json`
- `tools/build_two_station_model.py`
- `two_station_model_data.c/.h`

## 地址与身份边界

本轮采集中的紧凑帧：

```text
P0,0100,84cm,19dB
P1,0200,107cm,-1dB
```

其中 `0100/0200` 按站点/链路地址处理，不再取低 4 bit 冒充钥匙
ID。因此该类帧可以形成距离和角度诊断结果，但即使距离达到 `HIGH`
也不会通过身份授权。

钥匙身份必须来自独立目标地址，例如固定站各自输出：

```text
P,1111,84cm
```

厂商标准从机帧没有 SNR。固件仅在“两路都没有 SNR、两路钥匙地址
有效且完全相同”时启用无 SNR 兼容质量门；只缺一路 SNR、没有钥匙
地址或两路地址不同都会闭锁。有 SNR 时仍执行左路 `-5/-6 dB`
门限。今天数据去掉 SNR 条件的敏感性回放得到 `HIGH` 覆盖
`24.00%`、P95 `116.32 mm`、最大 `273.81 mm`，但这不是无 SNR
实机采集证据。

或使用同时包含站点和钥匙地址的显式字段：

```text
STATION=0100,KEY=1111,DIST=840mm,SNR=19dB
```

两路钥匙地址必须一致，`key_id = key_addr & 0x0F`，并且
`key_id_valid=true` 后才允许与拨码值比较。目标地址切换会清空窗口、
稳定性历史和上一可信结果，防止跨钥匙混算。解析器同时接受串口工具
可能附加的 `re:` / `RE:` 前缀。

## 模块

- `uwb_text_protocol.*`：UWB 文本帧、站点地址、钥匙地址、单位和
  正负 SNR 解析
- `uwb_two_station_estimator.*`：窗口、lower-3、MAD、定点 4NN、
  质量门、保持和故障标志
- `two_station_model_data.*`：冻结 43 点模型
- `uwb_fusion.*`：协议测量到两站估计结果和门锁位置接口的映射
- `id_input.*`：四按键翻转与四位拨码直读双后端，当前使用拨码直读
- `lock_fsm.*`：HIGH 距离、有效钥匙 ID、迎宾和开锁闭锁逻辑
- `lock_app.*`：100 ms 业务更新、500 ms 显示节流、溢出上报
- `lock_ui.*`：不依赖 TI SDK 的屏幕文本、密码和配对状态格式化
- `st7735.*`：SPI1 ST7735S 初始化、5×7 字库和变化行刷新
- `lock_hw.*` / `lock_hw_mspm0.c`：双 UART IRQ、两路 512 B 接收环、
  拨码、声光、锁控和显示硬件适配

## 引脚、拨码与显示

当前 `.syscfg` 已冻结本轮两站引脚：

| 功能 | 引脚 |
| --- | --- |
| 右站 UWB / UART1 | PA8 TX、PA9 RX |
| 左站 UWB / UART0 | PA0 TX、PA1 RX |
| ST7735S / SPI1 | PB9 SCK、PB8 MOSI、PB6 CS0、PB24 DC、PB20 RST |
| 拨码 bit0..bit3 | PA28、PA31、PA13、PA16 |
| 红灯、绿灯、蜂鸣器、迎宾灯 | PA14、PA15、PA12、PA7 |
| 锁执行器控制 | PB19 |

拨码输入使用内部上拉，开关 `ON` 时接地并在软件中解释为 `1`。
物理面板从左到右应标为 `bit3 bit2 bit1 bit0`。全部 `OFF` 时密码为
`0000 / 0x0`；例如 `0xA = 1010` 时，`bit3` 和 `bit1` 拨到 `ON`，
`bit2` 和 `bit0` 保持 `OFF`。首次上电读数立即生效，运行中变化需
稳定 `30 ms` 后更新。

屏幕每 `500 ms` 接受一个应用快照，只重画发生变化的行，不申请完整
帧缓冲。界面固定显示：

```text
KEY LOCK
SET 0XA
SET 1010
RX  0XA
RX  1010
PAIR MATCH
D 1234 H
LOCK OPEN
U R06 L06
A -15/+40
```

`PAIR MATCH/FAIL/NONE` 只说明收到的 4-bit 钥匙 ID 是否与拨码一致；
真正开锁仍同时要求两站距离质量为 `HIGH`。声光逻辑为：普通闭锁、
远距离或无钥匙时红灯关闭且蜂鸣器静音；迎宾时迎宾灯加 80 ms 短响；
开锁时绿灯/迎宾灯加 150 ms 短响；只有明确收到错误 ID 时红灯亮并
短响一次，拒绝保持期间不持续报警。当前实物有源蜂鸣器为 PA12
低电平有效，上电及静音状态输出高电平。

## 主机侧回归

```bash
code/c_digital_key_lock/tests/run_two_station_tests.sh
code/c_digital_key_lock/tests/run_two_station_parity_tests.sh
code/c_digital_key_lock/tests/run_two_station_host_benchmark.sh
code/c_digital_key_lock/tests/run_tests.sh
python3 code/c_digital_key_lock/tools/test_build_two_station_model.py
python3 code/c_digital_key_lock/tools/build_two_station_model.py --check
python3 code/c_digital_key_lock/tools/evaluate_two_station_model.py --check
```

这些测试不依赖 TI SDK，用于验证模型 CRC/长度、定点 4NN、质量门、
地址切换、角度不授权、协议、状态机和显示节拍。

## SysConfig、构建与未验证项

- `.syscfg` 仍是外设和引脚配置源；没有手改生成文件。
- UART0/UART1 均为 `921600 8N1`、RX FIFO 中断；SPI1 为
  `8 MHz`、Motorola mode 0、MSB first。
- `tests/`、`tools/` 和 `calibration/` 已从 MCU 构建中排除，仍保留
  为主机验证和模型事实源。
- SysConfig 1.28.0 对 SDK 2.10.00.04 生成成功，无错误或警告；仅输出
  80 MHz Flash 操作提示和 SPI STOP/STANDBY 保持提示。
- CCS Debug 使用本机兼容工具 TI Clang 5.1.1、SysConfig 1.28.0
  全量构建为 `0 errors`。工程原声明版本为 TI Clang 4.0.4、
  SysConfig 1.26.2，因此 CCS 仍报告两条版本替代提示。
- 链接 map：FLASH 使用 `0x6150 = 24,912 B / 128 KB`，SRAM 静态使用
  `0x713 = 1,811 B / 32 KB`，另保留 `512 B` 栈。
- 采集会话使用的电脑串口为 `115200`，不代表当前地猛星 UART 参数
  已完成实物匹配。
- 已按现场现象确认当前有源蜂鸣器控制为 PA12 低电平有效；尚未确认
  实物 UWB 是否确实输出 `921600 8N1`、PB19 驱动级极性和
  ST7735S 方向/偏移。
- 尚无烧录记录、示波器/逻辑分析仪串口证据、屏幕照片、执行器动作、
  目标板栈峰值或 100 ms 解算 WCET 证据，不能写“上板通过”。
