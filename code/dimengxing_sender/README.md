# 地猛星①：采集与发送端

读取 PA27 ADC 和 PB6–PB9 四位低有效地址，在本地 OLED 显示，并通过 UART1 和 HC-12 向地猛星②发送带 CRC 的数据帧。

- UART1：PA8 TX、PA9 RX，9600 8N1
- OLED：PB2 SCL、PB3 SDA、地址 0x3C
- 地址：PB6=bit0、PB7=bit1、PB8=bit2、PB9=bit3，内部上拉、按下为1
- ADC：PA27 / ADC0 channel 0

## HC-12 接线

| HC-12 | 地猛星① | 说明 |
| --- | --- | --- |
| VCC | +5V | 模块旁并联 100uF 与 0.1uF 去耦 |
| GND | GND | 必须共地 |
| RXD | PA8 / UART1-TX | 交叉连接 |
| TXD | PA9 / UART1-RX | 交叉连接 |
| SET | 不连接 | 内部上拉，保持透明传输模式 |

两只 HC-12 均使用出厂参数：FU3、9600 8N1、CH001。必须安装弹簧天线或 433MHz 天线后再长时间发射。

PB8/PB9 与小车 PCB 灰度地址线复用；使用本工程时不要同时连接灰度模块。
