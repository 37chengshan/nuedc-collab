#!/usr/bin/env python3
"""Generate reproducible report figures for the frozen 2026-08-01 UWB v1.

The script consumes only the checked calibration manifest/benchmark plus the
recorded JSONL captures.  Validation is leave-one-physical-point-out: every
repeat capture and every rolling window at a physical point stay test-only.

Outputs are intentionally confined to:
比赛设计/总体方案/仿真图/四站190mm_20260801/
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable
from xml.etree import ElementTree

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib import animation, font_manager
from matplotlib.colors import ListedColormap
from matplotlib.patches import (
    Arc,
    Circle,
    FancyArrowPatch,
    FancyBboxPatch,
    Patch,
    Rectangle,
    Wedge,
)
from matplotlib.ticker import FuncFormatter, MultipleLocator
from PIL import Image

from build_four_station_model import error_metrics, fit_angle_linear, predict_angle_linear
from evaluate_four_station_model import (
    DEFAULT_CAPTURES,
    knn_estimate,
    model_scales,
    point_key,
    rolling_vectors,
)


SCRIPT_PATH = Path(__file__).resolve()
PROJECT_ROOT = SCRIPT_PATH.parents[3]
MODULE_DIR = SCRIPT_PATH.parents[1]
DEFAULT_MANIFEST = MODULE_DIR / "calibration" / "four_station_20260801.json"
DEFAULT_BENCHMARK = MODULE_DIR / "calibration" / "four_station_20260801_benchmark.json"
DEFAULT_OUTPUT = (
    PROJECT_ROOT / "比赛设计" / "总体方案" / "仿真图" / "四站190mm_20260801"
)
FIRMWARE_PROJECT_DIR = PROJECT_ROOT / "code" / "c_digital_key_lock_190mm_four_station"
FIRMWARE_MODEL_HEADER = "four_station_model_data.h"
FIRMWARE_ESTIMATOR_SOURCE = "uwb_four_station_estimator.c"
OFFICIAL_MAP_SOURCE = (
    PROJECT_ROOT / "比赛文档" / "官方题目" / "C题_基于无线通信的数字钥匙实验系统.pdf"
)

CURRENT_V1 = "四站 190 mm · 2026-08-01 实测 · 整物理点留出验证"
DUAL_OUTPUT_UNCONFIRMED = "当前源码证据不足"
REPORT_FIRMWARE_CAPTION = "固件工程标签待加载"
PNG_DPI = 300
BOUNDARY_OFFSET_MM = 300
OFFICIAL_MAP_MAX_CENTER_MM = 3300
QUALITY_HIGH = {
    "nearestQ": 0.40,
    "neighborSpanMm": 400,
    "madMaxMm": 100,
    "sampleMin": 5,
}
QUALITY_MEDIUM = {
    "nearestQ": 0.80,
    "neighborSpanMm": 800,
    "madMaxMm": 150,
    "sampleMin": 4,
}
REPORT_STATIONS = (
    ("UWB1", 95, 0),
    ("UWB2", -95, 0),
    ("UWB3", 0, 70),
    ("UWB4", 0, -75),
)
OFFICIAL_COLORS = {
    "sensing": "#DCEEF8",
    "welcome": "#FFF1CC",
    "unlock": "#F8D7DA",
    "lock": "#E9EEF5",
    "edge": "#2F3A45",
    "ray": "#64748B",
    "station": "#B33A3A",
    "truth": "#087F8C",
    "prediction": "#D95D39",
}
OFFICIAL_ZONE_LABELS = {
    "sensing": "感应区（>2 m）",
    "welcome": "迎宾区（1–2 m）",
    "unlock": "开锁区（0–1 m）",
}


def configure_chinese_font() -> str:
    """Use a locally installed CJK-capable macOS font for Chinese labels."""

    candidates = (
        Path("/System/Library/Fonts/STHeiti Light.ttc"),
        Path("/System/Library/Fonts/STHeiti Medium.ttc"),
    )
    for path in candidates:
        if path.is_file():
            font_manager.fontManager.addfont(str(path))
            font_name = font_manager.FontProperties(fname=str(path)).get_name()
            plt.rcParams["font.sans-serif"] = [
                font_name,
                "PingFang SC",
                "Hiragino Sans GB",
                "Arial Unicode MS",
            ]
            plt.rcParams["font.family"] = "sans-serif"
            plt.rcParams["axes.unicode_minus"] = False
            plt.rcParams.update(
                {
                    "figure.facecolor": "#FFFFFF",
                    "savefig.facecolor": "#FFFFFF",
                    "axes.facecolor": "#FFFFFF",
                    "axes.edgecolor": "#CBD5E1",
                    "axes.labelcolor": "#334155",
                    "axes.titlecolor": "#172033",
                    "axes.titleweight": "semibold",
                    "axes.titlesize": 12.5,
                    "axes.labelsize": 10.5,
                    "xtick.color": "#475569",
                    "ytick.color": "#475569",
                    "xtick.labelsize": 9.5,
                    "ytick.labelsize": 9.5,
                    "grid.color": "#CBD5E1",
                    "grid.alpha": 0.42,
                    "grid.linestyle": ":",
                    "legend.frameon": True,
                    "legend.framealpha": 0.96,
                    "legend.edgecolor": "#CBD5E1",
                    "figure.titlesize": 17,
                }
            )
            return font_name
    raise RuntimeError("未找到可用中文字体：需要 STHeiti Light/Medium")


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def load_firmware_labels(firmware_project: Path) -> dict[str, Any]:
    """Read current firmware/model labels from the formal 190 mm project."""

    project = firmware_project.resolve()
    if project != FIRMWARE_PROJECT_DIR.resolve():
        raise ValueError(f"固件事实源必须为：{FIRMWARE_PROJECT_DIR}")
    header_path = project / FIRMWARE_MODEL_HEADER
    estimator_path = project / FIRMWARE_ESTIMATOR_SOURCE
    if not header_path.is_file() or not estimator_path.is_file():
        raise FileNotFoundError("正式四站模型头文件或估计器源文件不存在")
    header_text = header_path.read_text(encoding="utf-8")
    model_match = re.search(
        r"extern\s+const\s+UwbFourStationModel\s+(\w+)\s*;",
        header_text,
    )
    if model_match is None:
        raise RuntimeError(f"无法从 {header_path.name} 解析四站模型符号")
    estimator_text = estimator_path.read_text(encoding="utf-8")
    estimator_header_path = project / "uwb_four_station_estimator.h"
    lock_fsm_path = project / "lock_fsm.c"
    estimator_header_text = estimator_header_path.read_text(encoding="utf-8")
    lock_fsm_text = lock_fsm_path.read_text(encoding="utf-8")
    has_center_output = (
        "center_distance_mm" in estimator_header_text
        and "center_distance_mm" in estimator_text
    )
    has_boundary_output = (
        "boundary_distance_mm" in estimator_header_text
        and "boundary_distance_mm" in estimator_text
    )
    has_boundary_state_path = (
        "unlock_radius_mm" in lock_fsm_text
        and "welcome_radius_mm" in lock_fsm_text
        and "unlock_exit_radius_mm" in lock_fsm_text
        and "welcome_exit_radius_mm" in lock_fsm_text
    )
    dual_output_present = (
        has_center_output and has_boundary_output and has_boundary_state_path
    )
    dual_output_evidence = [
        item
        for item, present in (
            ("center_distance_mm 连续中心距离输出", has_center_output),
            ("boundary_distance_mm 比赛边界距离输出", has_boundary_output),
            ("1 m / 2 m 入口、退出迟滞状态路径", has_boundary_state_path),
        )
        if present
    ]
    return {
        "projectDirectory": str(project.relative_to(PROJECT_ROOT)),
        "projectName": project.name,
        "fourStationModelHeader": FIRMWARE_MODEL_HEADER,
        "fourStationModelSymbol": model_match.group(1),
        "fourStationEstimatorSource": FIRMWARE_ESTIMATOR_SOURCE,
        "dualOutputEvidence": dual_output_evidence,
        "dualOutputPresentInCurrentProject": dual_output_present,
    }


def set_report_firmware_caption(firmware: dict[str, Any]) -> None:
    global REPORT_FIRMWARE_CAPTION
    REPORT_FIRMWARE_CAPTION = (
        f"固件工程：{firmware['projectName']}；"
        f"四站模型：{firmware['fourStationModelSymbol']}"
    )


def title_v1(title: str) -> str:
    return f"{title}\n{CURRENT_V1}"


def point_xy(center_distance_mm: float, angle_deg: float) -> tuple[float, float]:
    """Convert atan2(x, y) angle convention to chart coordinates."""

    radians = math.radians(angle_deg)
    return center_distance_mm * math.sin(radians), center_distance_mm * math.cos(radians)


def official_zone_legend() -> list[Patch]:
    return [
        Patch(facecolor=OFFICIAL_COLORS["unlock"], edgecolor=OFFICIAL_COLORS["edge"],
              label=OFFICIAL_ZONE_LABELS["unlock"]),
        Patch(facecolor=OFFICIAL_COLORS["welcome"], edgecolor=OFFICIAL_COLORS["edge"],
              label=OFFICIAL_ZONE_LABELS["welcome"]),
        Patch(facecolor=OFFICIAL_COLORS["sensing"], edgecolor=OFFICIAL_COLORS["edge"],
              label=OFFICIAL_ZONE_LABELS["sensing"]),
    ]


def draw_official_map_background(
    ax: plt.Axes,
    *,
    max_radius_mm: float = 2700,
    label_zones: bool = True,
    label_angles: bool = True,
    label_lock: bool = False,
) -> None:
    """Redraw the official competition map as clean vector geometry.

    The radial coordinate is the model center distance. The three displayed
    zones use boundary distance, so their model radii are 300, 1300, and
    2300 mm respectively.
    """

    inner_lock_mm = BOUNDARY_OFFSET_MM
    unlock_outer_mm = 1000 + BOUNDARY_OFFSET_MM
    welcome_outer_mm = 2000 + BOUNDARY_OFFSET_MM
    # Matplotlib angles are measured from +x; atan2(x, y) maps -/+45° to
    # standard polar angles 135°/45°.
    for inner, outer, color in (
        (welcome_outer_mm, max_radius_mm, OFFICIAL_COLORS["sensing"]),
        (unlock_outer_mm, welcome_outer_mm, OFFICIAL_COLORS["welcome"]),
        (inner_lock_mm, unlock_outer_mm, OFFICIAL_COLORS["unlock"]),
    ):
        ax.add_patch(Wedge(
            (0, 0),
            outer,
            45,
            135,
            width=outer - inner,
            facecolor=color,
            edgecolor=OFFICIAL_COLORS["edge"],
            linewidth=1.25,
            zorder=0,
        ))
    ax.add_patch(Circle(
        (0, 0), inner_lock_mm, facecolor=OFFICIAL_COLORS["lock"],
        edgecolor=OFFICIAL_COLORS["edge"], linewidth=1.5, zorder=2,
    ))
    for angle in (-45, 45):
        x, y = point_xy(max_radius_mm, angle)
        ax.plot([0, x], [0, y], linestyle=(0, (7, 6)), color=OFFICIAL_COLORS["ray"],
                linewidth=1.05, zorder=1)
        if label_angles:
            label_x, label_y = point_xy(max_radius_mm * 1.015, angle)
            ax.text(label_x, label_y, f"{angle:+d}°", ha="center", va="center",
                    fontsize=10, color=OFFICIAL_COLORS["ray"], zorder=5)
    for radius, angle, label, color in (
        (800, 35, "开锁区", "#5c7925"),
        (1750, 32, "迎宾区", "#555555"),
        (2500, 0, "感应区", "#32718b"),
    ):
        x, y = point_xy(radius, angle)
        if label_zones:
            ax.text(x, y, label, ha="center", va="center", fontsize=12,
                    fontweight="bold", color=color, zorder=4,
                    bbox={"boxstyle": "round,pad=0.20", "fc": "white", "ec": "none", "alpha": 0.68})
    if label_lock:
        ax.text(0, 0, "智能\n门锁", ha="center", va="center", fontsize=11,
                fontweight="bold", zorder=5)
    ax.annotate(
        "智能门锁正前方\n+y",
        xy=(0, inner_lock_mm),
        xytext=(0, inner_lock_mm + 455),
        ha="center",
        va="bottom",
        fontsize=10.5,
        arrowprops={"arrowstyle": "-|>", "lw": 1.25, "color": OFFICIAL_COLORS["ray"]},
        zorder=5,
    )


def shade_official_distance_axes(
    ax: plt.Axes,
    *,
    minimum_boundary_mm: float = 500,
    maximum_boundary_mm: float = 2200,
    value_offset_mm: float = 0,
) -> None:
    """Apply official zone colors to a true/predicted boundary-distance plot."""

    minimum = minimum_boundary_mm + value_offset_mm
    unlock_outer = 1000 + value_offset_mm
    welcome_outer = 2000 + value_offset_mm
    maximum = maximum_boundary_mm + value_offset_mm
    ax.axvspan(minimum, unlock_outer, facecolor=OFFICIAL_COLORS["unlock"],
               alpha=0.78, zorder=0)
    ax.axvspan(unlock_outer, welcome_outer, facecolor=OFFICIAL_COLORS["welcome"],
               alpha=0.78, zorder=0)
    ax.axvspan(welcome_outer, maximum, facecolor=OFFICIAL_COLORS["sensing"],
               alpha=0.78, zorder=0)
    ax.axhspan(minimum, unlock_outer, facecolor=OFFICIAL_COLORS["unlock"],
               alpha=0.34, zorder=0)
    ax.axhspan(unlock_outer, welcome_outer, facecolor=OFFICIAL_COLORS["welcome"],
               alpha=0.34, zorder=0)
    ax.axhspan(welcome_outer, maximum, facecolor=OFFICIAL_COLORS["sensing"],
               alpha=0.34, zorder=0)


def compact_metric(errors: Iterable[float]) -> dict[str, float | int]:
    values = [float(value) for value in errors]
    result = error_metrics(values)
    return {
        "count": int(result["count"]),
        "mae": float(result["maeMmOrDeg"]),
        "p95": float(result["p95MmOrDeg"]),
        "max": float(result["maxMmOrDeg"]),
    }


def marker_for_angle(angle: float) -> str:
    return {-45.0: "v", -30.0: "<", -22.5: "P", -15.0: "s", 0.0: "o",
            15.0: "D", 22.5: "X", 30.0: ">", 45.0: "^"}.get(float(angle), "o")


def save_static_figure(fig: plt.Figure, output_dir: Path, stem: str) -> list[str]:
    """Write raster and report-friendly vector variants of one figure."""

    generated: list[str] = []
    for extension in ("png", "svg", "pdf"):
        path = output_dir / f"{stem}.{extension}"
        save_args: dict[str, Any] = {"bbox_inches": "tight"}
        if extension == "png":
            save_args["dpi"] = PNG_DPI
        fig.savefig(path, **save_args)
        generated.append(path.name)
    plt.close(fig)
    return generated


def build_replay_records(
    manifest: dict[str, Any],
    captures_dir: Path,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, list[dict[str, Any]]]]:
    """Re-evaluate the exact frozen v1 candidate over actual rolling windows."""

    prototypes = list(manifest["prototypes"])
    grouped_captures: dict[tuple[int, float], list[dict[str, Any]]] = defaultdict(list)
    for capture in manifest["captures"]:
        grouped_captures[point_key(capture)].append(capture)

    replay_cache = {
        str(capture["captureId"]): rolling_vectors(captures_dir, capture)
        for capture in manifest["captures"]
    }
    point_records: list[dict[str, Any]] = []
    window_records: list[dict[str, Any]] = []

    for held_out in prototypes:
        truth = point_key(held_out)
        training = [row for row in prototypes if point_key(row) != truth]
        scales = model_scales(training)
        angle_model = fit_angle_linear(training)
        estimate = knn_estimate(
            [float(value) for value in held_out["rangesMm"]],
            training,
            scales,
            neighbors=3,
            q_floor=0.0004,
            power=0.5,
        )
        point_records.append(
            {
                "truthCenterMm": truth[0],
                "truthBoundaryMm": truth[0] - BOUNDARY_OFFSET_MM,
                "truthAngleDeg": truth[1],
                "predCenterMm": estimate[0],
                "predBoundaryMm": estimate[0] - BOUNDARY_OFFSET_MM,
                "predAngleDeg": predict_angle_linear(
                    [float(value) for value in held_out["rangesMm"]], angle_model
                ),
                "nearestQ": estimate[2],
                "neighborSpanMm": estimate[3],
            }
        )
        for capture in grouped_captures[truth]:
            capture_id = str(capture["captureId"])
            for vector in replay_cache[capture_id]:
                estimate = knn_estimate(
                    [float(value) for value in vector["rangesMm"]],
                    training,
                    scales,
                    neighbors=3,
                    q_floor=0.0004,
                    power=0.5,
                )
                predicted_angle = predict_angle_linear(
                    [float(value) for value in vector["rangesMm"]], angle_model
                )
                snr_values = [
                    float(value) for value in vector["snrDb"] if value is not None
                ]
                record = {
                    "captureId": capture_id,
                    "nowMs": int(vector["nowMs"]),
                    "truthCenterMm": truth[0],
                    "truthBoundaryMm": truth[0] - BOUNDARY_OFFSET_MM,
                    "truthAngleDeg": truth[1],
                    "predCenterMm": estimate[0],
                    "predBoundaryMm": estimate[0] - BOUNDARY_OFFSET_MM,
                    "predAngleDeg": predicted_angle,
                    "distanceErrorMm": abs(estimate[0] - truth[0]),
                    "angleErrorDeg": abs(predicted_angle - truth[1]),
                    "nearestQ": estimate[2],
                    "neighborSpanMm": estimate[3],
                    "madMaxMm": max(float(value) for value in vector["madMm"]),
                    "sampleMin": min(int(value) for value in vector["sampleCount"]),
                    "snrMinDb": min(snr_values) if snr_values else None,
                    "rangesMm": [float(value) for value in vector["rangesMm"]],
                }
                record["highQuality"] = (
                    record["nearestQ"] <= QUALITY_HIGH["nearestQ"]
                    and record["neighborSpanMm"] <= QUALITY_HIGH["neighborSpanMm"]
                    and record["madMaxMm"] <= QUALITY_HIGH["madMaxMm"]
                    and record["sampleMin"] >= QUALITY_HIGH["sampleMin"]
                )
                record["mediumQuality"] = (
                    record["nearestQ"] <= QUALITY_MEDIUM["nearestQ"]
                    and record["neighborSpanMm"] <= QUALITY_MEDIUM["neighborSpanMm"]
                    and record["madMaxMm"] <= QUALITY_MEDIUM["madMaxMm"]
                    and record["sampleMin"] >= QUALITY_MEDIUM["sampleMin"]
                )
                window_records.append(record)
    return point_records, window_records, replay_cache


def build_current_metrics(
    point_records: list[dict[str, Any]], window_records: list[dict[str, Any]]
) -> dict[str, Any]:
    high = [row for row in window_records if row["highQuality"]]
    medium = [row for row in window_records if row["mediumQuality"]]
    return {
        "model": "knn-k3-p0.5-station+ridge-angle",
        "validationSplit": "leave-one-physical-point-out",
        "pointDistance": compact_metric(
            abs(row["predCenterMm"] - row["truthCenterMm"]) for row in point_records
        ),
        "pointAngle": compact_metric(
            abs(row["predAngleDeg"] - row["truthAngleDeg"]) for row in point_records
        ),
        "windowDistance": compact_metric(row["distanceErrorMm"] for row in window_records),
        "windowAngle": compact_metric(row["angleErrorDeg"] for row in window_records),
        "highCoverage": len(high) / len(window_records),
        "highDistance": compact_metric(row["distanceErrorMm"] for row in high),
        "highAngle": compact_metric(row["angleErrorDeg"] for row in high),
        "mediumCoverage": len(medium) / len(window_records),
        "mediumDistance": compact_metric(row["distanceErrorMm"] for row in medium),
    }


def assert_metrics_match_benchmark(current: dict[str, Any], benchmark: dict[str, Any]) -> None:
    """Fail closed if replay data no longer matches the frozen benchmark."""

    expected = benchmark["winner"]
    if expected["id"] != current["model"]:
        raise RuntimeError(
            f"基准赢家不是冻结部署模型：{expected['id']} != {current['model']}"
        )
    for group in (
        "pointDistance",
        "pointAngle",
        "windowDistance",
        "windowAngle",
        "highDistance",
        "highAngle",
        "mediumDistance",
    ):
        for metric in ("count", "mae", "p95", "max"):
            actual = float(current[group][metric])
            reference = float(expected[group][metric])
            if not math.isclose(actual, reference, rel_tol=0.0, abs_tol=1e-8):
                raise RuntimeError(
                    f"回放指标与基准不一致：{group}.{metric}={actual}，"
                    f"期望 {reference}"
                )
    for metric in ("highCoverage", "mediumCoverage"):
        if not math.isclose(
            float(current[metric]), float(expected[metric]), rel_tol=0.0, abs_tol=1e-12
        ):
            raise RuntimeError(f"回放指标与基准不一致：{metric}")


def figure_geometry(manifest: dict[str, Any]) -> plt.Figure:
    fig, ax = plt.subplots(figsize=(12.8, 7.2), constrained_layout=True)
    draw_official_map_background(ax, max_radius_mm=2700)
    ax.scatter(0, 0, s=16, c="#1d3557", zorder=4)
    label_positions = {
        "UWB1": (-610, 155),
        "UWB2": (610, 155),
        "UWB3": (-610, -205),
        "UWB4": (610, -205),
    }
    for name, x, y in REPORT_STATIONS:
        ax.scatter(x, y, s=90, marker="s", c="#c94d5d", zorder=6)
        label_x, label_y = label_positions[name]
        ax.annotate(
            f"{name}\n({x:+.0f}, {y:+.0f}) mm",
            (x, y),
            xytext=(label_x, label_y),
            textcoords="data",
            ha="center",
            va="center",
            fontsize=9.5,
            arrowprops={"arrowstyle": "-", "lw": 0.75, "color": "#555"},
        )
    ax.annotate(
        "圆形门锁半径 = 300 mm；标注边界距离 d，模型中心距离 r = d + 300 mm",
        xy=(-2220, -350),
        ha="left",
        va="top",
        fontsize=10.5,
        bbox={"boxstyle": "round,pad=0.38", "fc": "white", "ec": "#8fb3d9"},
    )
    ax.set_title(title_v1("四站 UWB 几何与官方测试场地区域"), fontweight="bold")
    ax.set_xlabel("右方 x / mm")
    ax.set_ylabel("前方 y / mm")
    ax.set_aspect("equal")
    ax.set_xlim(-2350, 2350)
    ax.set_ylim(-450, 2800)
    ax.grid(False)
    ax.legend(handles=official_zone_legend(), loc="lower right", ncol=3,
              fontsize=9, framealpha=0.96)
    return fig


def figure_sample_coverage(manifest: dict[str, Any]) -> plt.Figure:
    prototypes = list(manifest["prototypes"])
    captures = list(manifest["captures"])
    fig, axes = plt.subplots(
        1,
        2,
        figsize=(14.8, 7.2),
        constrained_layout=True,
        gridspec_kw={"width_ratios": [1.3, 1]},
    )
    ax = axes[0]
    draw_official_map_background(ax, max_radius_mm=2700)
    for angle in sorted({float(row["angleDeg"]) for row in prototypes}):
        rows = [row for row in prototypes if float(row["angleDeg"]) == angle]
        xy = np.array([point_xy(float(row["centerDistanceMm"]), angle) for row in rows])
        ax.scatter(
            xy[:, 0],
            xy[:, 1],
            s=58,
            marker=marker_for_angle(angle),
            label=f"{angle:g}°",
            alpha=0.92,
            edgecolors="#303030",
            linewidths=0.28,
            zorder=6,
        )
    for _, x, y in REPORT_STATIONS:
        ax.scatter(x, y, c="#c94d5d", marker="s", s=44, zorder=7)
    ax.set_aspect("equal")
    ax.set_xlabel("右方 x / mm")
    ax.set_ylabel("前方 y / mm")
    ax.set_title("物理点空间覆盖（中心坐标）")
    ax.set_xlim(-2350, 2350)
    ax.set_ylim(-450, 2800)
    ax.grid(False)
    ax.legend(title="真值角度", ncol=3, fontsize=8, loc="lower right",
              framealpha=0.95)

    ax = axes[1]
    grouped: dict[tuple[int, float], int] = defaultdict(int)
    for capture in captures:
        grouped[point_key(capture)] += 1
    centers = sorted({key[0] for key in grouped})
    angles = sorted({key[1] for key in grouped})
    matrix = np.full((len(angles), len(centers)), np.nan)
    for row, angle in enumerate(angles):
        for col, center in enumerate(centers):
            if (center, angle) in grouped:
                matrix[row, col] = grouped[(center, angle)]
    image = ax.imshow(matrix, aspect="auto", cmap="Blues", vmin=0, vmax=max(grouped.values()))
    ax.set_xticks(range(len(centers)), [f"{center - 300:g}" for center in centers])
    ax.set_yticks(range(len(angles)), [f"{angle:g}" for angle in angles])
    for row in range(matrix.shape[0]):
        for col in range(matrix.shape[1]):
            if not np.isnan(matrix[row, col]):
                ax.text(col, row, f"{int(matrix[row, col])}", ha="center", va="center")
    ax.set_xlabel("边界距离 / mm")
    ax.set_ylabel("真值角度 / °")
    ax.set_title("每物理点的完成采集次数")
    colorbar = fig.colorbar(image, ax=ax, shrink=0.88)
    colorbar.set_label("采集次数")
    fig.suptitle(
        title_v1("样本覆盖：官方场地扇区内的 27 个物理点、45 段完成采集"),
        fontweight="bold",
    )
    return fig


def figure_point_holdout(point_records: list[dict[str, Any]]) -> plt.Figure:
    fig, axes = plt.subplots(1, 3, figsize=(16, 6.8), constrained_layout=True)
    truths_d = np.array([row["truthCenterMm"] for row in point_records])
    preds_d = np.array([row["predCenterMm"] for row in point_records])
    truths_a = np.array([row["truthAngleDeg"] for row in point_records])
    preds_a = np.array([row["predAngleDeg"] for row in point_records])
    shade_official_distance_axes(
        axes[0],
        minimum_boundary_mm=700,
        maximum_boundary_mm=2100,
        value_offset_mm=BOUNDARY_OFFSET_MM,
    )
    for angle in sorted(set(truths_a)):
        mask = truths_a == angle
        axes[0].scatter(
            truths_d[mask],
            preds_d[mask],
            s=62,
            marker=marker_for_angle(angle),
            label=f"{angle:g}°",
            edgecolors="#303030",
            linewidths=0.3,
            zorder=4,
        )
    bounds = [min(truths_d.min(), preds_d.min()) - 80, max(truths_d.max(), preds_d.max()) + 80]
    axes[0].plot(bounds, bounds, "--", color="#444", lw=1.4, label="理想 y=x")
    axes[0].set_xlim(bounds)
    axes[0].set_ylim(bounds)
    axes[0].set_aspect("equal", adjustable="box")
    axes[0].set_xlabel("真值中心距离 / mm")
    axes[0].set_ylabel("预测中心距离 / mm")
    axes[0].set_title("距离：留出物理点")
    axes[0].grid(True, linestyle=":", alpha=0.38)
    axes[0].legend(title="真值角度", ncol=3, fontsize=7.5, loc="upper left")

    colors = plt.cm.coolwarm((truths_d - truths_d.min()) / (truths_d.max() - truths_d.min()))
    axes[1].scatter(truths_a, preds_a, c=colors, s=70, edgecolor="#333", linewidth=0.35)
    axes[1].plot([-50, 50], [-50, 50], "--", color="#444", lw=1.4)
    axes[1].set_xlim(-52, 52)
    axes[1].set_ylim(-65, 65)
    axes[1].set_aspect("equal", adjustable="box")
    axes[1].set_xlabel("真值角度 / °")
    axes[1].set_ylabel("预测角度 / °")
    axes[1].set_title("角度：岭回归，留出物理点")
    axes[1].grid(True, linestyle=":", alpha=0.55)
    
    map_ax = axes[2]
    draw_official_map_background(map_ax, max_radius_mm=2700, label_zones=False)
    for name, x, y in REPORT_STATIONS:
        map_ax.scatter(x, y, c="#c94d5d", marker="s", s=38, zorder=7)
    for row in point_records:
        truth_x, truth_y = point_xy(row["truthCenterMm"], row["truthAngleDeg"])
        pred_x, pred_y = point_xy(row["predCenterMm"], row["predAngleDeg"])
        map_ax.plot([truth_x, pred_x], [truth_y, pred_y], color="#666",
                    linewidth=0.55, alpha=0.42, zorder=3)
        map_ax.scatter(
            truth_x, truth_y, s=38, marker=marker_for_angle(row["truthAngleDeg"]),
            c="#2a9d8f", edgecolors="#173f3a", linewidths=0.25, zorder=5,
        )
        map_ax.scatter(
            pred_x, pred_y, s=22, marker="o", c="#e76f51",
            edgecolors="#5a1f18", linewidths=0.25, zorder=6,
        )
    map_ax.scatter([], [], marker="*", s=60, c="#2a9d8f", label="真值点")
    map_ax.scatter([], [], marker="o", s=35, c="#e76f51", label="v1 预测")
    map_ax.set_xlim(-2350, 2350)
    map_ax.set_ylim(-450, 2800)
    map_ax.set_aspect("equal")
    map_ax.set_xlabel("右方 x / mm")
    map_ax.set_ylabel("前方 y / mm")
    map_ax.set_title("空间落点：真值与 v1 预测")
    map_ax.legend(loc="lower right", fontsize=8, framealpha=0.95)
    fig.suptitle(title_v1("点级真值 vs. 预测（每个物理点整体留出）"), fontweight="bold")
    return fig


def empirical_cdf(values: Iterable[float]) -> tuple[np.ndarray, np.ndarray]:
    ordered = np.sort(np.asarray(list(values), dtype=float))
    return ordered, np.arange(1, len(ordered) + 1) / len(ordered)


def figure_rolling_errors(
    window_records: list[dict[str, Any]], metrics: dict[str, Any]
) -> plt.Figure:
    fig, axes = plt.subplots(2, 2, figsize=(14, 9.2), constrained_layout=True)
    distance = np.array([row["distanceErrorMm"] for row in window_records])
    angle = np.array([row["angleErrorDeg"] for row in window_records])
    pairs = (
        (axes[0, 0], distance, "距离绝对误差 / mm", "#2a6fbb"),
        (axes[0, 1], angle, "角度绝对误差 / °", "#d1495b"),
    )
    for ax, values, label, color in pairs:
        ax.hist(values, bins=55, color=color, alpha=0.84, edgecolor="white")
        ax.axvline(np.mean(values), color="#222", ls="--", lw=1.3, label=f"MAE {np.mean(values):.1f}")
        ax.axvline(np.percentile(values, 95), color="#f4a261", ls="--", lw=1.3,
                   label=f"P95 {np.percentile(values, 95):.1f}")
        ax.set_xlabel(label)
        ax.set_ylabel("滚动窗口数")
        ax.grid(axis="y", linestyle=":", alpha=0.5)
        ax.legend()
    for ax, values, label, color in (
        (axes[1, 0], distance, "距离绝对误差 / mm", "#2a6fbb"),
        (axes[1, 1], angle, "角度绝对误差 / °", "#d1495b"),
    ):
        x, y = empirical_cdf(values)
        ax.plot(x, y, color=color, lw=2.1)
        ax.axhline(0.95, color="#888", ls=":", lw=1.1)
        ax.axvline(np.percentile(values, 95), color="#f4a261", ls="--", lw=1.2)
        ax.set_xlabel(label)
        ax.set_ylabel("经验累积分布")
        ax.set_ylim(0, 1.02)
        ax.grid(True, linestyle=":", alpha=0.5)
    fig.suptitle(
        title_v1(
            "实际 0.8 s 滚动窗口误差分布 / CDF "
            f"（n={metrics['windowDistance']['count']:,}）"
        ),
        fontweight="bold",
    )
    return fig


def physical_error_matrix(
    window_records: list[dict[str, Any]], field: str
) -> tuple[list[int], list[float], np.ndarray]:
    centers = sorted({int(row["truthCenterMm"]) for row in window_records})
    angles = sorted({float(row["truthAngleDeg"]) for row in window_records})
    matrix = np.full((len(angles), len(centers)), np.nan)
    for row_index, angle in enumerate(angles):
        for column_index, center in enumerate(centers):
            values = [
                float(row[field])
                for row in window_records
                if int(row["truthCenterMm"]) == center
                and float(row["truthAngleDeg"]) == angle
            ]
            if values:
                matrix[row_index, column_index] = float(np.mean(values))
    return centers, angles, matrix


def draw_annotated_heatmap(
    fig: plt.Figure, ax: plt.Axes, matrix: np.ndarray, centers: list[int],
    angles: list[float], title: str, unit: str, cmap: str
) -> None:
    image = ax.imshow(matrix, aspect="auto", cmap=cmap)
    ax.set_xticks(range(len(centers)), [str(value - 300) for value in centers])
    ax.set_yticks(range(len(angles)), [f"{value:g}" for value in angles])
    ax.set_xlabel("边界距离 / mm")
    ax.set_ylabel("真值角度 / °")
    ax.set_title(title)
    finite = matrix[np.isfinite(matrix)]
    threshold = float(np.mean(finite)) if len(finite) else 0
    for row in range(matrix.shape[0]):
        for col in range(matrix.shape[1]):
            if not np.isnan(matrix[row, col]):
                color = "white" if matrix[row, col] > threshold else "#222"
                ax.text(col, row, f"{matrix[row, col]:.0f}", ha="center", va="center",
                        color=color, fontsize=8)
    colorbar = fig.colorbar(image, ax=ax, shrink=0.88)
    colorbar.set_label(unit)


def figure_error_heatmaps(window_records: list[dict[str, Any]]) -> plt.Figure:
    fig, axes = plt.subplots(1, 2, figsize=(15, 6.1), constrained_layout=True)
    centers, angles, distance = physical_error_matrix(window_records, "distanceErrorMm")
    _, _, angle = physical_error_matrix(window_records, "angleErrorDeg")
    draw_annotated_heatmap(
        fig, axes[0], distance, centers, angles, "每物理点滚动距离 MAE", "距离 MAE / mm", "YlOrRd"
    )
    draw_annotated_heatmap(
        fig, axes[1], angle, centers, angles, "每物理点滚动角度 MAE", "角度 MAE / °", "PuBuGn"
    )
    fig.suptitle(title_v1("距离–角度误差热力图（实际回放）"), fontweight="bold")
    return fig


def short_variant_label(variant_id: str) -> str:
    return (
        variant_id.replace("knn-", "")
        .replace("-station+ridge-angle", " / station")
        .replace("-global+ridge-angle", " / global")
    )


def figure_algorithm_comparison(benchmark: dict[str, Any]) -> plt.Figure:
    variants = list(benchmark["variants"][:12])
    labels = [short_variant_label(str(row["id"])) for row in variants][::-1]
    p95 = [float(row["windowDistance"]["p95"]) for row in variants][::-1]
    mae = [float(row["windowDistance"]["mae"]) for row in variants][::-1]
    colors = ["#2a6fbb" if row["id"] == benchmark["winner"]["id"] else "#9db9d6"
              for row in variants][::-1]
    fig, axes = plt.subplots(1, 2, figsize=(15, 7.4), constrained_layout=True)
    positions = np.arange(len(labels))
    axes[0].barh(positions, p95, color=colors)
    axes[0].set_yticks(positions, labels, fontsize=8.5)
    axes[0].set_xlabel("距离误差 P95 / mm（越低越好）")
    axes[0].set_title("前 12 个部署候选：P95")
    axes[0].grid(axis="x", linestyle=":", alpha=0.5)
    axes[1].barh(positions, mae, color=colors)
    axes[1].set_yticks(positions, labels, fontsize=8.5)
    axes[1].set_xlabel("距离误差 MAE / mm（越低越好）")
    axes[1].set_title("前 12 个部署候选：MAE")
    axes[1].grid(axis="x", linestyle=":", alpha=0.5)
    fig.text(
        0.5, 0.005,
        "深蓝：当前冻结部署候选 3-NN / inverse-sqrt-q / station scales + ridge angle",
        ha="center", fontsize=10,
    )
    fig.suptitle(
        title_v1("算法对比：实际回放的滚动窗口距离指标"),
        fontweight="bold",
    )
    return fig


def figure_quality_coverage(
    window_records: list[dict[str, Any]], metrics: dict[str, Any]
) -> plt.Figure:
    fig, axes = plt.subplots(1, 2, figsize=(14.6, 6.5), constrained_layout=True)
    categories = ["全部窗口", "中等质量", "高质量"]
    subsets = [
        window_records,
        [row for row in window_records if row["mediumQuality"]],
        [row for row in window_records if row["highQuality"]],
    ]
    coverage = [1.0, metrics["mediumCoverage"], metrics["highCoverage"]]
    mae = [np.mean([row["distanceErrorMm"] for row in rows]) for rows in subsets]
    p95 = [np.percentile([row["distanceErrorMm"] for row in rows], 95) for rows in subsets]
    axes[0].bar(categories, np.array(coverage) * 100, color=["#c7dff2", "#7aaed6", "#2a6fbb"])
    for index, value in enumerate(coverage):
        axes[0].text(index, value * 100 + 1.2, f"{value * 100:.1f}%", ha="center")
    axes[0].set_ylim(0, 112)
    axes[0].set_ylabel("窗口覆盖率 / %")
    axes[0].set_title("质量门覆盖率")
    axes[0].grid(axis="y", linestyle=":", alpha=0.5)

    positions = np.arange(len(categories))
    width = 0.36
    axes[1].bar(positions - width / 2, mae, width, label="MAE", color="#2a6fbb")
    axes[1].bar(positions + width / 2, p95, width, label="P95", color="#f4a261")
    axes[1].set_xticks(positions, categories)
    axes[1].set_ylabel("距离绝对误差 / mm")
    axes[1].set_title("质量门内的距离误差")
    axes[1].grid(axis="y", linestyle=":", alpha=0.5)
    axes[1].legend()
    fig.text(
        0.5, 0.006,
        "高质量：q≤0.40、邻居跨度≤400 mm、MADmax≤100 mm、最少样本数≥5；"
        "中等质量：q≤0.80、跨度≤800 mm、MADmax≤150 mm、最少样本数≥4。",
        ha="center", fontsize=9.5,
    )
    fig.suptitle(title_v1("质量门：覆盖率与误差"), fontweight="bold")
    return fig


def confusion_counts(records: list[dict[str, Any]], threshold_mm: int) -> tuple[np.ndarray, dict[str, int]]:
    truth_inside = np.array([row["truthBoundaryMm"] <= threshold_mm for row in records])
    pred_inside = np.array([row["predBoundaryMm"] <= threshold_mm for row in records])
    counts = {
        "TN": int(np.sum(~truth_inside & ~pred_inside)),
        "FP": int(np.sum(~truth_inside & pred_inside)),
        "FN": int(np.sum(truth_inside & ~pred_inside)),
        "TP": int(np.sum(truth_inside & pred_inside)),
    }
    matrix = np.array([[counts["TP"], counts["FN"]], [counts["FP"], counts["TN"]]])
    return matrix, counts


def figure_boundary_validation(window_records: list[dict[str, Any]]) -> plt.Figure:
    fig, axes = plt.subplots(2, 2, figsize=(14.8, 10.8), constrained_layout=True)
    true_values = np.array([row["truthBoundaryMm"] for row in window_records])
    pred_values = np.array([row["predBoundaryMm"] for row in window_records])
    for row, threshold in enumerate((1000, 2000)):
        ax = axes[row, 0]
        shade_official_distance_axes(
            ax,
            minimum_boundary_mm=650,
            maximum_boundary_mm=2450,
        )
        status = np.array([
            0 if truth <= threshold and pred <= threshold
            else 1 if truth > threshold and pred <= threshold
            else 2 if truth <= threshold and pred > threshold
            else 3
            for truth, pred in zip(true_values, pred_values)
        ])
        names = ["命中（阈值内）", "误报（预测内）", "漏报（预测外）", "命中（阈值外）"]
        colors = ["#2a9d8f", "#e76f51", "#f4a261", "#457b9d"]
        for value, name, color in zip(range(4), names, colors):
            mask = status == value
            ax.scatter(
                true_values[mask],
                pred_values[mask],
                s=4,
                alpha=0.31,
                c=color,
                label=name,
                rasterized=True,
                zorder=4,
            )
        limits = [650, 2450]
        ax.plot(limits, limits, "--", color="#333", lw=1.1)
        ax.axvline(threshold, color="#111", ls=":", lw=1.3)
        ax.axhline(threshold, color="#111", ls=":", lw=1.3)
        ax.set_xlim(limits)
        ax.set_ylim(limits)
        ax.set_aspect("equal", adjustable="box")
        ax.set_xlabel("真值边界距离 / mm")
        ax.set_ylabel("预测边界距离 / mm")
        ax.set_title(f"{threshold / 1000:g} m 边界：窗口级判定")
        ax.grid(True, linestyle=":", alpha=0.35)
        ax.legend(loc="upper left", fontsize=7.5, framealpha=0.93)

        matrix, counts = confusion_counts(window_records, threshold)
        im = axes[row, 1].imshow(matrix, cmap=ListedColormap(["#edf6f9", "#bde0d8", "#65b5ab", "#2a9d8f"]))
        axes[row, 1].set_xticks([0, 1], ["预测：阈值内", "预测：阈值外"])
        axes[row, 1].set_yticks([0, 1], ["真值：阈值内", "真值：阈值外"])
        for y in range(2):
            for x in range(2):
                axes[row, 1].text(x, y, f"{int(matrix[y, x]):,}", ha="center", va="center",
                                  fontsize=18, fontweight="bold")
        accuracy = (counts["TP"] + counts["TN"]) / len(window_records)
        outside_count = counts["FP"] + counts["TN"]
        support_note = (
            "；阈值外真值样本=0，仅能评估阈值内漏报"
            if outside_count == 0
            else ""
        )
        axes[row, 1].set_title(
            f"{threshold / 1000:g} m 边界混淆矩阵\n"
            f"正确率 {accuracy * 100:.2f}%；FP={counts['FP']:,}，FN={counts['FN']:,}"
            f"{support_note}"
        )
        fig.colorbar(im, ax=axes[row, 1], shrink=0.82, label="窗口数（颜色仅作相对提示）")
    fig.suptitle(
        title_v1(
            "边界专项验证：1 m 解锁、2 m 欢迎（预测边界距离 = 预测中心距离 − 300 mm）"
        ),
        fontweight="bold",
    )
    return fig


def select_replay_capture(manifest: dict[str, Any]) -> dict[str, Any]:
    candidates = [
        row for row in manifest["captures"]
        if int(row["centerDistanceMm"]) == 1100 and float(row["angleDeg"]) == 0.0
    ]
    if not candidates:
        raise RuntimeError("找不到用于静态校准点回放的 0.8 m / 0° 采集")
    return sorted(candidates, key=lambda row: str(row["captureId"]))[0]


def render_replay_axes(
    ax: plt.Axes, capture: dict[str, Any], records: list[dict[str, Any]], index: int
) -> None:
    truth_x, truth_y = point_xy(float(capture["centerDistanceMm"]), float(capture["angleDeg"]))
    frame = records[index]
    pred_x, pred_y = point_xy(frame["predCenterMm"], frame["predAngleDeg"])
    previous = records[max(0, index - 35): index + 1]
    trail = np.array([point_xy(row["predCenterMm"], row["predAngleDeg"]) for row in previous])
    draw_official_map_background(ax, max_radius_mm=2700, label_zones=False)
    for name, x, y in REPORT_STATIONS:
        ax.scatter(x, y, marker="s", s=34, c="#c94d5d", zorder=7)
    ax.scatter([truth_x], [truth_y], marker="*", s=210, c="#2a9d8f",
               edgecolors="#173f3a", label="静态物理真值点")
    ax.plot(trail[:, 0], trail[:, 1], color="#e58f3d", alpha=0.72, lw=1.7,
            label="最近 35 帧估计轨迹")
    ax.scatter([pred_x], [pred_y], marker="o", s=70, c="#e76f51", edgecolors="#5a1f18",
               label="当前 v1 估计")
    ax.plot([truth_x, pred_x], [truth_y, pred_y], color="#555", ls=":", lw=1.0)
    ax.set_aspect("equal")
    ax.set_xlim(-2350, 2350)
    ax.set_ylim(-450, 2800)
    ax.set_xlabel("右方 x / mm")
    ax.set_ylabel("前方 y / mm")
    ax.grid(False)
    ax.legend(loc="lower right", fontsize=8, framealpha=0.95)
    ax.set_title(
        "校准点回放（非动态轨迹）\n"
        f"{capture['label']}，t={frame['nowMs'] / 1000:.1f} s，"
        f"距离误差 {frame['distanceErrorMm']:.1f} mm"
    )


def figure_replay_static(
    capture: dict[str, Any], records: list[dict[str, Any]]
) -> plt.Figure:
    fig, ax = plt.subplots(figsize=(11.5, 7.2), constrained_layout=True)
    render_replay_axes(ax, capture, records, len(records) - 1)
    fig.suptitle(title_v1("实际静态校准点回放（不代表动态轨迹）"), fontweight="bold")
    return fig


def save_replay_gif(
    output_dir: Path, capture: dict[str, Any], records: list[dict[str, Any]]
) -> str:
    frame_indices = np.linspace(0, len(records) - 1, num=min(80, len(records)), dtype=int)
    fig, ax = plt.subplots(figsize=(9.6, 6.0))

    def update(frame_index: int) -> list[Any]:
        ax.clear()
        render_replay_axes(ax, capture, records, int(frame_index))
        ax.text(
            0.5, 1.01, "实际静态校准点回放；并非移动轨迹",
            transform=ax.transAxes, ha="center", color="#9b2226", fontweight="bold",
        )
        return []

    movie = animation.FuncAnimation(fig, update, frames=frame_indices, interval=100, blit=False)
    path = output_dir / "09_static_calibration_point_replay.gif"
    movie.save(path, writer=animation.PillowWriter(fps=10))
    plt.close(fig)
    return path.name


def figure_dual_output_pipeline(firmware: dict[str, Any]) -> plt.Figure:
    """Show the source-backed dual-output status without claiming new metrics."""

    fig, ax = plt.subplots(figsize=(14.5, 6.9), constrained_layout=True)
    ax.set_axis_off()
    ax.set_xlim(0, 14)
    ax.set_ylim(0, 7)
    is_current_source_wording = bool(firmware["dualOutputPresentInCurrentProject"])
    status = (
        "当前工程已包含双输出表述；本报告未提供该路径的独立回放指标"
        if is_current_source_wording
        else DUAL_OUTPUT_UNCONFIRMED
    )
    heading = (
        "当前四站固件的双输出距离路径"
        if is_current_source_wording
        else "下一版距离模型设计：回归 + 边界专项校正"
    )

    boxes = [
        (0.4, 2.5, 2.2, 1.5, "四站原始测距\n0.8 s 稳健特征", "#dceefb"),
        (3.4, 2.5, 2.2, 1.5, "共享特征 / 质量门\nq、MAD、样本数", "#e6f4ea"),
        (6.5, 4.15, 2.3, 1.45, "回归主输出\n连续中心/边界距离", "#fff0cf"),
        (6.5, 1.35, 2.3, 1.45, "边界专项校正\n1 m 解锁 + 2 m 欢迎", "#ffe2df"),
        (10.0, 2.75, 2.75, 1.7, "双输出融合与迟滞\n状态：解锁 / 欢迎 / 其它", "#eadcf8"),
    ]
    for x, y, width, height, text, color in boxes:
        ax.add_patch(FancyBboxPatch(
            (x, y), width, height, boxstyle="round,pad=0.06,rounding_size=0.1",
            fc=color, ec="#3d5a80", lw=1.5
        ))
        ax.text(x + width / 2, y + height / 2, text, ha="center", va="center",
                fontsize=12, fontweight="bold")
    arrows = [
        ((2.6, 3.25), (3.4, 3.25)),
        ((5.6, 3.25), (6.5, 4.87)),
        ((5.6, 3.25), (6.5, 2.08)),
        ((8.8, 4.87), (10.0, 3.6)),
        ((8.8, 2.08), (10.0, 3.6)),
    ]
    for start, end in arrows:
        ax.add_patch(FancyArrowPatch(start, end, arrowstyle="-|>", mutation_scale=16,
                                     lw=1.55, color="#3d5a80"))
    ax.text(
        7.0, 6.45,
        heading,
        ha="center", va="center", fontsize=17, fontweight="bold",
    )
    ax.text(
        7.0, 5.93,
        status,
        ha="center", va="center", fontsize=14, color="#9b2226", fontweight="bold",
        bbox={"boxstyle": "round,pad=0.32", "fc": "#fff3f2", "ec": "#e76f51"},
    )
    if is_current_source_wording:
        source_note = "源码证据：" + "；".join(firmware["dualOutputEvidence"])
    else:
        source_note = (
            "当前四站模型头文件与估计器源码未发现“dual-output/双输出”表述；"
            "因此该结构不是当前模型结论。"
        )
    ax.text(
        7.0, 0.35,
        f"{source_note}\n固件工程：{firmware['projectName']}；"
        "补录 1 m / 2 m 边界两侧真实静态点后重跑本脚本；本图不新增性能指标。",
        ha="center", va="center", fontsize=11,
    )
    return fig


def build_summary(
    manifest: dict[str, Any],
    benchmark: dict[str, Any],
    metrics: dict[str, Any],
    point_records: list[dict[str, Any]],
    window_records: list[dict[str, Any]],
    firmware: dict[str, Any],
    font_name: str,
    generated_files: list[str],
) -> dict[str, Any]:
    boundary_summary: dict[str, Any] = {}
    for threshold in (1000, 2000):
        matrix, counts = confusion_counts(window_records, threshold)
        outside_count = counts["FP"] + counts["TN"]
        boundary_summary[f"{threshold}mm"] = {
            "thresholdBoundaryDistanceMm": threshold,
            "thresholdCenterDistanceMm": threshold + BOUNDARY_OFFSET_MM,
            "confusionRowsTruthColsPrediction": matrix.tolist(),
            "counts": counts,
            "accuracy": (counts["TP"] + counts["TN"]) / len(window_records),
            "truthOutsideSampleCount": outside_count,
            "fullyBracketedByTruthData": outside_count > 0 and (counts["TP"] + counts["FN"]) > 0,
            "validationScopeNote": (
                "阈值内外均有真值样本。"
                if outside_count > 0
                else "阈值外没有真值样本；仅可评估阈值内漏报，不能视为完整边界判定验证。"
            ),
        }
    return {
        "reportVersion": "four_station_20260801_frozen_v1",
        "currentModelLabel": f"{CURRENT_V1}；{REPORT_FIRMWARE_CAPTION}",
        "firmwareModelSource": firmware,
        "inputs": {
            "manifest": str(DEFAULT_MANIFEST.relative_to(PROJECT_ROOT)),
            "benchmark": str(DEFAULT_BENCHMARK.relative_to(PROJECT_ROOT)),
            "capturesDirectory": str(DEFAULT_CAPTURES),
            "modelId": manifest["modelId"],
            "captureCount": len(manifest["captures"]),
            "physicalPointCount": len(manifest["prototypes"]),
        },
        "geometry": manifest["geometry"],
        "reportGeometry": {
            "source": "任务指定的四站报告几何",
            "stations": [
                {"name": name, "xMm": x, "yMm": y}
                for name, x, y in REPORT_STATIONS
            ],
            "competitionCircleRadiusMm": 300,
            "boundaryDistanceToCenterOffsetMm": BOUNDARY_OFFSET_MM,
        },
        "calibrationManifestGeometry": manifest["geometry"],
        "deployedCandidate": {
            "id": metrics["model"],
            "description": "3-NN inverse-sqrt-q，station scales，ridge angle",
            "runtime": manifest["runtime"],
        },
        "validation": {
            "recomputedFromReplay": metrics,
            "benchmarkWinner": benchmark["winner"],
            "pointRecordCount": len(point_records),
            "rollingWindowRecordCount": len(window_records),
        },
        "boundaryValidation": boundary_summary,
        "plannedDualOutput": {
            "status": (
                "current-project-wording-present"
                if firmware["dualOutputPresentInCurrentProject"]
                else DUAL_OUTPUT_UNCONFIRMED
            ),
            "description": (
                "当前工程中检测到双输出距离表述；本报告没有为该表述生成独立回放指标。"
                if firmware["dualOutputPresentInCurrentProject"]
                else "回归主输出 + 1 m 解锁、2 m 迎宾的边界专项校正；"
                "未训练、未验证、未报告 v2 指标。"
            ),
            "rerunRequirement": "补录真实 1 m/2 m 边界附近数据后重跑本脚本。",
        },
        "rendering": {"font": font_name, "pngDpi": PNG_DPI},
        "officialMapStyle": {
            "source": str(OFFICIAL_MAP_SOURCE.relative_to(PROJECT_ROOT)),
            "page": 3,
            "implementation": (
                "根据官方图 2 的分区、±45°边界、门锁圆体和正前方方向重绘矢量图层；"
                "未嵌入或放大低分辨率截图。"
            ),
            "palette": OFFICIAL_COLORS,
        },
        "generatedFiles": sorted(generated_files),
    }


def write_readme(output_dir: Path, summary: dict[str, Any]) -> str:
    metrics = summary["validation"]["recomputedFromReplay"]
    firmware = summary["firmwareModelSource"]
    dual_output_text = (
        "当前工程的源码中存在双输出距离表述；本报告没有为该路径生成独立回放指标。"
        if firmware["dualOutputPresentInCurrentProject"]
        else (
            "当前四站模型头文件和估计器源码中未发现双输出距离表述；"
            "因此双输出图是 **planned / not yet validated**，不属于当前冻结 v1。"
        )
    )
    readme = f"""# 四站 190 mm UWB 报告图（2026-08-01）

所有实测验证图均为**当前冻结 v1**。当前固件/模型标签的唯一事实源是
`{firmware["projectDirectory"]}`：四站模型符号
`{firmware["fourStationModelSymbol"]}`，估计器源码
`{firmware["fourStationEstimatorSource"]}`。不使用
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
- `10_dual_output_distance_pipeline.*`：回归 + 1 m 解锁/2 m 迎宾边界专项校正的双输出距离路径。{dual_output_text}

冻结 v1 的实际回放指标（窗口数 {metrics["windowDistance"]["count"]:,}）：

- 距离：MAE {metrics["windowDistance"]["mae"]:.3f} mm，P95 {metrics["windowDistance"]["p95"]:.3f} mm。
- 角度：MAE {metrics["windowAngle"]["mae"]:.3f}°，P95 {metrics["windowAngle"]["p95"]:.3f}°。
- 高质量门覆盖率：{metrics["highCoverage"] * 100:.2f}%；中等质量门覆盖率：{metrics["mediumCoverage"] * 100:.2f}%。

## 复现

从仓库根目录运行：

```bash
python3 code/c_digital_key_lock/tools/generate_four_station_report_figures.py
```

若补录真实 1 m / 2 m 边界附近的静态数据，先更新冻结模型清单和 benchmark，再重跑此脚本。脚本会把重新计算的 replay 指标与 benchmark JSON 断言比对；不一致时会失败而不是写出不可信的图。
"""
    path = output_dir / "README.md"
    path.write_text(readme, encoding="utf-8")
    return path.name


def validate_outputs(output_dir: Path, generated_files: Iterable[str]) -> None:
    """Open raster assets and minimally parse vector assets before reporting success."""

    for name in generated_files:
        path = output_dir / name
        if not path.is_file() or path.stat().st_size == 0:
            raise RuntimeError(f"输出缺失或为空：{path}")
        if path.suffix.lower() in {".png", ".gif"}:
            with Image.open(path) as image:
                image.verify()
        elif path.suffix.lower() == ".svg":
            ElementTree.parse(path)
        elif path.suffix.lower() == ".pdf":
            if not path.read_bytes().startswith(b"%PDF-"):
                raise RuntimeError(f"PDF 文件头无效：{path}")


def remove_legacy_dual_output_assets(output_dir: Path) -> None:
    """Prevent a stale planned-only filename from surviving a regenerated report."""

    for extension in ("png", "svg", "pdf"):
        (output_dir / f"10_planned_dual_output_pipeline.{extension}").unlink(
            missing_ok=True
        )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="生成 2026-08-01 四站 UWB 冻结 v1 报告图（只写入指定图目录）"
    )
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--benchmark", type=Path, default=DEFAULT_BENCHMARK)
    parser.add_argument("--captures", type=Path, default=DEFAULT_CAPTURES)
    parser.add_argument("--firmware-project", type=Path, default=FIRMWARE_PROJECT_DIR)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    output_dir = args.output_dir.resolve()
    if output_dir != DEFAULT_OUTPUT.resolve():
        raise ValueError(f"输出目录必须为指定路径：{DEFAULT_OUTPUT}")
    if not args.manifest.is_file() or not args.benchmark.is_file() or not args.captures.is_dir():
        raise FileNotFoundError("manifest、benchmark 或 captures 目录不存在")

    output_dir.mkdir(parents=True, exist_ok=True)
    remove_legacy_dual_output_assets(output_dir)
    font_name = configure_chinese_font()
    manifest = load_json(args.manifest)
    benchmark = load_json(args.benchmark)
    firmware = load_firmware_labels(args.firmware_project)
    set_report_firmware_caption(firmware)
    point_records, window_records, replay_cache = build_replay_records(manifest, args.captures)
    metrics = build_current_metrics(point_records, window_records)
    assert_metrics_match_benchmark(metrics, benchmark)

    generated: list[str] = []
    generated += save_static_figure(figure_geometry(manifest), output_dir, "01_geometry")
    generated += save_static_figure(
        figure_sample_coverage(manifest), output_dir, "02_sample_coverage"
    )
    generated += save_static_figure(
        figure_point_holdout(point_records),
        output_dir,
        "03_point_holdout_truth_vs_prediction",
    )
    generated += save_static_figure(
        figure_rolling_errors(window_records, metrics),
        output_dir,
        "04_rolling_window_error_distribution_cdf",
    )
    generated += save_static_figure(
        figure_error_heatmaps(window_records),
        output_dir,
        "05_distance_angle_error_heatmaps",
    )
    generated += save_static_figure(
        figure_algorithm_comparison(benchmark), output_dir, "06_algorithm_comparison"
    )
    generated += save_static_figure(
        figure_quality_coverage(window_records, metrics),
        output_dir,
        "07_quality_gate_coverage",
    )
    generated += save_static_figure(
        figure_boundary_validation(window_records),
        output_dir,
        "08_boundary_validation_1m_2m",
    )
    replay_capture = select_replay_capture(manifest)
    replay_records = replay_cache[str(replay_capture["captureId"])]
    # Reconstruct this capture's holdout predictions from the already computed records.
    replay_prediction_records = [
        row for row in window_records if row["captureId"] == replay_capture["captureId"]
    ]
    if len(replay_prediction_records) != len(replay_records):
        raise RuntimeError("静态回放窗口数与预测记录数不一致")
    generated += save_static_figure(
        figure_replay_static(replay_capture, replay_prediction_records),
        output_dir,
        "09_static_calibration_point_replay",
    )
    generated.append(save_replay_gif(output_dir, replay_capture, replay_prediction_records))
    generated += save_static_figure(
        figure_dual_output_pipeline(firmware), output_dir, "10_dual_output_distance_pipeline"
    )

    summary = build_summary(
        manifest,
        benchmark,
        metrics,
        point_records,
        window_records,
        firmware,
        font_name,
        generated,
    )
    summary_path = output_dir / "metrics_summary.json"
    summary_path.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    generated.append(summary_path.name)
    generated.append(write_readme(output_dir, summary))
    validate_outputs(output_dir, generated)

    print(
        json.dumps(
            {
                "outputDir": str(output_dir),
                "physicalPointCount": len(point_records),
                "rollingWindowCount": len(window_records),
                "validation": metrics,
                "files": sorted(generated),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"生成失败：{error}", file=sys.stderr)
        raise
