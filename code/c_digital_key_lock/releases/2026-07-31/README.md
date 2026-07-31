# 2026-07-31 地猛星数字钥匙四层 HEX

本目录中的四个 Intel HEX 文件由源码提交 `e91fd8d` 对应的固件构建生成，
用于 MSPM0G3507 地猛星开发板。固件已通过 SysConfig、编译链接和主机回归
测试，但尚未在当前会话中完成真实板卡烧录验证。

## 文件用途

| 层级 | 文件 | 大小 | 用途 |
|---|---|---:|---|
| L1 | `c_digital_key_lock_l1_screen.hex` | 52,999 B | 只验证 ST7735S 屏幕、密码字段、距离和角度界面 |
| L2 | `c_digital_key_lock_l2_monitor.hex` | 129,544 B | UWB 串口接收、距离/角度拟合和区域显示，设定密码固定为 `0000` |
| L3 | `c_digital_key_lock_l3_identity.hex` | 129,589 B | 增加四位拨码设定密码和钥匙 ID 授权判断，不驱动门锁 |
| L4 | `c_digital_key_lock_l4_full.hex` | 130,354 B | 完整版：拨码、显示、迎宾/开锁声光和 `PA16` 门锁输出 |

## SHA256

```text
A601EE804F4E9BD051861646E421F1B30A7BA625B554DB1FB8CA6EC2D42FA6C6  c_digital_key_lock_l1_screen.hex
8E670D9C5218ED62B86BF0DEA7F3805F512DC4A960492BEE32051060E94E4FDD  c_digital_key_lock_l2_monitor.hex
71A112D84EFD35D5277018FA42BF214D5C871A1F3A043D9D195E949A6DE17F7D  c_digital_key_lock_l3_identity.hex
DC84C983D72CF8C7CECCC398C61A6E445FD99EE2A93C326C4805A353FF1974FD  c_digital_key_lock_l4_full.hex
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

## 烧录顺序

1. 先烧录 L1，确认屏幕方向、颜色和长期点亮。
2. 再烧录 L2，确认 UWB1、UWB2 距离和角度每 500 ms 更新。
3. 烧录 L3，逐一验证四位拨码和屏幕 `SET ID`。
4. 烧录 L4 前，先用 LED 或万用表检查 `PA16`；确认电平正确后再连接三极管、
   继电器和电磁锁，感性负载必须加续流二极管。

