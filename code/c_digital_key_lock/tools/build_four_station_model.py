#!/usr/bin/env python3
"""Build and audit the independent 2026-08-01 four-station model.

The capture labels describe distance from the competition-circle boundary.
Runtime localization uses center distance, therefore the training target is
boundary distance + 300 mm.

This tool deliberately keeps the old two-station manifest/model untouched.
It emits a manifest, a C model table, and an audit report for the new
UWB1/UWB2/UWB3/UWB4 geometry.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import struct
import statistics
import tempfile
import zlib
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable


MODULE_DIR = Path(__file__).resolve().parents[1]
DEFAULT_CAPTURES = Path(
    "/private/tmp/nuedc-serial-pages.ksb2Ur/"
    "apps/uwb-recorder/data/captures"
)
DEFAULT_MANIFEST = MODULE_DIR / "calibration" / "four_station_20260801.json"
MODEL_HEADER = MODULE_DIR / "four_station_model_data.h"
MODEL_SOURCE = MODULE_DIR / "four_station_model_data.c"
AUDIT_REPORT = MODULE_DIR / "calibration" / "four_station_20260801_audit.json"

ADD_RADIUS_MM = 300
STATION_ADDRESSES = (0x0100, 0x0200, 0x0300, 0x0400)
STATION_COORDS = ((95, 0), (-95, 0), (0, 70), (0, -75))
STATION_NAMES = ("right", "left", "up", "down")
MODEL_MAGIC = 0x34535755
MODEL_VERSION = 0x0100
MODEL_HEADER_BYTES = 84
MODEL_SERIALIZED_BYTES = MODEL_HEADER_BYTES + 27 * 12


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def normalize_label(label: str) -> tuple[int, float]:
    text = label.strip().replace("。", ".").replace("度", "")
    match = re.search(
        r"(?P<distance>\d+(?:\.\d+)?)\s*m\s*"
        r"(?P<angle>[+-]?\d+(?:\.\d+)?)?",
        text,
    )
    if match is None:
        raise ValueError(f"无法解析采集标签：{label!r}")
    boundary_mm = round(float(match.group("distance")) * 1000)
    angle_deg = float(match.group("angle") or 0)
    return boundary_mm, angle_deg


def robust_feature(values: list[int]) -> int:
    """Return the runtime-compatible lowest-three mean."""

    if len(values) < 3:
        raise ValueError("每站至少需要 3 个有效距离样本")
    ordered = sorted(values)
    return round(sum(ordered[:3]) / 3.0)


def rolling_features(
    samples: list[dict[str, Any]],
    *,
    window_ms: int = 800,
    update_period_ms: int = 100,
    warmup_ms: int = 2000,
) -> list[int]:
    """Build the same 0.8 s feature stream used by the MCU."""

    first_ms = int(samples[0]["elapsedMs"]) + warmup_ms
    last_ms = int(samples[-1]["elapsedMs"])
    features: list[int] = []
    for now_ms in range(first_ms, last_ms + 1, update_period_ms):
        values = [
            int(row["distanceMm"])
            for row in samples
            if now_ms - window_ms <= int(row["elapsedMs"]) <= now_ms
        ]
        if len(values) >= 3:
            features.append(robust_feature(values))
    return features


def mad(values: list[int]) -> float:
    center = statistics.median(values)
    return statistics.median(abs(value - center) for value in values)


def parse_capture(
    meta_path: Path,
    captures_dir: Path,
    *,
    require_completed: bool = True,
) -> dict[str, Any]:
    metadata = load_json(meta_path)
    if require_completed and metadata.get("status") != "completed":
        raise ValueError(f"采集尚未完成：{meta_path.name}")
    jsonl_path = captures_dir / f"{metadata['id']}.jsonl"
    if not jsonl_path.is_file():
        raise FileNotFoundError(jsonl_path)

    by_address: dict[str, list[dict[str, Any]]] = defaultdict(list)
    rows: list[dict[str, Any]] = []
    malformed = 0
    for line in jsonl_path.read_text(encoding="utf-8").splitlines():
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            malformed += 1
            continue
        rows.append(row)
        if row.get("type") != "frame":
            continue
        address = str(row.get("address", "")).upper()
        if address not in {f"{address:04X}" for address in STATION_ADDRESSES}:
            continue
        try:
            distance_mm = int(row["distanceCm"]) * 10
            elapsed_ms = int(row["elapsedMs"])
        except (KeyError, TypeError, ValueError):
            malformed += 1
            continue
        if not 300 <= distance_mm <= 5000:
            continue
        by_address[address].append(
            {
                "elapsedMs": elapsed_ms,
                "distanceMm": distance_mm,
                "snrDb": (
                    None
                    if row.get("snrDb") is None
                    else int(row["snrDb"])
                ),
            }
        )

    addresses = [f"{address:04X}" for address in STATION_ADDRESSES]
    counts = {address: len(by_address[address]) for address in addresses}
    if any(counts[address] < 3 for address in addresses):
        raise ValueError(f"四站有效帧不足：{metadata['id']} {counts}")

    boundary_mm, angle_deg = normalize_label(str(metadata.get("label", "")))
    station_features: list[dict[str, Any]] = []
    for address in addresses:
        samples = by_address[address]
        distances = [int(row["distanceMm"]) for row in samples]
        window_features = rolling_features(samples)
        if not window_features:
            raise ValueError(
                f"无法形成 0.8 s 运行窗口：{metadata['id']} {address}"
            )
        snrs = [
            int(row["snrDb"])
            for row in samples
            if row["snrDb"] is not None
        ]
        station_features.append(
            {
                "address": address,
                "count": len(samples),
                "featureMm": round(statistics.median(window_features)),
                "windowFeatureP05Mm": round(
                    sorted(window_features)[
                        round((len(window_features) - 1) * 0.05)
                    ]
                ),
                "windowFeatureP95Mm": round(
                    sorted(window_features)[
                        round((len(window_features) - 1) * 0.95)
                    ]
                ),
                "medianMm": round(statistics.median(distances)),
                "madMm": round(mad(distances), 1),
                "snrDb": (
                    round(statistics.median(snrs), 1) if snrs else None
                ),
                "latestElapsedMs": max(
                    int(row["elapsedMs"]) for row in samples
                ),
            }
        )

    return {
        "captureId": str(metadata["id"]),
        "sessionId": metadata.get("sessionId"),
        "label": str(metadata.get("label", "")),
        "startedAt": metadata.get("startedAt"),
        "endedAt": metadata.get("endedAt"),
        "boundaryDistanceMm": boundary_mm,
        "centerDistanceMm": boundary_mm + ADD_RADIUS_MM,
        "angleDeg": angle_deg,
        "stationFeatures": station_features,
        "frameCounts": counts,
        "malformedFrameCount": malformed,
        "sourceFiles": [
            {
                "name": path.name,
                "bytes": path.stat().st_size,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
            for path in (meta_path, jsonl_path)
        ],
        "rows": rows,
    }


def load_completed_captures(
    captures_dir: Path,
    session_ids: set[str] | None = None,
) -> list[dict[str, Any]]:
    captures: list[dict[str, Any]] = []
    for meta_path in sorted(captures_dir.glob("*.meta.json")):
        metadata = load_json(meta_path)
        if metadata.get("status") != "completed":
            continue
        started_at = str(metadata.get("startedAt", ""))
        if not started_at.startswith("2026-08-01"):
            continue
        session_id = str(metadata.get("sessionId", ""))
        if session_ids and session_id not in session_ids:
            continue
        captures.append(parse_capture(meta_path, captures_dir))
    if not captures:
        raise ValueError("没有找到已完成的 2026-08-01 四站采集")
    return captures


def group_prototypes(
    captures: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
    groups: dict[tuple[int, float], list[dict[str, Any]]] = defaultdict(list)
    for capture in captures:
        key = (
            int(capture["centerDistanceMm"]),
            float(capture["angleDeg"]),
        )
        groups[key].append(capture)

    prototypes: list[dict[str, Any]] = []
    for (center_mm, angle_deg), rows in sorted(groups.items()):
        features = [
            [
                int(row["stationFeatures"][station]["featureMm"])
                for station in range(4)
            ]
            for row in rows
        ]
        prototype_features = [
            round(statistics.median(row[station] for row in features))
            for station in range(4)
        ]
        prototypes.append(
            {
                "boundaryDistanceMm": center_mm - ADD_RADIUS_MM,
                "centerDistanceMm": center_mm,
                "angleDeg": angle_deg,
                "rangesMm": prototype_features,
                "captureIds": sorted(row["captureId"] for row in rows),
                "repeatCount": len(rows),
            }
        )
    return prototypes


def geometry_ranges(center_mm: float, angle_deg: float) -> list[float]:
    radians = math.radians(angle_deg)
    x = center_mm * math.sin(radians)
    y = center_mm * math.cos(radians)
    return [
        math.hypot(x - sx, y - sy)
        for sx, sy in STATION_COORDS
    ]


def solve_geometry(
    ranges: list[float],
    biases: list[float] | None = None,
) -> tuple[float, float]:
    adjusted = [
        value - (biases[index] if biases else 0.0)
        for index, value in enumerate(ranges)
    ]
    x = 0.0
    y = 1500.0
    for _ in range(12):
        ata00 = ata01 = ata11 = atb0 = atb1 = 0.0
        for (sx, sy), measured in zip(STATION_COORDS, adjusted):
            dx = x - sx
            dy = y - sy
            predicted = max(math.hypot(dx, dy), 1.0)
            residual = measured - predicted
            huber = 1.0 if abs(residual) <= 100.0 else 100.0 / abs(residual)
            jx = dx / predicted
            jy = dy / predicted
            ata00 += huber * jx * jx
            ata01 += huber * jx * jy
            ata11 += huber * jy * jy
            atb0 += huber * jx * residual
            atb1 += huber * jy * residual
        determinant = ata00 * ata11 - ata01 * ata01
        if abs(determinant) < 1e-9:
            break
        step_x = (atb0 * ata11 - atb1 * ata01) / determinant
        step_y = (ata00 * atb1 - ata01 * atb0) / determinant
        x += step_x
        y += step_y
        if abs(step_x) + abs(step_y) < 0.01:
            break
    return x, y


def nearest(
    ranges: list[float],
    prototypes: list[dict[str, Any]],
    scales: list[float],
    excluded: tuple[int, float] | None = None,
    count: int = 4,
) -> list[tuple[float, dict[str, Any]]]:
    rows: list[tuple[float, dict[str, Any]]] = []
    for prototype in prototypes:
        truth = (
            int(prototype["centerDistanceMm"]),
            float(prototype["angleDeg"]),
        )
        if excluded == truth:
            continue
        q = sum(
            (
                (
                    ranges[index] - float(prototype["rangesMm"][index])
                )
                / scales[index]
            )
            ** 2
            for index in range(4)
        )
        rows.append((q, prototype))
    rows.sort(key=lambda row: row[0])
    return rows[:count]


def estimate_knn(
    ranges: list[float],
    prototypes: list[dict[str, Any]],
    scales: list[float],
    excluded: tuple[int, float] | None = None,
    *,
    neighbor_count: int = 4,
    weight_power: float = 1.0,
) -> tuple[float, float, float, float]:
    neighbors = nearest(
        ranges, prototypes, scales, excluded, count=neighbor_count
    )
    weights = [
        1.0 / max(q, 0.0004) ** weight_power for q, _ in neighbors
    ]
    total = sum(weights)
    distance = sum(
        weight * float(row["centerDistanceMm"])
        for weight, (_, row) in zip(weights, neighbors)
    ) / total
    angle = sum(
        weight * float(row["angleDeg"])
        for weight, (_, row) in zip(weights, neighbors)
    ) / total
    span = max(float(row["centerDistanceMm"]) for _, row in neighbors) - min(
        float(row["centerDistanceMm"]) for _, row in neighbors
    )
    return distance, angle, neighbors[0][0], span


def estimate_geometry(
    ranges: list[float],
    biases: list[float],
) -> tuple[float, float, float, float]:
    x, y = solve_geometry(ranges, biases)
    distance = math.hypot(x, y)
    angle = math.degrees(math.atan2(x, y))
    residual = math.sqrt(
        sum(
            (
                math.hypot(x - sx, y - sy)
                - value
                + biases[index]
            )
            ** 2
            for index, ((sx, sy), value) in enumerate(
                zip(STATION_COORDS, ranges)
            )
        )
        / 4.0
    )
    return distance, angle, residual, 0.0


def estimate_hybrid(
    ranges: list[float],
    prototypes: list[dict[str, Any]],
    scales: list[float],
    biases: list[float],
    excluded: tuple[int, float] | None = None,
) -> tuple[float, float, float, float]:
    distance, angle, residual, _ = estimate_geometry(ranges, biases)
    neighbors = nearest(ranges, prototypes, scales, excluded, count=3)
    weights = [1.0 / max(q, 0.0004) for q, _ in neighbors]
    total = sum(weights)
    local_distance = sum(
        weight * float(row["centerDistanceMm"])
        for weight, (_, row) in zip(weights, neighbors)
    ) / total
    local_angle = sum(
        weight * float(row["angleDeg"])
        for weight, (_, row) in zip(weights, neighbors)
    ) / total
    # Keep the geometry result as the main estimate, but shrink toward the
    # local calibrated manifold when the four-circle residual is high.
    alpha = min(max(residual / 180.0, 0.0), 1.0)
    return (
        (1.0 - alpha) * distance + alpha * local_distance,
        (1.0 - alpha) * angle + alpha * local_angle,
        residual,
        neighbors[0][0],
    )


def solve_linear_system(
    matrix: list[list[float]],
    vector: list[float],
) -> list[float]:
    """Small Gauss-Jordan solver used to keep the builder dependency-free."""

    size = len(vector)
    augmented = [
        [float(value) for value in matrix[row]] + [float(vector[row])]
        for row in range(size)
    ]
    for pivot in range(size):
        best = max(
            range(pivot, size),
            key=lambda row: abs(augmented[row][pivot]),
        )
        if abs(augmented[best][pivot]) < 1e-12:
            raise ValueError("角度线性模型矩阵奇异")
        augmented[pivot], augmented[best] = (
            augmented[best],
            augmented[pivot],
        )
        divisor = augmented[pivot][pivot]
        augmented[pivot] = [
            value / divisor for value in augmented[pivot]
        ]
        for row in range(size):
            if row == pivot:
                continue
            factor = augmented[row][pivot]
            augmented[row] = [
                current - factor * pivot_value
                for current, pivot_value in zip(
                    augmented[row], augmented[pivot]
                )
            ]
    return [augmented[row][-1] for row in range(size)]


def fit_angle_linear(
    prototypes: list[dict[str, Any]],
) -> dict[str, Any]:
    means = [
        statistics.mean(float(row["rangesMm"][index]) for row in prototypes)
        for index in range(4)
    ]
    scale = 500.0
    features = [
        [1.0]
        + [
            (float(row["rangesMm"][index]) - means[index]) / scale
            for index in range(4)
        ]
        for row in prototypes
    ]
    targets = [float(row["angleDeg"]) for row in prototypes]
    regularization = 1.0
    matrix = [
        [
            sum(feature[row] * feature[col] for feature in features)
            + (regularization if row == col and row != 0 else 0.0)
            for col in range(5)
        ]
        for row in range(5)
    ]
    vector = [
        sum(features[row][col] * targets[row] for row in range(len(features)))
        for col in range(5)
    ]
    coefficients = solve_linear_system(matrix, vector)
    return {
        "meanMm": means,
        "scaleMm": scale,
        "coefficients": coefficients,
        "regularization": regularization,
    }


def predict_angle_linear(
    ranges: list[float],
    model: dict[str, Any],
) -> float:
    means = model["meanMm"]
    scale = float(model["scaleMm"])
    coefficients = model["coefficients"]
    value = float(coefficients[0])
    for index in range(4):
        value += coefficients[index + 1] * (
            (float(ranges[index]) - float(means[index])) / scale
        )
    return max(-60.0, min(60.0, value))


def fit_biases(prototypes: list[dict[str, Any]]) -> list[float]:
    residuals = [[] for _ in range(4)]
    for row in prototypes:
        expected = geometry_ranges(
            float(row["centerDistanceMm"]),
            float(row["angleDeg"]),
        )
        for index in range(4):
            residuals[index].append(
                float(row["rangesMm"][index]) - expected[index]
            )
    return [statistics.median(values) for values in residuals]


def error_metrics(errors: list[float]) -> dict[str, float | int]:
    ordered = sorted(errors)
    position = (len(ordered) - 1) * 0.95
    low = math.floor(position)
    high = math.ceil(position)
    p95 = ordered[low] if low == high else (
        ordered[low] * (high - position)
        + ordered[high] * (position - low)
    )
    return {
        "count": len(errors),
        "maeMmOrDeg": sum(errors) / len(errors),
        "p95MmOrDeg": p95,
        "maxMmOrDeg": max(errors),
    }


def evaluate_candidates(prototypes: list[dict[str, Any]]) -> dict[str, Any]:
    scales = []
    for station in range(4):
        values = [float(row["rangesMm"][station]) for row in prototypes]
        spread = statistics.pstdev(values)
        scales.append(max(spread, 300.0))
    candidates: dict[str, dict[str, Any]] = {}
    for candidate in (
        "geometry",
        "knn",
        "hybrid",
        "knn_linear_angle",
        "runtime_selected",
    ):
        distance_errors: list[float] = []
        angle_errors: list[float] = []
        worst: dict[str, Any] | None = None
        for held_out in prototypes:
            truth = (
                int(held_out["centerDistanceMm"]),
                float(held_out["angleDeg"]),
            )
            training = [row for row in prototypes if row is not held_out]
            biases = fit_biases(training)
            if candidate == "geometry":
                estimate = estimate_geometry(
                    [float(v) for v in held_out["rangesMm"]],
                    biases,
                )
            elif candidate == "knn":
                estimate = estimate_knn(
                    [float(v) for v in held_out["rangesMm"]],
                    training,
                    scales,
                    truth,
                )
            elif candidate == "hybrid":
                estimate = estimate_hybrid(
                    [float(v) for v in held_out["rangesMm"]],
                    training,
                    scales,
                    biases,
                    truth,
                )
            elif candidate == "knn_linear_angle":
                training_angle = fit_angle_linear(training)
                distance, _, nearest_q, span = estimate_knn(
                    [float(v) for v in held_out["rangesMm"]],
                    training,
                    scales,
                    truth,
                )
                estimate = (
                    distance,
                    predict_angle_linear(
                        [float(v) for v in held_out["rangesMm"]],
                        training_angle,
                    ),
                    nearest_q,
                    span,
                )
            else:
                training_angle = fit_angle_linear(training)
                distance, _, nearest_q, span = estimate_knn(
                    [float(v) for v in held_out["rangesMm"]],
                    training,
                    scales,
                    truth,
                    neighbor_count=3,
                    weight_power=0.5,
                )
                estimate = (
                    distance,
                    predict_angle_linear(
                        [float(v) for v in held_out["rangesMm"]],
                        training_angle,
                    ),
                    nearest_q,
                    span,
                )
            distance_error = abs(estimate[0] - truth[0])
            angle_error = abs(estimate[1] - truth[1])
            distance_errors.append(distance_error)
            angle_errors.append(angle_error)
            if worst is None or distance_error > worst["distanceErrorMm"]:
                worst = {
                    "truth": truth,
                    "estimateDistanceMm": estimate[0],
                    "estimateAngleDeg": estimate[1],
                    "distanceErrorMm": distance_error,
                    "angleErrorDeg": angle_error,
                }
        candidates[candidate] = {
            "distance": error_metrics(distance_errors),
            "angle": error_metrics(angle_errors),
            "worst": worst,
        }
    return {
        "scalesMm": scales,
        "angleLinearModel": fit_angle_linear(prototypes),
        "candidates": candidates,
    }


def q16(value: float) -> int:
    return round(value * 65536.0)


def q24(value: float) -> int:
    return round(value * 16777216.0)


def model_binary(manifest: dict[str, Any]) -> bytes:
    runtime = manifest["runtime"]
    angle_model = manifest["evaluation"]["angleLinearModel"]
    data = bytearray()
    data.extend(struct.pack(
        "<IHHH", MODEL_MAGIC, MODEL_VERSION,
        len(manifest["prototypes"]), MODEL_SERIALIZED_BYTES,
    ))
    data.extend(struct.pack("<HHHH", *STATION_ADDRESSES))
    data.extend(struct.pack(
        "<HHHH", int(runtime["windowMs"]), int(runtime["pairSkewMs"]),
        int(runtime["updatePeriodMs"]), int(runtime["holdMs"]),
    ))
    data.extend(struct.pack(
        "<IIII", *[q16(float(value)) for value in runtime["scaleMm"]]
    ))
    data.extend(struct.pack(
        "<IIHH", q24(float(runtime["qFloor"])),
        q24(float(runtime["highNearestQ"])),
        int(runtime["minimumDistanceMm"]),
        int(runtime["maximumDistanceMm"]),
    ))
    data.extend(struct.pack(
        "<HHHH", *[round(float(value)) for value in angle_model["meanMm"]]
    ))
    data.extend(struct.pack(
        "<iiiii", *[q16(float(value)) for value in angle_model["coefficients"]]
    ))
    data.extend(struct.pack("<H", round(float(angle_model["scaleMm"]))))
    if len(data) != MODEL_HEADER_BYTES:
        raise AssertionError(f"模型头长度错误：{len(data)}")
    for row in manifest["prototypes"]:
        data.extend(
            struct.pack(
                "<HHHHHh",
                *[int(value) for value in row["rangesMm"]],
                int(row["centerDistanceMm"]),
                int(round(float(row["angleDeg"]) * 10.0)),
            )
        )
    return bytes(data)


def render_c_model(manifest: dict[str, Any], crc32: int) -> tuple[str, str]:
    angle_model = manifest["evaluation"]["angleLinearModel"]
    rows = "\n".join(
        "    "
        + "{"
        + "{"
        + ", ".join(str(int(value)) + "U" for value in row["rangesMm"])
        + "}, "
        + str(int(row["centerDistanceMm"])) + "U, "
        + str(int(round(float(row["angleDeg"]) * 10.0)))
        + "},"
        for row in manifest["prototypes"]
    )
    header = """#ifndef FOUR_STATION_MODEL_DATA_H
#define FOUR_STATION_MODEL_DATA_H

#include "uwb_four_station_estimator.h"

extern const UwbFourStationModel g_four_station_model_20260801;

#endif
"""
    source = f"""#include "four_station_model_data.h"

/* Generated by build_four_station_model.py. */
static const UwbFourStationPrototype g_four_station_prototypes[] = {{
{rows}
}};

const UwbFourStationModel g_four_station_model_20260801 = {{
    .magic = UWB_FOUR_STATION_MODEL_MAGIC,
    .version = UWB_FOUR_STATION_MODEL_VERSION,
    .prototype_count = (uint16_t)(sizeof(g_four_station_prototypes) /
                                  sizeof(g_four_station_prototypes[0])),
    .serialized_bytes = UWB_FOUR_STATION_MODEL_SERIALIZED_BYTES,
    .station_address = {{0x0100U, 0x0200U, 0x0300U, 0x0400U}},
    .window_ms = {int(manifest['runtime']['windowMs'])}U,
    .pair_skew_ms = {int(manifest['runtime']['pairSkewMs'])}U,
    .update_period_ms = {int(manifest['runtime']['updatePeriodMs'])}U,
    .hold_ms = {int(manifest['runtime']['holdMs'])}U,
    .scale_q16 = {{{', '.join(str(q16(float(value))) + 'UL' for value in manifest['runtime']['scaleMm'])}}},
    .q_floor_q24 = {q24(float(manifest['runtime']['qFloor']))}UL,
    .high_nearest_q24 = {q24(float(manifest['runtime']['highNearestQ']))}UL,
    .minimum_distance_mm = {int(manifest['runtime']['minimumDistanceMm'])}U,
    .maximum_distance_mm = {int(manifest['runtime']['maximumDistanceMm'])}U,
    .angle_mean_mm = {{{', '.join(str(round(float(value))) + 'U' for value in angle_model['meanMm'])}}},
    .angle_coefficient_q16 = {{{', '.join(str(q16(float(value))) + 'L' for value in angle_model['coefficients'])}}},
    .angle_scale_mm = {round(float(angle_model['scaleMm']))}U,
    .crc32 = 0x{crc32:08X}UL,
    .prototypes = g_four_station_prototypes,
}};
"""
    return header, source


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)[1])
    try:
        temporary.write_text(content, encoding="utf-8")
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()


def make_manifest(
    captures: list[dict[str, Any]],
    prototypes: list[dict[str, Any]],
    evaluation: dict[str, Any],
) -> dict[str, Any]:
    session_ids = sorted({str(row["sessionId"]) for row in captures})
    return {
        "modelId": "four_station_20260801_v1",
        "generatedAt": "2026-08-01",
        "sourceDate": "2026-08-01",
        "sessionIds": session_ids,
        "geometry": {
            "competitionCircleDiameterMm": 600,
            "competitionCircleRadiusMm": 300,
            "boundaryDistanceToCenterOffsetMm": 300,
            "stations": [
                {
                    "index": index,
                    "name": STATION_NAMES[index],
                    "address": f"{STATION_ADDRESSES[index]:04X}",
                    "xMm": STATION_COORDS[index][0],
                    "yMm": STATION_COORDS[index][1],
                }
                for index in range(4)
            ],
            "angleConvention": "atan2(x,y), FRONT=+y, right positive",
        },
        "selection": {
            "completedCaptureCount": len(captures),
            "physicalPointCount": len(prototypes),
            "recordingSessionsExcluded": True,
            "labelCorrections": [],
            "excludedCaptures": [],
        },
        "runtime": {
            "windowMs": 800,
            "pairSkewMs": 120,
            "updatePeriodMs": 100,
            "displayPeriodMs": 500,
            "holdMs": 500,
            "minSamples": 3,
            "neighborCount": 3,
            "scaleMm": [float(value) for value in evaluation["scalesMm"]],
            "qFloor": 0.0004,
            "highNearestQ": 0.40,
            "minimumDistanceMm": 800,
            "maximumDistanceMm": 2300,
            "modelSelection": "knn_k3_inverse_sqrt_q_plus_ridge_angle",
        },
        "evaluation": evaluation,
        "prototypes": prototypes,
        "captures": [
            {
                key: value
                for key, value in capture.items()
                if key != "rows"
            }
            for capture in captures
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--captures", type=Path, default=DEFAULT_CAPTURES)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--audit", type=Path, default=AUDIT_REPORT)
    parser.add_argument("--session", action="append", default=[])
    parser.add_argument(
        "--firmware-dir",
        type=Path,
        default=MODULE_DIR,
        help="将生成的 C 模型表写入哪个固件工程目录",
    )
    args = parser.parse_args()

    session_ids = set(args.session)
    captures = load_completed_captures(args.captures, session_ids or None)
    prototypes = group_prototypes(captures)
    evaluation = evaluate_candidates(prototypes)
    manifest = make_manifest(captures, prototypes, evaluation)
    serialized = model_binary(manifest)
    crc32 = zlib.crc32(serialized) & 0xFFFFFFFF
    manifest["modelCrc32"] = f"{crc32:08X}"
    manifest["modelSerializedBytes"] = len(serialized)
    write_text(args.manifest, json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    write_text(args.audit, json.dumps({
        "modelId": manifest["modelId"],
        "completedCaptureCount": len(captures),
        "physicalPointCount": len(prototypes),
        "sessionIds": manifest["sessionIds"],
        "candidateEvaluation": evaluation,
        "excludedRecordingFiles": True,
        "sourceFileHashes": [
            source
            for capture in captures
            for source in capture["sourceFiles"]
        ],
    }, ensure_ascii=False, indent=2) + "\n")
    header, source = render_c_model(manifest, crc32)
    write_text(args.firmware_dir / "four_station_model_data.h", header)
    write_text(args.firmware_dir / "four_station_model_data.c", source)
    print(json.dumps({
        "manifest": str(args.manifest),
        "audit": str(args.audit),
        "modelHeader": str(args.firmware_dir / "four_station_model_data.h"),
        "modelSource": str(args.firmware_dir / "four_station_model_data.c"),
        "completedCaptureCount": len(captures),
        "physicalPointCount": len(prototypes),
        "modelSerializedBytes": len(serialized),
        "modelCrc32": f"{crc32:08X}",
        "candidateEvaluation": evaluation,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
