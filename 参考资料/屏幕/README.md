# ST7735S 彩屏资料索引

本目录保存 1.77 英寸、128×160、SPI 接口 ST7735S 彩屏的原始资料和
STM32F103 参考例程。数字钥匙工程只复用显示控制器知识、初始化命令、颜色格式
和结构尺寸，不直接复制 STM32 的 GPIO/SPI 操作。

## 资料用途

| 文件或目录 | 内容 | 本工程如何使用 |
|---|---|---|
| `驱动IC数据手册.pdf` | ST7735S 指令、时序、寄存器和 RGB565 数据格式 | 用于核对 `SLPOUT(0x11)`、`COLMOD(0x3A)`、`MADCTL(0x36)`、`DISPON(0x29)`、地址窗口和 RAM 写入流程 |
| `1.77模块尺寸信息.pdf` | 模块外形、可视区和安装尺寸 | 用于结构安装和确认竖屏 128×160 布局 |
| `引脚接线.png` | 模块 GND/VCC/SCL/SDA/RES/DC/CS/BL 定义 | 用于识别模块端引脚名称；MSPM0 端接法以本 README 下方表格为准 |
| `实物连接显示.jpg` | 原例程的实物连接和显示效果 | 仅用于确认模块类型和上电后的彩色显示效果 |
| `LCD_Config.h` | `X_MAX_PIXEL=128`、`Y_MAX_PIXEL=160` | 复用分辨率定义 |
| `Lcd_Driver.c/.h` | ST7735 系列初始化、窗口和写像素流程 | 复用命令顺序与参数含义；不复用 STM32 GPIO 位操作 |
| `GUI.c/.h`、`Font.h` | 旧工程的绘图和字模思路 | 仅作参考；正式工程使用新的边界裁剪绘图和 5×7 ASCII 字模 |
| 其余 Keil/STM32 工程文件 | STM32F103 示例工程、构建产物和取模工具 | 不进入 MSPM0 构建，也不提交到协作仓库 |

## 本工程最终接线

接线已根据本地 TI MSPM0G3507 SPI1 例程和 SysConfig 1.28.0 实际生成结果
确认，不采用此前不可靠的 PA14 设想。

| 彩屏引脚 | MSPM0G3507 | 作用 |
|---|---|---|
| GND | GND | 必须共地 |
| VCC | 3V3 | 3.3 V 供电 |
| SCL | PB9 | SPI1 SCLK，8 MHz，Mode 0 |
| SDA | PB8 | SPI1 PICO/MOSI，仅发送 |
| CS | PA12 | 软件 GPIO 片选，空闲为高 |
| DC / RS | PA13 | 命令/数据选择 |
| RES | PA17 | 屏幕硬件复位 |
| BL | 3V3 | 固定全亮，避免 GPIO 直接承担背光电流 |

4 位设定身份 ID 使用 PB0～PB3，均配置内部上拉，开关接地时为逻辑 1。

## 可复用代码位置

正式实现位于：

- `code/c_digital_key_lock/st7735s.c/.h`
- `code/c_digital_key_lock/lock_display_format.c/.h`
- `code/c_digital_key_lock/lock_display_ui.c/.h`
- `code/c_digital_key_lock/lock_hw_mspm0.c`
- `code/c_digital_key_lock/screen_demo_main.c`

自动生成的 `generated/ti_msp_dl_config.c/.h` 只能由 `empty.syscfg` 通过
SysConfig 重新生成，禁止手工修改。

## 注意事项

1. 上电前按实物核心板丝印核对 PB8、PB9、PA12、PA13、PA17 是否已引出，
   并用万用表确认没有与板载功能短接。
2. 模块资料中的 `SDA` 是 SPI 数据输入，不是 I²C SDA。
3. 若实机出现红蓝互换，应先检查 `MADCTL` 的 RGB/BGR 位，不能在业务 UI
   中交换颜色常量掩盖问题。
4. 若画面整体偏移，再依据实物玻璃批次调整列/行起始偏移；当前代码按
   128×160、起始偏移 0 实现。
