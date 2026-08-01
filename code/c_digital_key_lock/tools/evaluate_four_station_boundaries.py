#!/usr/bin/env python3
"""Evaluate the selected four-station model at the 1 m and 2 m zones."""

from __future__ import annotations

import json
import math
import statistics
from collections import defaultdict
from pathlib import Path

from build_four_station_model import DEFAULT_CAPTURES, DEFAULT_MANIFEST, load_json
from evaluate_four_station_model import (
    knn_estimate,
    model_scales,
    rolling_vectors,
)


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    low = math.floor(position)
    high = math.ceil(position)
    return ordered[low] if low == high else (
        ordered[low] * (high - position)
        + ordered[high] * (position - low)
    )


def main() -> None:
    manifest = load_json(DEFAULT_MANIFEST)
    prototypes = list(manifest["prototypes"])
    captures_by_point: dict[tuple[int, float], list[dict]] = defaultdict(list)
    for capture in manifest["captures"]:
        key = (int(capture["centerDistanceMm"]), float(capture["angleDeg"]))
        captures_by_point[key].append(capture)

    by_boundary: dict[int, list[float]] = defaultdict(list)
    records: list[dict] = []
    for held_out in prototypes:
        truth = (
            int(held_out["centerDistanceMm"]),
            float(held_out["angleDeg"]),
        )
        training = [
            row
            for row in prototypes
            if (
                int(row["centerDistanceMm"]),
                float(row["angleDeg"]),
            )
            != truth
        ]
        scales = model_scales(training)
        for capture in captures_by_point[truth]:
            for vector in rolling_vectors(DEFAULT_CAPTURES, capture):
                center_mm, _, nearest_q, span_mm = knn_estimate(
                    vector["rangesMm"],
                    training,
                    scales,
                    neighbors=3,
                    q_floor=0.0004,
                    power=0.5,
                )
                boundary_mm = center_mm - 300.0
                true_boundary_mm = truth[0] - 300
                by_boundary[true_boundary_mm].append(boundary_mm)
                records.append(
                    {
                        "trueBoundaryMm": true_boundary_mm,
                        "estimateBoundaryMm": boundary_mm,
                        "nearestQ": nearest_q,
                        "neighborSpanMm": span_mm,
                        "high": (
                            nearest_q <= 0.40
                            and span_mm <= 400
                            and max(vector["madMm"]) <= 100
                            and min(vector["sampleCount"]) >= 5
                        ),
                    }
                )

    per_distance = {}
    for truth, estimates in sorted(by_boundary.items()):
        errors = [abs(value - truth) for value in estimates]
        per_distance[str(truth)] = {
            "count": len(estimates),
            "maeMm": statistics.mean(errors),
            "p95Mm": percentile(errors, 0.95),
            "maxMm": max(errors),
            "estimateP05Mm": percentile(estimates, 0.05),
            "estimateMedianMm": statistics.median(estimates),
            "estimateP95Mm": percentile(estimates, 0.95),
        }

    high = [row for row in records if row["high"]]
    report = {
        "modelId": manifest["modelId"],
        "selectedModel": "four-dimensional 3-NN, inverse sqrt(q)",
        "windowCount": len(records),
        "perTrueBoundaryDistance": per_distance,
        "zoneEntryThresholds": {
            "unlockEntryMm": 900,
            "unlockExitMm": 1000,
            "welcomeEntryMm": 1900,
            "welcomeExitMm": 2000,
            "confirmationFrames": 3,
        },
        "safetyChecks": {
            "true1200EstimatedAtOrBelowUnlockEntry": sum(
                row["trueBoundaryMm"] == 1200
                and row["estimateBoundaryMm"] <= 900
                for row in records
            ),
            "true1800EstimatedAboveWelcomeExit": sum(
                row["trueBoundaryMm"] == 1800
                and row["estimateBoundaryMm"] > 2000
                for row in records
            ),
            "highCoverage": len(high) / len(records),
        },
        "knownLimitation": (
            "No completed calibration point is beyond the 2 m boundary. "
            "The >2 m continuous-distance extrapolation is therefore not "
            "validated; authorization remains fail-closed outside the "
            "calibrated manifold."
        ),
    }
    output = DEFAULT_MANIFEST.with_name(
        "four_station_20260801_boundary_report.json"
    )
    output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"output": str(output), **report}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
