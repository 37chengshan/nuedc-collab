#!/usr/bin/env python3
"""Reproduce the frozen two-station leave-out and rolling-window evidence."""

from __future__ import annotations

import argparse
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

from build_two_station_model import (
    DEFAULT_MANIFEST,
    audit_captures,
    load_json,
    parse_capture_truth,
)


DEFAULT_CAPTURES = Path(
    "/private/tmp/nuedc-serial-pages.ksb2Ur/"
    "apps/uwb-recorder/data/captures"
)


def percentile(values: Iterable[float], fraction: float) -> float:
    ordered = sorted(values)
    if not ordered:
        raise ValueError("百分位数输入不能为空")
    position = (len(ordered) - 1) * fraction
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return (
        ordered[lower] * (upper - position)
        + ordered[upper] * (position - lower)
    )


def error_metrics(errors: list[float]) -> dict[str, float | int]:
    if not errors:
        raise ValueError("误差集合不能为空")
    return {
        "count": len(errors),
        "maeMm": sum(errors) / len(errors),
        "p95Mm": percentile(errors, 0.95),
        "maxMm": max(errors),
    }


def four_nearest(
    right_mm: float,
    left_mm: float,
    manifest: dict[str, Any],
    excluded_truth: tuple[int, int] | None,
) -> list[tuple[float, dict[str, Any]]]:
    runtime = manifest["runtime"]
    scale_right = float(runtime["scaleRightMm"])
    scale_left = float(runtime["scaleLeftMm"])
    neighbors: list[tuple[float, dict[str, Any]]] = []

    for prototype in manifest["prototypes"]:
        truth = (
            int(prototype["distanceMm"]),
            int(prototype["angleDeg"]),
        )
        if truth == excluded_truth:
            continue
        q = (
            (right_mm - float(prototype["rightMm"])) / scale_right
        ) ** 2 + (
            (left_mm - float(prototype["leftMm"])) / scale_left
        ) ** 2
        neighbors.append((q, prototype))
    neighbors.sort(key=lambda row: row[0])
    return neighbors[: int(runtime["neighborCount"])]


def estimate_distance(
    right_mm: float,
    left_mm: float,
    manifest: dict[str, Any],
    excluded_truth: tuple[int, int] | None,
) -> tuple[float, float, int]:
    runtime = manifest["runtime"]
    neighbors = four_nearest(
        right_mm, left_mm, manifest, excluded_truth
    )
    q_floor = float(runtime["qFloor"])
    weights = [1.0 / max(q, q_floor) for q, _ in neighbors]
    total_weight = sum(weights)
    distance_mm = sum(
        weight * float(prototype["distanceMm"])
        for weight, (_, prototype) in zip(weights, neighbors)
    ) / total_weight
    distance_mm = max(
        float(runtime["minimumDistanceMm"]),
        min(float(runtime["maximumDistanceMm"]), distance_mm),
    )
    distances = [
        int(prototype["distanceMm"]) for _, prototype in neighbors
    ]
    return (
        distance_mm,
        neighbors[0][0],
        max(distances) - min(distances),
    )


def grouped_physical_point_leave_out(
    manifest: dict[str, Any],
) -> dict[str, float | int]:
    errors: list[float] = []

    for prototype in manifest["prototypes"]:
        truth = (
            int(prototype["distanceMm"]),
            int(prototype["angleDeg"]),
        )
        prediction, _, _ = estimate_distance(
            float(prototype["rightMm"]),
            float(prototype["leftMm"]),
            manifest,
            truth,
        )
        errors.append(abs(prediction - truth[0]))
    return error_metrics(errors)


def median_absolute_deviation(values: list[int]) -> float:
    center = statistics.median(values)
    return statistics.median(abs(value - center) for value in values)


def load_capture_frames(path: Path) -> list[dict[str, Any]]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line
    ]


def rolling_window_leave_out(
    captures_dir: Path,
    manifest: dict[str, Any],
    *,
    require_left_snr: bool = True,
) -> dict[str, Any]:
    selection = manifest["selection"]
    runtime = manifest["runtime"]
    window_ms = int(runtime["windowMs"])
    update_period_ms = int(runtime["updatePeriodMs"])
    pair_skew_ms = int(runtime["pairSkewMs"])
    warmup_ms = int(selection["warmupMs"])
    rolling_errors: list[float] = []
    high_errors: list[float] = []
    medium_errors: list[float] = []
    scheduled_windows = 0
    estimable_windows = 0
    high_windows = 0
    medium_windows = 0
    reject_windows = 0
    evaluated_captures = 0
    physical_points: set[tuple[int, int]] = set()

    for metadata_path in sorted(captures_dir.glob("*.meta.json")):
        metadata = load_json(metadata_path)
        if metadata.get("sessionId") != manifest["sessionId"]:
            continue
        truth = parse_capture_truth(metadata, manifest)
        if truth is None:
            continue

        frame_path = captures_dir / f"{metadata['id']}.jsonl"
        rows = load_capture_frames(frame_path)
        by_device: dict[int, list[tuple[int, int, int | None]]] = {
            1: [],
            2: [],
        }
        for row in rows:
            device = int(row.get("device", 0))
            range_mm = int(row.get("distanceCm", 0)) * 10
            if (
                row.get("type") != "frame"
                or device not in by_device
                or range_mm < int(selection["validRangeMm"][0])
                or range_mm > int(selection["validRangeMm"][1])
            ):
                continue
            snr = row.get("snrDb")
            by_device[device].append(
                (
                    int(row["elapsedMs"]),
                    range_mm,
                    None if snr is None else int(snr),
                )
            )
        if not by_device[1] or not by_device[2]:
            continue

        evaluated_captures += 1
        physical_points.add(truth)
        start_ms = int(rows[0]["elapsedMs"]) + warmup_ms
        end_ms = int(rows[-1]["elapsedMs"])
        recent_distances: list[float] = []

        for now_ms in range(
            start_ms, end_ms + 1, update_period_ms
        ):
            scheduled_windows += 1
            link_stats: list[dict[str, float | int | None]] = []
            ready = True

            for device in (1, 2):
                window = [
                    row
                    for row in by_device[device]
                    if (now_ms - window_ms) <= row[0] <= now_ms
                ]
                if len(window) < 3:
                    ready = False
                    break
                ranges = sorted(row[1] for row in window)
                snr_values = [
                    row[2] for row in window if row[2] is not None
                ]
                link_stats.append(
                    {
                        "featureMm": sum(ranges[:3]) / 3.0,
                        "madMm": median_absolute_deviation(ranges),
                        "snrDb": (
                            statistics.median(snr_values)
                            if snr_values
                            else None
                        ),
                        "sampleCount": len(ranges),
                        "latestTimestampMs": max(
                            row[0] for row in window
                        ),
                    }
                )
            if not ready:
                continue
            if (
                abs(
                    int(link_stats[0]["latestTimestampMs"])
                    - int(link_stats[1]["latestTimestampMs"])
                )
                > pair_skew_ms
            ):
                continue

            estimable_windows += 1
            right = link_stats[0]
            left = link_stats[1]
            distance_mm, nearest_q, neighbor_span_mm = (
                estimate_distance(
                    float(right["featureMm"]),
                    float(left["featureMm"]),
                    manifest,
                    truth,
                )
            )
            recent_distances.append(distance_mm)
            recent_distances = recent_distances[-3:]
            stable = (
                len(recent_distances) == 3
                and (
                    max(recent_distances) - min(recent_distances)
                    <= 150.0
                )
            )
            feature_delta = abs(
                float(right["featureMm"])
                - float(left["featureMm"])
            )
            high_snr_ok = (
                not require_left_snr
                or (
                    left["snrDb"] is not None
                    and float(left["snrDb"]) >= -5.0
                )
            )
            medium_snr_ok = (
                not require_left_snr
                or (
                    left["snrDb"] is not None
                    and float(left["snrDb"]) >= -6.0
                )
            )
            high = (
                int(right["sampleCount"]) >= 6
                and int(left["sampleCount"]) >= 6
                and float(right["madMm"]) <= 50.0
                and float(left["madMm"]) <= 50.0
                and high_snr_ok
                and feature_delta <= 300.0
                and nearest_q <= 0.4
                and neighbor_span_mm <= 400
                and stable
            )
            medium = (
                int(right["sampleCount"]) >= 5
                and int(left["sampleCount"]) >= 5
                and float(right["madMm"]) <= 100.0
                and float(left["madMm"]) <= 100.0
                and medium_snr_ok
                and feature_delta <= 500.0
                and neighbor_span_mm <= 400
            )
            error_mm = abs(distance_mm - truth[0])
            rolling_errors.append(error_mm)

            if high:
                high_windows += 1
                high_errors.append(error_mm)
            elif medium:
                medium_windows += 1
                medium_errors.append(error_mm)
            else:
                reject_windows += 1

    return {
        "evaluatedCaptureCount": evaluated_captures,
        "physicalPointCount": len(physical_points),
        "scheduledWindowCount": scheduled_windows,
        "estimableWindowCount": estimable_windows,
        "estimableCoverageRatio": (
            estimable_windows / scheduled_windows
            if scheduled_windows
            else 0.0
        ),
        "allEstimable": error_metrics(rolling_errors),
        "high": {
            **error_metrics(high_errors),
            "coverageRatio": (
                high_windows / scheduled_windows
                if scheduled_windows
                else 0.0
            ),
        },
        "medium": {
            **error_metrics(medium_errors),
            "coverageRatio": (
                medium_windows / scheduled_windows
                if scheduled_windows
                else 0.0
            ),
        },
        "rejectWindowCount": reject_windows,
    }


def acceptance(
    capture_audit: dict[str, Any],
    grouped: dict[str, float | int],
    rolling: dict[str, Any],
    no_snr_replay: dict[str, Any],
) -> dict[str, bool]:
    return {
        "captureCount56": capture_audit["usableCaptureCount"] == 56,
        "physicalPointCount43": (
            capture_audit["physicalPointCount"] == 43
        ),
        "groupedMaeLe55Mm": float(grouped["maeMm"]) <= 55.0,
        "groupedP95Le170Mm": float(grouped["p95Mm"]) <= 170.0,
        "groupedMaxLe190Mm": float(grouped["maxMm"]) <= 190.0,
        "rollingP95Le180Mm": (
            float(rolling["allEstimable"]["p95Mm"]) <= 180.0
        ),
        "highP95Le120Mm": (
            float(rolling["high"]["p95Mm"]) <= 120.0
        ),
        "highMaxLe300Mm": (
            float(rolling["high"]["maxMm"]) <= 300.0
        ),
        "highCoverageGe20Pct": (
            float(rolling["high"]["coverageRatio"]) >= 0.20
        ),
        "noSnrHighP95Le120Mm": (
            float(no_snr_replay["high"]["p95Mm"]) <= 120.0
        ),
        "noSnrHighMaxLe300Mm": (
            float(no_snr_replay["high"]["maxMm"]) <= 300.0
        ),
        "noSnrHighCoverageGe20Pct": (
            float(no_snr_replay["high"]["coverageRatio"]) >= 0.20
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--captures", type=Path, default=DEFAULT_CAPTURES)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Exit non-zero if any frozen acceptance threshold fails.",
    )
    args = parser.parse_args()

    manifest = load_json(args.manifest)
    capture_audit = audit_captures(args.captures, manifest)
    grouped = grouped_physical_point_leave_out(manifest)
    rolling = rolling_window_leave_out(args.captures, manifest)
    no_snr_replay = rolling_window_leave_out(
        args.captures, manifest, require_left_snr=False
    )
    checks = acceptance(
        capture_audit, grouped, rolling, no_snr_replay
    )
    report = {
        "sessionId": manifest["sessionId"],
        "captureAudit": {
            "sessionCaptureCount": capture_audit[
                "sessionCaptureCount"
            ],
            "usableCaptureCount": capture_audit[
                "usableCaptureCount"
            ],
            "physicalPointCount": capture_audit[
                "physicalPointCount"
            ],
        },
        "groupedPhysicalPointLeaveOut": grouped,
        "rollingWindowLeaveOut": rolling,
        "noSnrCompatibilityReplay": no_snr_replay,
        "acceptance": checks,
        "passed": all(checks.values()),
        "notes": [
            "All rolling metrics use the final 43-point table.",
            "Each physical point is removed from the neighbor table "
            "while evaluating that point.",
            "HIGH coverage uses all scheduled 100 ms windows as "
            "the denominator.",
            "noSnrCompatibilityReplay removes only the SNR gate to "
            "model the vendor responder frame after both links agree "
            "on one key address; it is not a no-SNR hardware capture.",
            "This is an offline host replay, not target-board WCET "
            "or on-board validation.",
        ],
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.check and not report["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
