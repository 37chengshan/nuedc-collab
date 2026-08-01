#!/usr/bin/env python3
"""Angle-specialist search with clipping and temporal filtering."""

from __future__ import annotations

import argparse
import json
from collections import defaultdict, deque
from pathlib import Path
from typing import Any, Callable

import numpy as np
from sklearn.linear_model import Ridge
from sklearn.neural_network import MLPRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import PolynomialFeatures, StandardScaler

from build_four_station_model import DEFAULT_CAPTURES, DEFAULT_MANIFEST, load_json
from evaluate_four_station_model import rolling_vectors
from search_four_station_algorithms import TransformedRegressor, engineered_features


def summarize(prediction: np.ndarray, truth: np.ndarray) -> dict[str, Any]:
    error = np.abs(prediction - truth)
    nonzero = np.abs(truth) >= 7.5
    sign_correct = np.sign(prediction[nonzero]) == np.sign(truth[nonzero])
    return {
        "count": int(error.size),
        "maeDeg": float(np.mean(error)),
        "p95Deg": float(np.percentile(error, 95)),
        "maxDeg": float(np.max(error)),
        "within15Deg": float(np.mean(error <= 15.0)),
        "within30Deg": float(np.mean(error <= 30.0)),
        "signAccuracyNonzero": float(np.mean(sign_correct)) if sign_correct.size else 1.0,
    }


def temporal_filter(values: np.ndarray, width: int) -> np.ndarray:
    history: deque[float] = deque(maxlen=width)
    output: list[float] = []
    for value in values:
        history.append(float(value))
        output.append(float(np.median(np.asarray(history))))
    return np.asarray(output)


def factories() -> dict[str, Callable[[], Any]]:
    result: dict[str, Callable[[], Any]] = {}
    for alpha in (1.0, 3.0, 10.0, 30.0, 100.0):
        result[f"ridge_raw_a{alpha:g}"] = lambda a=alpha: make_pipeline(
            StandardScaler(), Ridge(alpha=a)
        )
        result[f"ridge_eng_a{alpha:g}"] = lambda a=alpha: TransformedRegressor(
            engineered_features,
            make_pipeline(StandardScaler(), Ridge(alpha=a)),
        )
    for alpha in (0.3, 1.0, 3.0, 10.0, 30.0):
        result[f"poly2_a{alpha:g}"] = lambda a=alpha: make_pipeline(
            StandardScaler(),
            PolynomialFeatures(2, include_bias=False),
            Ridge(alpha=a),
        )
    for hidden in (3, 4, 6, 8):
        for alpha in (0.3, 1.0, 3.0, 10.0, 30.0):
            result[f"mlp{hidden}_a{alpha:g}"] = lambda h=hidden, a=alpha: make_pipeline(
                StandardScaler(),
                MLPRegressor(
                    hidden_layer_sizes=(h,),
                    activation="tanh",
                    solver="lbfgs",
                    alpha=a,
                    max_iter=5000,
                    random_state=20260801,
                ),
            )
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--captures", type=Path, default=DEFAULT_CAPTURES)
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_MANIFEST.with_name("four_station_20260801_angle_search.json"),
    )
    args = parser.parse_args()
    manifest = load_json(args.manifest)
    prototypes = list(manifest["prototypes"])
    x = np.asarray([row["rangesMm"] for row in prototypes], dtype=float)
    y = np.asarray([row["angleDeg"] for row in prototypes], dtype=float)
    captures: dict[tuple[int, float], list[dict[str, Any]]] = defaultdict(list)
    for capture in manifest["captures"]:
        key = (int(capture["centerDistanceMm"]), float(capture["angleDeg"]))
        captures[key].append(capture)
    replay = {
        str(capture["captureId"]): rolling_vectors(args.captures, capture)
        for capture in manifest["captures"]
    }

    results: list[dict[str, Any]] = []
    for name, factory in factories().items():
        point_prediction: list[float] = []
        point_truth: list[float] = []
        window_prediction: dict[int, list[float]] = {1: [], 3: [], 5: [], 9: []}
        window_truth: list[float] = []
        per_truth: dict[str, list[float]] = defaultdict(list)
        for held_index, held in enumerate(prototypes):
            mask = np.arange(len(prototypes)) != held_index
            model = factory().fit(x[mask], y[mask])
            point_value = float(np.clip(model.predict(x[[held_index]])[0], -45.0, 45.0))
            point_prediction.append(point_value)
            point_truth.append(y[held_index])
            key = (int(held["centerDistanceMm"]), float(held["angleDeg"]))
            for capture in captures[key]:
                vectors = replay[str(capture["captureId"])]
                if not vectors:
                    continue
                capture_x = np.asarray([row["rangesMm"] for row in vectors], dtype=float)
                raw = np.clip(model.predict(capture_x), -45.0, 45.0)
                # Display is 500 ms. Retain each fifth 100 ms estimate after
                # filtering; histories never cross capture boundaries.
                selected_truth_count = len(raw[::5])
                window_truth.extend([y[held_index]] * selected_truth_count)
                for width in window_prediction:
                    filtered = temporal_filter(raw, width)[::5]
                    window_prediction[width].extend(filtered.tolist())
                per_truth[f"{y[held_index]:g}"].extend(
                    np.abs(raw[::5] - y[held_index]).tolist()
                )
        truth_array = np.asarray(window_truth)
        row = {
            "id": name,
            "point": summarize(np.asarray(point_prediction), np.asarray(point_truth)),
            "display500ms": {
                f"median{width}": summarize(np.asarray(values), truth_array)
                for width, values in window_prediction.items()
            },
            "perTruthAngle": {
                key: {
                    "count": len(values),
                    "maeDeg": float(np.mean(values)),
                    "p95Deg": float(np.percentile(values, 95)),
                }
                for key, values in sorted(per_truth.items(), key=lambda item: float(item[0]))
            },
        }
        results.append(row)
        print(name)

    ranked = sorted(
        results,
        key=lambda row: (
            row["display500ms"]["median5"]["p95Deg"],
            row["display500ms"]["median5"]["maeDeg"],
            row["point"]["p95Deg"],
            row["display500ms"]["median5"]["maxDeg"],
        ),
    )
    output = {
        "modelId": manifest["modelId"],
        "split": "leave-one-physical-point-out",
        "displayPeriodMs": 500,
        "filterWidthSamplesAt100Ms": [1, 3, 5, 9],
        "winner": ranked[0],
        "ranking": ranked,
    }
    args.output.write_text(
        json.dumps(output, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({"output": str(args.output), "winner": ranked[0]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
