# 四站 190 mm UWB 报告图（2026-08-01）

所有实测验证图均为**当前冻结 v1**。当前固件/模型标签的唯一事实源是
`code/c_digital_key_lock_190mm_four_station`：四站模型符号
`g_four_station_model_20260801`，估计器源码
`uwb_four_station_estimator.c`。不使用
`c_digital_key_lock_145mm_full` 作为当前工程。

回放数值仍只来自四站校准清单、benchmark JSON 与实际 JSONL 采集；采用“整物理点留出”，不会把同一物理点的重复采集或滚动窗口同时放入训练和测试。

几何图按本报告任务指定坐标绘制：UWB1 `(-95, 0)`、UWB2 `(+95, 0)`、UWB3 `(0, -70)`、UWB4 `(0, +75)` mm；清单中的原始几何字段也保留在 `metrics_summary.json` 以便追溯。

空间图的背景样式依据 `比赛文档/官方题目/C题_基于无线通信的数字钥匙实验系统.pdf`
第 3 页图 2 重绘为矢量层：浅绿开锁区（0–1 m）、中性灰迎宾区（1–2 m）、浅蓝感应区（>2 m）、±45°边界与门锁圆体；未粘贴或放大低分辨率截图。

当前部署候选：`knn-k3-p0.5-station+ridge-angle`（3-NN、q 的逆平方根加权、station scales + ridge angle）。

- `01_geometry.*`：官方场地矢量底图上的四站坐标、门锁圆体和边界距离/中心距离定义。
- `02_sample_coverage.*`：官方场地矢量底图上的 27 个物理点覆盖及每点完成采集次数。
- `03_point_holdout_truth_vs_prediction.*`：留出整物理点时的真值与预测，附官方场地中的空间落点。
- `04_rolling_window_error_distribution_cdf.*`：实际 0.8 s 回放窗口的误差分布与 CDF。
- `05_distance_angle_error_heatmaps.*`：距离–角度物理点网格上的实际回放 MAE。
- `06_algorithm_comparison.*`：基准中前 12 个部署候选的滚动窗口距离指标。
- `07_quality_gate_coverage.*`：高/中等质量门的覆盖率及误差。
- `08_boundary_validation_1m_2m.*`：用官方分区配色的 1 m 解锁、2 m 迎宾边界窗口级散点与混淆矩阵；预测边界距离 = 预测中心距离 − 300 mm。当前数据的 2 m 阈值外真值样本为 0，因此该部分只评估阈值内漏报，不能视为完整 2 m 边界判定验证。
- `09_static_calibration_point_replay.*`：官方场地矢量底图上的实际静态校准点回放静帧；**不代表动态轨迹**。
- `09_static_calibration_point_replay.gif`：同一静态点的实际窗口回放动画；**不代表动态轨迹**。
- `10_dual_output_distance_pipeline.*`：回归 + 1 m 解锁/2 m 迎宾边界专项校正的双输出距离路径。当前四站模型头文件和估计器源码中未发现双输出距离表述；因此双输出图是 **planned / not yet validated**，不属于当前冻结 v1。

冻结 v1 的实际回放指标（窗口数 16,931）：

- 距离：MAE 37.902 mm，P95 144.732 mm。
- 角度：MAE 19.677°，P95 44.713°。
- 高质量门覆盖率：46.18%；中等质量门覆盖率：67.41%。

## 复现

从仓库根目录运行：

```bash
python3 code/c_digital_key_lock/tools/generate_four_station_report_figures.py
```

若补录真实 1 m / 2 m 边界附近的静态数据，先更新冻结模型清单和 benchmark，再重跑此脚本。脚本会把重新计算的 replay 指标与 benchmark JSON 断言比对；不一致时会失败而不是写出不可信的图。
