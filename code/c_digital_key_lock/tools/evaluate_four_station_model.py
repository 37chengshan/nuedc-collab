#!/usr/bin/env python3
"""Benchmark four-station variants on point holdout and 0.8 s replay.

Every test point is removed as a whole: all repeated captures and all rolling
windows from that distance/angle point remain test-only. This prevents the
same physical point from appearing in both training and test data.
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path
from typing import Any

from build_four_station_model import (
    DEFAULT_CAPTURES,
    DEFAULT_MANIFEST,
    error_metrics,
    fit_angle_linear,
    load_json,
    nearest,
    normalize_label,
    predict_angle_linear,
    robust_feature,
)


def point_key(row: dict[str, Any]) -> tuple[int, float]:
    return int(row["centerDistanceMm"]), float(row["angleDeg"])


def load_capture_rows(captures_dir: Path, capture_id: str) -> list[dict[str, Any]]:
    path = captures_dir / f"{capture_id}.jsonl"
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line
    ]


def rolling_vectors(
    captures_dir: Path,
    capture: dict[str, Any],
    *,
    window_ms: int = 800,
    period_ms: int = 100,
    warmup_ms: int = 2000,
    pair_skew_ms: int = 120,
) -> list[dict[str, Any]]:
    by_station: dict[int, list[tuple[int, int, int | None]]] = {
        station: [] for station in range(4)
    }
    for row in load_capture_rows(captures_dir, str(capture["captureId"])):
        if row.get("type") != "frame":
            continue
        station = int(row.get("device", 0)) - 1
        if station not in by_station:
            continue
        expected = f"{station + 1:02X}00"
        if str(row.get("address", "")).upper() != expected:
            continue
        distance_mm = int(row.get("distanceCm", 0)) * 10
        if not 300 <= distance_mm <= 5000:
            continue
        by_station[station].append(
            (
                int(row["elapsedMs"]),
                distance_mm,
                None if row.get("snrDb") is None else int(row["snrDb"]),
            )
        )
    start_ms = max(rows[0][0] for rows in by_station.values()) + warmup_ms
    end_ms = min(rows[-1][0] for rows in by_station.values())
    vectors: list[dict[str, Any]] = []
    for now_ms in range(start_ms, end_ms + 1, period_ms):
        features: list[int] = []
        mads: list[float] = []
        snrs: list[float | None] = []
        counts: list[int] = []
        latest: list[int] = []
        ready = True
        for station in range(4):
            window = [
                row
                for row in by_station[station]
                if now_ms - window_ms <= row[0] <= now_ms
            ]
            if len(window) < 3:
                ready = False
                break
            distances = [row[1] for row in window]
            center = statistics.median(distances)
            features.append(robust_feature(distances))
            mads.append(
                statistics.median(abs(value - center) for value in distances)
            )
            snr_values = [row[2] for row in window if row[2] is not None]
            snrs.append(statistics.median(snr_values) if snr_values else None)
            counts.append(len(window))
            latest.append(max(row[0] for row in window))
        if not ready or max(latest) - min(latest) > pair_skew_ms:
            continue
        vectors.append(
            {
                "nowMs": now_ms,
                "rangesMm": features,
                "madMm": mads,
                "snrDb": snrs,
                "sampleCount": counts,
                "pairSkewMs": max(latest) - min(latest),
            }
        )
    return vectors


def knn_estimate(
    ranges: list[float],
    training: list[dict[str, Any]],
    scales: list[float],
    *,
    neighbors: int,
    q_floor: float,
    power: float,
) -> tuple[float, float, float, float]:
    rows = nearest(ranges, training, scales, None, count=neighbors)
    weights = [1.0 / max(q, q_floor) ** power for q, _ in rows]
    total = sum(weights)
    distance = sum(
        weight * float(row["centerDistanceMm"])
        for weight, (_, row) in zip(weights, rows)
    ) / total
    angle = sum(
        weight * float(row["angleDeg"])
        for weight, (_, row) in zip(weights, rows)
    ) / total
    distances = [float(row["centerDistanceMm"]) for _, row in rows]
    return distance, angle, rows[0][0], max(distances) - min(distances)


def model_scales(prototypes: list[dict[str, Any]]) -> list[float]:
    return [
        max(
            statistics.pstdev(
                float(row["rangesMm"][station]) for row in prototypes
            ),
            300.0,
        )
        for station in range(4)
    ]


def metric_summary(errors: list[float]) -> dict[str, float | int]:
    result = error_metrics(errors)
    return {
        "count": result["count"],
        "mae": result["maeMmOrDeg"],
        "p95": result["p95MmOrDeg"],
        "max": result["maxMmOrDeg"],
    }


def benchmark(
    captures_dir: Path,
    manifest: dict[str, Any],
) -> dict[str, Any]:
    prototypes = list(manifest["prototypes"])
    captures = list(manifest["captures"])
    grouped_captures: dict[tuple[int, float], list[dict[str, Any]]] = defaultdict(list)
    for capture in captures:
        grouped_captures[point_key(capture)].append(capture)

    replay_cache = {
        str(capture["captureId"]): rolling_vectors(captures_dir, capture)
        for capture in captures
    }
    variants: list[dict[str, Any]] = []
    for k in (2, 3, 4, 5, 6):
        for power in (0.5, 1.0, 1.5):
            for scale_mode in ("station", "global"):
                point_distance_errors: list[float] = []
                point_angle_errors: list[float] = []
                window_distance_errors: list[float] = []
                window_angle_errors: list[float] = []
                window_records: list[dict[str, Any]] = []
                for held_out in prototypes:
                    truth = point_key(held_out)
                    training = [row for row in prototypes if point_key(row) != truth]
                    station_scales = model_scales(training)
                    scales = station_scales
                    if scale_mode == "global":
                        global_scale = statistics.mean(station_scales)
                        scales = [global_scale] * 4
                    angle_model = fit_angle_linear(training)
                    estimate = knn_estimate(
                        [float(value) for value in held_out["rangesMm"]],
                        training,
                        scales,
                        neighbors=k,
                        q_floor=0.0004,
                        power=power,
                    )
                    point_distance_errors.append(abs(estimate[0] - truth[0]))
                    point_angle_errors.append(
                        abs(
                            predict_angle_linear(
                                [float(value) for value in held_out["rangesMm"]],
                                angle_model,
                            )
                            - truth[1]
                        )
                    )
                    for capture in grouped_captures[truth]:
                        for vector in replay_cache[str(capture["captureId"])]:
                            distance, local_angle, nearest_q, span = knn_estimate(
                                [float(value) for value in vector["rangesMm"]],
                                training,
                                scales,
                                neighbors=k,
                                q_floor=0.0004,
                                power=power,
                            )
                            linear_angle = predict_angle_linear(
                                [float(value) for value in vector["rangesMm"]],
                                angle_model,
                            )
                            distance_error = abs(distance - truth[0])
                            angle_error = abs(linear_angle - truth[1])
                            window_distance_errors.append(distance_error)
                            window_angle_errors.append(angle_error)
                            window_records.append(
                                {
                                    "distanceErrorMm": distance_error,
                                    "angleErrorDeg": angle_error,
                                    "nearestQ": nearest_q,
                                    "neighborSpanMm": span,
                                    "madMaxMm": max(vector["madMm"]),
                                    "sampleMin": min(vector["sampleCount"]),
                                    "snrMinDb": min(
                                        value
                                        for value in vector["snrDb"]
                                        if value is not None
                                    ),
                                    "angleDisagreementDeg": abs(
                                        linear_angle - local_angle
                                    ),
                                }
                            )
                high = [
                    row
                    for row in window_records
                    if row["nearestQ"] <= 0.40
                    and row["neighborSpanMm"] <= 400
                    and row["madMaxMm"] <= 100
                    and row["sampleMin"] >= 5
                ]
                medium = [
                    row
                    for row in window_records
                    if row["nearestQ"] <= 0.80
                    and row["neighborSpanMm"] <= 800
                    and row["madMaxMm"] <= 150
                    and row["sampleMin"] >= 4
                ]
                variants.append(
                    {
                        "id": f"knn-k{k}-p{power:g}-{scale_mode}+ridge-angle",
                        "parameters": {
                            "neighbors": k,
                            "weightPower": power,
                            "scaleMode": scale_mode,
                        },
                        "pointDistance": metric_summary(point_distance_errors),
                        "pointAngle": metric_summary(point_angle_errors),
                        "windowDistance": metric_summary(window_distance_errors),
                        "windowAngle": metric_summary(window_angle_errors),
                        "highCoverage": len(high) / len(window_records),
                        "highDistance": metric_summary(
                            [row["distanceErrorMm"] for row in high]
                        ) if high else None,
                        "highAngle": metric_summary(
                            [row["angleErrorDeg"] for row in high]
                        ) if high else None,
                        "mediumCoverage": len(medium) / len(window_records),
                        "mediumDistance": metric_summary(
                            [row["distanceErrorMm"] for row in medium]
                        ) if medium else None,
                    }
                )

    # Distance is the primary objective. Angle and worst point break ties.
    variants.sort(
        key=lambda row: (
            row["windowDistance"]["p95"],
            row["pointDistance"]["p95"],
            row["windowAngle"]["mae"],
            row["windowDistance"]["max"],
        )
    )
    return {
        "modelId": manifest["modelId"],
        "split": "leave-one-physical-point-out",
        "captureCount": len(captures),
        "physicalPointCount": len(prototypes),
        "rollingWindowCount": sum(len(rows) for rows in replay_cache.values()),
        "winner": variants[0],
        "variants": variants,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--captures", type=Path, default=DEFAULT_CAPTURES)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_MANIFEST.with_name("four_station_20260801_benchmark.json"),
    )
    args = parser.parse_args()
    result = benchmark(args.captures, load_json(args.manifest))
    args.output.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "output": str(args.output),
        "captureCount": result["captureCount"],
        "physicalPointCount": result["physicalPointCount"],
        "rollingWindowCount": result["rollingWindowCount"],
        "winner": result["winner"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
