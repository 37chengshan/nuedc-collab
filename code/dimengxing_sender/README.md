# 地猛星①：采集与发送端

读取 PA27 ADC 和 PB6–PB9 四位低有效地址，在本地 OLED 显示，并通过 UART1 向地猛星②发送带 CRC 的数据帧。

- UART1：PA8 TX、PA9 RX，115200 8N1
- OLED：PB2 SCL、PB3 SDA、地址 0x3C
- 地址：PB6=bit0、PB7=bit1、PB8=bit2、PB9=bit3，内部上拉、按下为1
- ADC：PA27 / ADC0 channel 0

PB8/PB9 与小车 PCB 灰度地址线复用；使用本工程时不要同时连接灰度模块。
