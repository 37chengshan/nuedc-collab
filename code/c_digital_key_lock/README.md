# C 题数字钥匙门锁固件骨架

该工程是 `MSPM0G3507 + CCS + SysConfig` 的数字钥匙固件，当前按“确定的
定位和安全逻辑进入生产代码，未确认接线隔离在 BSP”组织：

- UWB_CH1：`UART1`，TX=`PA8`，RX=`PA9`，`115200 8N1`
- UWB_CH2：`UART3`，TX=`PA26`，RX=`PA25`，`115200 8N1`
- 定位和标定模型统一支持 2～4 基站；当前物理接线只启用前两路
- 第 3/4 路需在实测外设实例和引脚后再加入 `.syscfg`
- ST7735S、LED、蜂鸣器、锁执行器和最终拨码/按键 GPIO 仍在 BSP 中保留占位

## 当前模块

- `uwb_text_protocol.*`：UWB 文本帧行缓存与解析
- `uwb_fusion.*`：四通道缓存、同地址时间窗融合、补偿和 Kalman 滤波
- `trilateration.*`：2～4 基站统一定位、双圆镜像消歧、NLOS 剔除
- `calibration_model.*`：900 字节模型 ABI、CRC、测距和双线性补偿算法
- `calibration_model_data.*`：可由 UWB Lab 导出文件直接替换的只读模型
- `id_input.*`：临时四按键翻转输入，兼容未来拨码直读
- `lock_fsm.*`：授权、迎宾、开锁、拒绝与短时保持状态机
- `lock_app.*`：业务编排与对 BSP 的统一输出模型
- `lock_hw.*` / `lock_hw_mspm0.c`：硬件适配层

## 当前安全行为

- 标签标准帧 `P,1111,10cm\r\n` 解析为钥匙地址低 4 bit `0x1`、距离 `100 mm`。
- 临时四按键在稳定按下 30 ms 后翻转对应位，长按不重复；必须释放后才能再次翻转。
- 未来拨码后端继续输出相同的 4 bit 逻辑值，应用层不需要修改。
- 2～4 路完整地址必须一致，不能只按低 4 bit ID 混合不同钥匙。
- 两基站使用前方区域和上一帧位置解决镜像；三基站可剔除异常路并降级；
  四基站执行单路 leave-one-out NLOS 检查。
- 开锁进入阈值 1.00 m、离开阈值 1.05 m；迎宾进入 2.00 m、离开
  2.05 m；状态变化需要连续 3 帧确认。
- 短时丢帧保持上一位置，超时、ID 不匹配、模型损坏或定位失效立即禁止开锁。

## 主机侧回归

Windows：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\run_tests.ps1
```

Linux/macOS：

```bash
./tests/run_tests.sh
```

测试使用系统 C11 编译器，不依赖 TI SDK，可在不上板时验证协议、输入、融合、
定位、模型 CRC、补偿和状态机。

## TI SysConfig 与固件构建

不要手改 `generated/ti_msp_dl_config.c/.h`。在本目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build.ps1
```

脚本会重新生成 SysConfig、使用 TI Arm Clang 编译并输出：

```text
build\c_digital_key_lock.out
build\c_digital_key_lock.hex
build\c_digital_key_lock.map
```

当前构建结果为 `text=28576 B`、`bss=832 B`，低于方案要求的
Flash 96 KB 和 SRAM 20 KB。

## 标定模型替换

UWB Lab 默认导出：

```text
calibration_model_data.c
calibration_model_data.h
calibration_model_data.json
```

将导出的 `.c/.h` 覆盖本目录同名文件后重新运行 `build.ps1`。模型源文件不包含
SysConfig 输出，也不需要修改定位算法。上电会检查模型 magic、版本、尺寸和
CRC32，失败时进入 `LOCK_STATE_CALIBRATION_ERROR` 并保持闭锁。

## 明确未验证项

- 第 3/4 路 UWB 的实际 UART 实例、引脚、电平和与调试口冲突
- ST7735S 刷屏接口与时序
- 红绿 LED、迎宾灯、蜂鸣器和锁执行器的实际接线
- 临时四按键输入 GPIO 以及未来拨码输入 GPIO
- 第 3/4 个基站的实测锚点坐标
- 真实板卡烧录、显示和锁执行器联调；当前验证止于主机测试、SysConfig 和构建
