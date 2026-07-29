# 地猛星②：接收与显示端

通过 UART1 接收地猛星①的数据帧，CRC 校验通过后立即回传 ACK，并在本地 OLED 显示地址、ADC、电压和序号。

- UART1：PA8 TX、PA9 RX，115200 8N1
- OLED：PB2 SCL、PB3 SDA、地址 0x3C
- 接线：①PA8→②PA9，①PA9←②PA8，GND共地

后续透明无线串口模块保持 115200 8N1，即可替代三根有线连接。
