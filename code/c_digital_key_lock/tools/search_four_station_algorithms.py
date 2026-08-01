#!/usr/bin/env python3
"""Search deployable four-UWB distance/angle estimators.

The search is intentionally grouped by physical point. For every fold, all
captures and all rolling windows of one (distance, angle) point are held out.
This script records both deployable fixed-point-friendly models and several
offline upper bounds, so a complex model is not selected merely because it
fits the 27 prototype rows well.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any, Callable

import numpy as np
from sklearn.cross_decomposition import PLSRegression
from sklearn.ensemble import ExtraTreesRegressor, RandomForestRegressor
from sklearn.kernel_ridge import KernelRidge
from sklearn.linear_model import Ridge
from sklearn.neural_network import MLPRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import PolynomialFeatures, StandardScaler
from sklearn.svm import SVR

from build_four_station_model import DEFAULT_CAPTURES, DEFAULT_MANIFEST, load_json
from evaluate_four_station_model import rolling_vectors


def metrics(error: np.ndarray) -> dict[str, float | int]:
    values = np.abs(np.asarray(error, dtype=float))
    return {
        "count": int(values.size),
        "mae": float(np.mean(values)),
        "p95": float(np.percentile(values, 95)),
        "max": float(np.max(values)),
    }


def engineered_features(values: np.ndarray) -> np.ndarray:
    """Physical common/differential features without learned parameters."""

    x = np.asarray(values, dtype=float)
    left, right, down, up = [x[:, index] for index in range(4)]
    horizontal_sum = left + right
    vertical_sum = down + up
    horizontal_diff = left - right
    vertical_diff = down - up
    epsilon = 1.0
    return np.column_stack(
        (
            x,
            horizontal_sum,
            vertical_sum,
            horizontal_diff,
            vertical_diff,
            horizontal_diff / (horizontal_sum + epsilon),
            vertical_diff / (vertical_sum + epsilon),
            (horizontal_sum - vertical_sum)
            / (horizontal_sum + vertical_sum + epsilon),
        )
    )


class TransformedRegressor:
    def __init__(self, transform: Callable[[np.ndarray], np.ndarray], model: Any):
        self.transform = transform
        self.model = model

    def fit(self, x: np.ndarray, y: np.ndarray) -> "TransformedRegressor":
        self.model.fit(self.transform(x), y)
        return self

    def predict(self, x: np.ndarray) -> np.ndarray:
        return np.asarray(self.model.predict(self.transform(x))).reshape(-1)


class ResidualKernelRegressor:
    """Global ridge trend plus fixed-point-friendly inverse-distance residual."""

    def __init__(self, alpha: float, k: int, q_floor: float, power: float):
        self.alpha = alpha
        self.k = k
        self.q_floor = q_floor
        self.power = power

    def fit(self, x: np.ndarray, y: np.ndarray) -> "ResidualKernelRegressor":
        self.mean = np.mean(x, axis=0)
        self.scale = np.maximum(np.std(x, axis=0), 300.0)
        normalized = (x - self.mean) / self.scale
        self.trend = Ridge(alpha=self.alpha).fit(normalized, y)
        self.x = normalized
        self.residual = y - self.trend.predict(normalized)
        return self

    def predict(self, x: np.ndarray) -> np.ndarray:
        normalized = (x - self.mean) / self.scale
        trend = self.trend.predict(normalized)
        output = []
        for row, base in zip(normalized, trend):
            q = np.sum((self.x - row) ** 2, axis=1)
            indices = np.argsort(q)[: self.k]
            weight = 1.0 / np.maximum(q[indices], self.q_floor) ** self.power
            correction = np.sum(weight * self.residual[indices]) / np.sum(weight)
            output.append(base + correction)
        return np.asarray(output)


class DirectKernelRegressor:
    """Generalized Shepard interpolation used to search beyond the 3-NN baseline."""

    def __init__(self, k: int, q_floor: float, power: float):
        self.k = k
        self.q_floor = q_floor
        self.power = power

    def fit(self, x: np.ndarray, y: np.ndarray) -> "DirectKernelRegressor":
        self.mean = np.mean(x, axis=0)
        self.scale = np.maximum(np.std(x, axis=0), 300.0)
        self.x = (x - self.mean) / self.scale
        self.y = np.asarray(y)
        return self

    def predict(self, x: np.ndarray) -> np.ndarray:
        normalized = (x - self.mean) / self.scale
        output = []
        for row in normalized:
            q = np.sum((self.x - row) ** 2, axis=1)
            indices = np.argsort(q)[: self.k]
            weight = 1.0 / np.maximum(q[indices], self.q_floor) ** self.power
            output.append(np.sum(weight * self.y[indices]) / np.sum(weight))
        return np.asarray(output)


def factories() -> dict[str, Callable[[], Any]]:
    result: dict[str, Callable[[], Any]] = {}
    for alpha in (0.03, 0.1, 0.3, 1.0, 3.0, 10.0, 30.0):
        result[f"ridge_raw_a{alpha:g}"] = lambda a=alpha: make_pipeline(
            StandardScaler(), Ridge(alpha=a)
        )
        result[f"ridge_eng_a{alpha:g}"] = lambda a=alpha: TransformedRegressor(
            engineered_features,
            make_pipeline(StandardScaler(), Ridge(alpha=a)),
        )
        result[f"poly2_a{alpha:g}"] = lambda a=alpha: make_pipeline(
            StandardScaler(),
            PolynomialFeatures(degree=2, include_bias=False),
            Ridge(alpha=a),
        )
    for components in (2, 3, 4):
        result[f"pls_{components}"] = lambda c=components: make_pipeline(
            StandardScaler(), PLSRegression(n_components=c, scale=False)
        )
    for k in (2, 3, 4, 5, 6, 8, 12, 26):
        for power in (0.25, 0.5, 0.75, 1.0, 1.5):
            result[f"kernel_k{k}_p{power:g}"] = (
                lambda kk=k, p=power: DirectKernelRegressor(kk, 0.0004, p)
            )
            for alpha in (0.1, 1.0, 10.0):
                result[f"ridge_resid_a{alpha:g}_k{k}_p{power:g}"] = (
                    lambda a=alpha, kk=k, p=power: ResidualKernelRegressor(
                        a, kk, 0.0004, p
                    )
                )

    # Offline upper bounds. They are measured but marked non-deployable unless
    # a later distillation reproduces their grouped-holdout behaviour.
    result["svr_rbf"] = lambda: make_pipeline(
        StandardScaler(), SVR(C=500.0, epsilon=2.0, gamma="scale")
    )
    result["kernel_rbf"] = lambda: make_pipeline(
        StandardScaler(), KernelRidge(alpha=0.3, kernel="rbf", gamma=0.25)
    )
    result["extra_trees"] = lambda: ExtraTreesRegressor(
        n_estimators=300,
        min_samples_leaf=2,
        max_features=4,
        random_state=20260801,
    )
    result["random_forest"] = lambda: RandomForestRegressor(
        n_estimators=300,
        min_samples_leaf=2,
        max_features=4,
        random_state=20260801,
    )
    result["mlp_8"] = lambda: make_pipeline(
        StandardScaler(),
        MLPRegressor(
            hidden_layer_sizes=(8,),
            alpha=3.0,
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
        default=DEFAULT_MANIFEST.with_name(
            "four_station_20260801_algorithm_search.json"
        ),
    )
    args = parser.parse_args()

    manifest = load_json(args.manifest)
    prototypes = list(manifest["prototypes"])
    prototype_x = np.asarray([row["rangesMm"] for row in prototypes], dtype=float)
    target_distance = np.asarray(
        [row["centerDistanceMm"] for row in prototypes], dtype=float
    )
    target_angle = np.asarray([row["angleDeg"] for row in prototypes], dtype=float)
    capture_by_point: dict[tuple[int, float], list[dict[str, Any]]] = {}
    for capture in manifest["captures"]:
        key = (int(capture["centerDistanceMm"]), float(capture["angleDeg"]))
        capture_by_point.setdefault(key, []).append(capture)
    replay = {
        str(capture["captureId"]): rolling_vectors(args.captures, capture)
        for capture in manifest["captures"]
    }

    model_factories = factories()
    results: list[dict[str, Any]] = []
    for name, factory in model_factories.items():
        point_distance_error: list[float] = []
        point_angle_error: list[float] = []
        window_distance_error: list[float] = []
        window_angle_error: list[float] = []
        point_worst: dict[str, Any] | None = None
        for held_index, held_row in enumerate(prototypes):
            train_mask = np.arange(len(prototypes)) != held_index
            x_train = prototype_x[train_mask]
            distance_model = factory().fit(x_train, target_distance[train_mask])
            angle_model = factory().fit(x_train, target_angle[train_mask])
            point_distance = float(distance_model.predict(prototype_x[[held_index]])[0])
            point_angle = float(angle_model.predict(prototype_x[[held_index]])[0])
            distance_error = abs(point_distance - target_distance[held_index])
            angle_error = abs(point_angle - target_angle[held_index])
            point_distance_error.append(distance_error)
            point_angle_error.append(angle_error)
            if point_worst is None or distance_error > point_worst["distanceErrorMm"]:
                point_worst = {
                    "centerDistanceMm": int(target_distance[held_index]),
                    "angleDeg": float(target_angle[held_index]),
                    "distanceErrorMm": distance_error,
                    "angleErrorDeg": angle_error,
                }
            key = (
                int(held_row["centerDistanceMm"]),
                float(held_row["angleDeg"]),
            )
            vectors = [
                vector
                for capture in capture_by_point[key]
                for vector in replay[str(capture["captureId"])]
            ]
            if vectors:
                test_x = np.asarray([row["rangesMm"] for row in vectors], dtype=float)
                distance_prediction = distance_model.predict(test_x)
                angle_prediction = angle_model.predict(test_x)
                window_distance_error.extend(
                    np.abs(distance_prediction - target_distance[held_index]).tolist()
                )
                window_angle_error.extend(
                    np.abs(angle_prediction - target_angle[held_index]).tolist()
                )
        deployable = not name.startswith(
            ("svr_", "kernel_rbf", "extra_", "random_", "mlp_")
        )
        results.append(
            {
                "id": name,
                "deployableWithoutDistillation": deployable,
                "pointDistance": metrics(np.asarray(point_distance_error)),
                "pointAngle": metrics(np.asarray(point_angle_error)),
                "windowDistance": metrics(np.asarray(window_distance_error)),
                "windowAngle": metrics(np.asarray(window_angle_error)),
                "worstPhysicalPoint": point_worst,
            }
        )
        print(name)

    distance_ranking = sorted(
        results,
        key=lambda row: (
            row["windowDistance"]["p95"],
            row["pointDistance"]["p95"],
            row["windowDistance"]["max"],
        ),
    )
    angle_ranking = sorted(
        results,
        key=lambda row: (
            row["windowAngle"]["mae"],
            row["pointAngle"]["mae"],
            row["windowAngle"]["p95"],
        ),
    )
    output = {
        "modelId": manifest["modelId"],
        "split": "leave-one-physical-point-out; all repeats/windows held together",
        "physicalPointCount": len(prototypes),
        "rollingWindowCount": sum(len(rows) for rows in replay.values()),
        "distanceWinner": distance_ranking[0],
        "angleWinner": angle_ranking[0],
        "bestDeployableDistance": next(
            row for row in distance_ranking if row["deployableWithoutDistillation"]
        ),
        "bestDeployableAngle": next(
            row for row in angle_ranking if row["deployableWithoutDistillation"]
        ),
        "distanceRanking": distance_ranking,
        "angleRanking": angle_ranking,
    }
    args.output.write_text(
        json.dumps(output, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps({
        "output": str(args.output),
        "distanceWinner": output["distanceWinner"],
        "angleWinner": output["angleWinner"],
        "bestDeployableDistance": output["bestDeployableDistance"],
        "bestDeployableAngle": output["bestDeployableAngle"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
