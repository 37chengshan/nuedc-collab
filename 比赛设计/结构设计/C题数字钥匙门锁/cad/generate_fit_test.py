#!/usr/bin/env python3
"""Generate a compact PETG quick-release clearance calibration STL.

The output contains four disconnected, printable gauge pairs in one STL.  Each
pair has a retained C-channel and a matching tongue.  The labelled clearance is
the lateral clearance on *each* side of the tongue and the vertical clearance
above it.  No adhesive or support material is required.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Sequence

import numpy as np

from meshlib import (
    Mesh,
    box,
    cylinder,
    edge_count_validation,
    export_binary_stl,
    load_binary_stl,
    merge,
)


CLEARANCES_MM = (0.25, 0.35, 0.45, 0.55)
GAUGE_X_MM = (-45.0, -15.0, 15.0, 45.0)
TONGUE_WIDTH_MM = 8.0
TONGUE_THICKNESS_MM = 4.0
TONGUE_LENGTH_MM = 32.0
CHANNEL_LENGTH_MM = 30.0
CHANNEL_FLOOR_MM = 2.0
CHANNEL_WALL_MM = 2.0
CHANNEL_LIP_MM = 1.6
CHANNEL_LIP_OVERHANG_MM = 1.2
CHANNEL_CENTER_Y_MM = 19.5
TONGUE_CENTER_Y_MM = -20.0
MAXIMUM_DIMENSIONS_MM = np.asarray((120.0, 80.0, 12.0), dtype=np.float64)
MINIMUM_OBJECT_GAP_MM = 2.0


def signed_polygon_area(points: np.ndarray) -> float:
    x_values = points[:, 0]
    y_values = points[:, 1]
    return float(
        0.5
        * np.sum(
            x_values * np.roll(y_values, -1)
            - np.roll(x_values, -1) * y_values
        )
    )


def cross_2d(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> float:
    first = b - a
    second = c - a
    return float(first[0] * second[1] - first[1] * second[0])


def point_in_triangle(
    point: np.ndarray,
    a: np.ndarray,
    b: np.ndarray,
    c: np.ndarray,
    epsilon: float = 1e-10,
) -> bool:
    first = cross_2d(a, b, point)
    second = cross_2d(b, c, point)
    third = cross_2d(c, a, point)
    return first >= -epsilon and second >= -epsilon and third >= -epsilon


def triangulate_simple_polygon(profile: Sequence[Sequence[float]]) -> tuple[np.ndarray, list[tuple[int, int, int]]]:
    """Triangulate a counter-clockwise simple polygon using ear clipping."""

    points = np.asarray(profile, dtype=np.float64)
    if points.ndim != 2 or points.shape[1] != 2 or len(points) < 3:
        raise ValueError("profile must contain at least three 2D points")
    if signed_polygon_area(points) < 0.0:
        points = points[::-1].copy()

    remaining = list(range(len(points)))
    triangles: list[tuple[int, int, int]] = []
    while len(remaining) > 3:
        ear_found = False
        for position, current in enumerate(remaining):
            previous = remaining[position - 1]
            following = remaining[(position + 1) % len(remaining)]
            if cross_2d(points[previous], points[current], points[following]) <= 1e-10:
                continue
            if any(
                point_in_triangle(
                    points[candidate],
                    points[previous],
                    points[current],
                    points[following],
                )
                for candidate in remaining
                if candidate not in (previous, current, following)
            ):
                continue
            triangles.append((previous, current, following))
            del remaining[position]
            ear_found = True
            break
        if not ear_found:
            raise ValueError("profile is self-intersecting or cannot be triangulated")
    triangles.append(tuple(remaining))
    return points, triangles


def extrude_xz_profile(
    name: str,
    profile: Sequence[Sequence[float]],
    length: float,
    center_y: float,
) -> Mesh:
    """Extrude one simple X/Z profile along Y as a closed manifold mesh."""

    if length <= 0.0:
        raise ValueError(f"{name}: extrusion length must be positive")
    points, cap_triangles = triangulate_simple_polygon(profile)
    y0, y1 = center_y - length / 2.0, center_y + length / 2.0
    back = np.column_stack((points[:, 0], np.full(len(points), y0), points[:, 1]))
    front = np.column_stack((points[:, 0], np.full(len(points), y1), points[:, 1]))
    vertices = np.vstack((back, front))
    count = len(points)
    faces: list[list[int]] = []
    for first, second, third in cap_triangles:
        faces.append([first, second, third])
        faces.append([count + first, count + third, count + second])
    for index in range(count):
        following = (index + 1) % count
        faces.append([index, count + following, following])
        faces.append([index, count + index, count + following])
    return Mesh(name, vertices, np.asarray(faces, dtype=np.int64))


def build_channel(clearance_mm: float, center_x: float) -> Mesh:
    inner_width = TONGUE_WIDTH_MM + 2.0 * clearance_mm
    outer_width = inner_width + 2.0 * CHANNEL_WALL_MM
    opening_width = inner_width - 2.0 * CHANNEL_LIP_OVERHANG_MM
    lip_bottom_z = CHANNEL_FLOOR_MM + TONGUE_THICKNESS_MM + clearance_mm
    total_height = lip_bottom_z + CHANNEL_LIP_MM
    half_outer = outer_width / 2.0
    half_inner = inner_width / 2.0
    half_opening = opening_width / 2.0
    profile = [
        (-half_outer, 0.0),
        (half_outer, 0.0),
        (half_outer, total_height),
        (half_opening, total_height),
        (half_opening, lip_bottom_z),
        (half_inner, lip_bottom_z),
        (half_inner, CHANNEL_FLOOR_MM),
        (-half_inner, CHANNEL_FLOOR_MM),
        (-half_inner, lip_bottom_z),
        (-half_opening, lip_bottom_z),
        (-half_opening, total_height),
        (-half_outer, total_height),
    ]
    code = round(clearance_mm * 100.0)
    return extrude_xz_profile(
        f"female_C_channel_{code:02d}",
        profile,
        CHANNEL_LENGTH_MM,
        CHANNEL_CENTER_Y_MM,
    ).translated((center_x, 0.0, 0.0))


def marker_offsets(marker_count: int) -> list[float]:
    if marker_count == 1:
        return [0.0]
    spacing = 1.6
    start = -(marker_count - 1) * spacing / 2.0
    return [start + index * spacing for index in range(marker_count)]


def build_tongue(clearance_mm: float, center_x: float, marker_count: int) -> Mesh:
    code = round(clearance_mm * 100.0)
    pieces = [
        box(
            f"male_tongue_{code:02d}_body",
            (TONGUE_WIDTH_MM, TONGUE_LENGTH_MM, TONGUE_THICKNESS_MM),
            (center_x, TONGUE_CENTER_Y_MM, TONGUE_THICKNESS_MM / 2.0),
        )
    ]
    marker_y = TONGUE_CENTER_Y_MM - TONGUE_LENGTH_MM / 2.0 + 3.0
    for marker_index, offset_x in enumerate(marker_offsets(marker_count), start=1):
        pieces.append(
            cylinder(
                f"male_tongue_{code:02d}_marker_{marker_index}",
                0.55,
                0.8,
                20,
                (center_x + offset_x, marker_y, TONGUE_THICKNESS_MM + 0.2),
            )
        )
    return merge(f"male_tongue_{code:02d}", pieces)


def planar_gap(first: Mesh, second: Mesh) -> float:
    dx = max(
        float(first.minimum[0] - second.maximum[0]),
        float(second.minimum[0] - first.maximum[0]),
        0.0,
    )
    dy = max(
        float(first.minimum[1] - second.maximum[1]),
        float(second.minimum[1] - first.maximum[1]),
        0.0,
    )
    return math.hypot(dx, dy)


def minimum_planar_gap(objects: Sequence[Mesh]) -> float:
    return min(
        planar_gap(first, second)
        for index, first in enumerate(objects)
        for second in objects[index + 1 :]
    )


def ensure_valid(validation: dict[str, object], label: str) -> None:
    if validation["degenerate_triangles"] != 0:
        raise ValueError(f"{label}: degenerate triangles detected")
    if validation["open_boundary_edges"] != 0:
        raise ValueError(f"{label}: open boundary edges detected")


def build_gauges() -> tuple[Mesh, list[Mesh], list[dict[str, float | int]]]:
    objects: list[Mesh] = []
    gauges: list[dict[str, float | int]] = []
    for marker_count, (clearance_mm, center_x) in enumerate(
        zip(CLEARANCES_MM, GAUGE_X_MM, strict=True),
        start=1,
    ):
        channel = build_channel(clearance_mm, center_x)
        tongue = build_tongue(clearance_mm, center_x, marker_count)
        for part in (channel, tongue):
            ensure_valid(edge_count_validation(part), part.name)
            objects.append(part)
        gauges.append(
            {
                "marker_dots": marker_count,
                "clearance_mm_per_side": clearance_mm,
                "channel_inner_width_mm": round(TONGUE_WIDTH_MM + 2.0 * clearance_mm, 3),
                "channel_cavity_height_mm": round(TONGUE_THICKNESS_MM + clearance_mm, 3),
            }
        )

    gap = minimum_planar_gap(objects)
    if gap < MINIMUM_OBJECT_GAP_MM:
        raise ValueError(f"printable objects are only {gap:.3f} mm apart")
    combined = merge("C_problem_PETG_quick_release_fit_test", objects).centered_for_print(
        "C_problem_PETG_quick_release_fit_test"
    )
    if np.any(combined.dimensions > MAXIMUM_DIMENSIONS_MM + 1e-6):
        raise ValueError(f"fit test exceeds design envelope: {combined.dimensions.tolist()}")
    return combined, objects, gauges


def readme_text(stl_name: str, dimensions: Sequence[float]) -> str:
    dimensions_text = " × ".join(f"{value:.2f}" for value in dimensions)
    return f"""# C题 PETG 快拆公差测试件

打印文件：`{stl_name}`  
整体包络：{dimensions_text} mm；一个 STL 内含 4 个独立母槽和 4 个独立公榫，不需要粘贴。

## 档位识别

公榫标记端的凸点数量对应母槽从左到右的档位：

- 1 点：0.25 mm
- 2 点：0.35 mm
- 3 点：0.45 mm
- 4 点：0.55 mm

档位数值是公榫左右**每侧间隙**，同时也是公榫顶面到母槽压唇下表面的垂直间隙。公榫尺寸为 8.00 × 32.00 × 4.00 mm。请从**无凸点端**插入对应母槽，让凸点端始终留在槽外，便于拔出。

## CR-3040D / PETG 建议

- 0.4 mm 喷嘴，1.75 mm PETG，0.20 mm 层高。
- 模型保持当前方向平放；不旋转、不缩放，不需要支撑。
- 首层喷嘴 240 ℃，其余 235 ℃；热床 80 ℃。
- 外墙 3 圈，顶/底各 4 层，15%～20% 填充；速度 40～60 mm/s。
- 建议象脚补偿 0.15～0.20 mm；若未做过首层校准，先确认首层不过度挤压。
- 打印结束后完全冷却再取件和试插，不要在热态强行配合。

## 判读与验收

从 0.55 mm 开始，逐档向 0.25 mm 试插。选择“数值最小且满足以下条件”的档位作为主模型 PETG 快拆间隙：

1. 徒手可推入 20 mm 以上，不开裂、不明显弯曲。
2. 倒置轻摇不会自行滑落，但手指捏住标记端可以直接拔出。
3. 连续插拔 10 次后仍无卡死、明显白化或碎屑。
4. 公榫被顶部压唇保留，不能直接向上抬出；拆卸沿槽长方向完成。

若所有档位都过紧，下一轮测试 0.65/0.75/0.85/0.95 mm；若所有档位都过松，下一轮测试 0.10/0.15/0.20/0.25 mm。若结果跨在相邻两档之间，围绕分界值按 0.05 mm 步进复测，例如 0.35 偏紧、0.45 偏松时测试 0.375/0.40/0.425 mm。
"""


def parse_args() -> argparse.Namespace:
    repository_root = Path(__file__).resolve().parents[4]
    default_output = repository_root / "生成内容" / "3D打印" / "C题" / "测试件"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=default_output)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    stl_path = output_dir / "C_problem_PETG_fit_test_025_035_045_055.stl"
    validation_path = output_dir / "validation.json"
    readme_path = output_dir / "README.md"

    combined, objects, gauges = build_gauges()
    source_validation = edge_count_validation(combined)
    ensure_valid(source_validation, "source mesh")
    export_binary_stl(combined, stl_path)
    reloaded = load_binary_stl(stl_path)
    reload_validation = edge_count_validation(reloaded)
    ensure_valid(reload_validation, "reloaded STL")

    minimum_gap = minimum_planar_gap(objects)
    report = {
        "status": "pass",
        "file": str(stl_path),
        "sha256": hashlib.sha256(stl_path.read_bytes()).hexdigest(),
        "printer": {
            "name": "CR-3040D",
            "build_volume_mm": [300.0, 300.0, 400.0],
            "nozzle_mm": 0.4,
            "material": "PETG 1.75 mm",
            "recommended_layer_height_mm": 0.2,
        },
        "gauges": gauges,
        "printable_object_count": len(objects),
        "minimum_planar_gap_between_objects_mm": round(minimum_gap, 3),
        "design_envelope_limit_mm": MAXIMUM_DIMENSIONS_MM.tolist(),
        "source_mesh": source_validation,
        "reloaded_stl": reload_validation,
        "checks": {
            "binary_stl_reload": True,
            "no_degenerate_triangles": reload_validation["degenerate_triangles"] == 0,
            "no_open_boundary_edges": reload_validation["open_boundary_edges"] == 0,
            "within_test_envelope": bool(np.all(reloaded.dimensions <= MAXIMUM_DIMENSIONS_MM + 1e-3)),
            "within_CR3040D_bed": bool(
                reloaded.dimensions[0] <= 300.0
                and reloaded.dimensions[1] <= 300.0
                and reloaded.dimensions[2] <= 400.0
            ),
            "objects_separated_for_print": minimum_gap >= MINIMUM_OBJECT_GAP_MM,
        },
    }
    if not all(report["checks"].values()):
        raise ValueError(f"validation failed: {report['checks']}")
    validation_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    readme_path.write_text(readme_text(stl_path.name, reloaded.dimensions), encoding="utf-8")

    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
