# 2026-07-31 地猛星数字钥匙四层 HEX

本目录中的四个 Intel HEX 文件由当前数字钥匙固件源码构建生成，用于
MSPM0G3507 地猛星开发板。屏幕控制脚已按实际排针图修正为
`PA12/PA13/PA17`。固件已通过 SysConfig、编译链接和主机回归测试，但尚未
在当前会话中完成真实板卡烧录验证。

## 文件用途

| 层级 | 文件 | 大小 | 用途 |
|---|---|---:|---|
| L1 | `c_digital_key_lock_l1_screen.hex` | 53,854 B | 只验证 ST7735S 屏幕、密码字段、距离和角度界面 |
| L2 | `c_digital_key_lock_l2_monitor.hex` | 131,209 B | UWB 串口接收、两路原始距离、拟合距离/角度和区域显示，设定密码固定为 `0000` |
| L3 | `c_digital_key_lock_l3_identity.hex` | 131,254 B | 增加四位拨码设定密码和钥匙 ID 授权判断，不驱动门锁 |
| L4 | `c_digital_key_lock_l4_full.hex` | 131,974 B | 完整版：拨码、显示、迎宾/开锁声光和 `PA16` 门锁输出 |

## SHA256

```text
E6EEFA0F43D488249BA2F02C8D7CCEC3E96A539A3A0805B8D71A3E3FC2186534  c_digital_key_lock_l1_screen.hex
D34D5B810FC22745D83775F46181EB29EB9AFCDAC348D87D633162261FCC81CC  c_digital_key_lock_l2_monitor.hex
D69AD4300C6F0EE2F799567D6F33F3EAD443697608FC36DB1621DDBB08C59C70  c_digital_key_lock_l3_identity.hex
B5C4686013EE1F78DE259C74937455F4CA42E7DF79E10DF82C34F1EFDF31789E  c_digital_key_lock_l4_full.hex
```

## UWB 接线

所有 UWB 模块使用 `115200 8N1`，每个从机独占一个串口，模块 TX 接 MCU RX，
模块 RX 接 MCU TX，并与 MCU 共地。

| 通道 | MCU TX | MCU RX | 当前定位状态 |
|---|---|---|---|
| UWB1 / UART1 | `PA8` | `PA9` | 默认启用 |
| UWB2 / UART3 | `PA26` | `PA25` | 默认启用 |
| UWB3 / UART2 | `PB15` | `PB16` | 已独立接收，等待三基站标定后参与定位 |

当前正式模型仍使用前两个基站，第三路不会在没有标定数据时影响开锁。

## ST7735S 接线

该版本已按实际地猛星排针重新分配屏幕控制脚：

| 屏幕引脚 | MCU |
|---|---|
| 1 GND | `GND` |
| 2 VCC | `3V3` |
| 3 SCK | `PB9` |
| 4 SDA | `PB8` |
| 5 RES | `PA17` |
| 6 RS / DC | `PA13` |
| 7 CS | `PA12` |
| 8 LEDA | `3V3` |

旧分配中的 `PB10/PB11/PB14` 没有在这块地猛星开发板的两侧排针引出，不能
按旧接线使用。

## L2 双串口诊断显示

角度区域上方新增紧凑显示：

```text
1:026 2:097
```

两项分别是 UART1 和 UART3 最近收到的原始距离，单位为厘米：

- `---`：1.5 秒内没有收到可解析报文，优先检查 TX/RX、共地和波特率；
- `000`：已经收到该通道报文，但模块报告 `0cm`；
- 两项都有非零数字后，固件才会继续进行双路同步和最终距离拟合。

零距离不会参与定位和开锁，仅保留在屏幕上用于现场诊断。

## 烧录顺序

1. 先烧录 L1，确认屏幕方向、颜色和长期点亮。
2. 再烧录 L2，确认 UWB1、UWB2 距离和角度每 500 ms 更新。
3. 烧录 L3，逐一验证四位拨码和屏幕 `SET ID`。
4. 烧录 L4 前，先用 LED 或万用表检查 `PA16`；确认电平正确后再连接三极管、
   继电器和电磁锁，感性负载必须加续流二极管。
