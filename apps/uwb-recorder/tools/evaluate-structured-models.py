#!/usr/bin/env python3
"""Evaluate small deployable models against the 2026-07-31 UWB dataset."""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime
from pathlib import Path

import numpy as np


CAPTURES_DIR = Path(__file__).resolve().parents[1] / "data" / "captures"
LABEL_RE = re.compile(
    r"^(line|angle|valid)_r(?P<radius>\d+(?:\.\d+)?)cm_"
    r"a(?P<sign>[mp])(?P<angle>\d+(?:\.\d+)?)_rep\d+$",
    re.IGNORECASE,
)
EXPLICIT_RE = re.compile(
    r"R(?P<radius>\d+(?:\.\d+)?)\s*-\s*A(?P<angle>[+-]?\d+(?:\.\d+)?)",
    re.IGNORECASE,
)
CENTERLINE_RE = re.compile(r"中轴\s*(?P<distance>\d+(?:\.\d+)?)", re.IGNORECASE)
DISTANCE_ONLY_RE = re.compile(
    r"^d[1-4]\s+(?P<distance>\d+(?:\.\d+)?)",
    re.IGNORECASE,
)


def parse_label(label: str) -> dict | None:
    text = label.strip().replace("。", ".")
    match = LABEL_RE.match(text)
    if match:
        angle = float(match.group("angle"))
        if match.group("sign").lower() == "m":
            angle = -angle
        kind = match.group(1).lower()
        return {
            "distance_m": float(match.group("radius")) / 100.0,
            "angle_deg": angle,
            "split": "validation" if kind == "valid" else "train",
            "source_dataset": "2026-07-31-grid",
        }
    explicit = EXPLICIT_RE.search(text)
    if explicit:
        return {
            "distance_m": float(explicit.group("radius")) / 100.0,
            "angle_deg": float(explicit.group("angle")),
            "split": "train",
            "source_dataset": "legacy",
        }
    centerline = CENTERLINE_RE.search(text)
    if centerline:
        return {
            "distance_m": float(centerline.group("distance")),
            "angle_deg": 0.0,
            "split": "train",
            "source_dataset": "legacy",
        }
    distance_only = DISTANCE_ONLY_RE.search(text)
    if distance_only:
        return {
            "distance_m": float(distance_only.group("distance")),
            "angle_deg": None,
            "split": "train",
            "source_dataset": "legacy",
        }
    return None


def median(values: list[float]) -> float:
    return float(np.median(np.asarray(values, dtype=float)))


def timestamp_ms(value: str) -> int:
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


def load_rows() -> list[dict]:
    candidates: dict[str, dict] = {}
    for meta_path in sorted(CAPTURES_DIR.glob("*.meta.json")):
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        target = parse_label(str(meta.get("label", "")))
        if target is None:
            continue
        previous = candidates.get(meta["label"])
        if previous is None or meta["startedAt"] > previous["meta"]["startedAt"]:
            candidates[meta["label"]] = {"meta": meta, "target": target}

    rows = []
    for selected in sorted(
        candidates.values(), key=lambda item: item["meta"]["startedAt"]
    ):
        meta = selected["meta"]
        started_ms = timestamp_ms(meta["startedAt"])
        warmup_end_ms = started_ms + 2000
        distances: dict[int, list[float]] = {}
        snr_values: dict[int, list[float]] = {}
        for line in (CAPTURES_DIR / f"{meta['id']}.jsonl").read_text(
            encoding="utf-8"
        ).splitlines():
            if not line:
                continue
            frame = json.loads(line)
            frame_timestamp_ms = timestamp_ms(frame["timestamp"])
            if frame_timestamp_ms < warmup_end_ms:
                continue
            device = int(frame.get("device", frame.get("deviceId", 0)))
            distance_mm = frame.get("distanceMm")
            if distance_mm is None:
                distance_mm = float(frame["distanceCm"]) * 10.0
            distances.setdefault(device, []).append(float(distance_mm))
            if frame.get("snrDb") is not None:
                snr_values.setdefault(device, []).append(float(frame["snrDb"]))
        if 1 not in distances or 2 not in distances:
            continue
        target = selected["target"]
        rows.append(
            {
                "capture_id": meta["id"],
                "label": meta["label"],
                "split": target["split"],
                "source_dataset": target["source_dataset"],
                "distance_m": target["distance_m"],
                "angle_deg": target["angle_deg"],
                "d1_mm": median(distances[1]),
                "d2_mm": median(distances[2]),
                "snr1_db": median(snr_values.get(1, [0.0])),
                "snr2_db": median(snr_values.get(2, [0.0])),
            }
        )
    return rows


def feature_matrix(rows: list[dict], kind: str) -> np.ndarray:
    d1 = np.asarray([row["d1_mm"] for row in rows], dtype=float) / 1000.0
    d2 = np.asarray([row["d2_mm"] for row in rows], dtype=float) / 1000.0
    mean = (d1 + d2) / 2.0
    diff = d1 - d2
    if kind == "linear":
        return np.column_stack([np.ones(len(rows)), d1, d2])
    if kind == "quadratic":
        return np.column_stack(
            [np.ones(len(rows)), d1, d2, d1 * d1, d1 * d2, d2 * d2]
        )
    if kind == "mean-diff-quadratic":
        return np.column_stack(
            [
                np.ones(len(rows)),
                mean,
                diff,
                mean * mean,
                mean * diff,
                diff * diff,
            ]
        )
    raise ValueError(kind)


def fit_ridge(x: np.ndarray, y: np.ndarray, ridge: float) -> np.ndarray:
    penalty = np.eye(x.shape[1], dtype=float) * ridge
    penalty[0, 0] = 0.0
    return np.linalg.solve(x.T @ x + penalty, x.T @ y)


def grouped_folds(rows: list[dict]) -> list[tuple[np.ndarray, np.ndarray]]:
    groups: dict[tuple[float, float], list[int]] = {}
    for index, row in enumerate(rows):
        key = (row["distance_m"], row["angle_deg"])
        groups.setdefault(key, []).append(index)
    all_indices = np.arange(len(rows))
    folds = []
    for indices in groups.values():
        validation = np.asarray(indices, dtype=int)
        training = np.setdiff1d(all_indices, validation)
        folds.append((training, validation))
    return folds


def evaluate_regression(
    train_rows: list[dict],
    validation_rows: list[dict],
    target: str,
    feature_kind: str,
    ridge: float,
) -> dict:
    y = np.asarray([row[target] for row in train_rows], dtype=float)
    x = feature_matrix(train_rows, feature_kind)
    cv_predictions = np.zeros(len(train_rows), dtype=float)
    for training, validation in grouped_folds(train_rows):
        coefficients = fit_ridge(x[training], y[training], ridge)
        cv_predictions[validation] = x[validation] @ coefficients
    coefficients = fit_ridge(x, y, ridge)
    validation_predictions = (
        feature_matrix(validation_rows, feature_kind) @ coefficients
        if validation_rows
        else np.asarray([])
    )
    cv_errors = np.abs(cv_predictions - y)
    validation_y = np.asarray([row[target] for row in validation_rows], dtype=float)
    validation_errors = np.abs(validation_predictions - validation_y)
    return {
        "type": f"ridge-{feature_kind}",
        "ridge": ridge,
        "cv_max": float(np.max(cv_errors)),
        "cv_p95": float(np.quantile(cv_errors, 0.95)),
        "validation_max": (
            float(np.max(validation_errors)) if len(validation_errors) else None
        ),
        "validation_errors": validation_errors.tolist(),
        "validation_predictions": validation_predictions.tolist(),
        "coefficients": coefficients.tolist(),
    }


def evaluate_knn(
    train_rows: list[dict],
    validation_rows: list[dict],
    target: str,
    neighbors: int,
    include_snr: bool,
) -> dict:
    feature_keys = ["d1_mm", "d2_mm"]
    minimum_scales = [50.0, 50.0]
    if include_snr:
        feature_keys.extend(["snr1_db", "snr2_db"])
        minimum_scales.extend([1.0, 1.0])
    train_features = np.asarray(
        [[row[key] for key in feature_keys] for row in train_rows], dtype=float
    )
    center = np.median(train_features, axis=0)
    scale = np.maximum(
        np.asarray(minimum_scales, dtype=float),
        1.4826 * np.median(np.abs(train_features - center), axis=0),
    )
    normalized = train_features / scale
    targets = np.asarray([row[target] for row in train_rows], dtype=float)

    def predict(features: np.ndarray, excluded: int | None = None) -> float:
        distances = np.linalg.norm(normalized - features / scale, axis=1)
        if excluded is not None:
            distances[excluded] = np.inf
        selected = np.argsort(distances)[:neighbors]
        weights = 1.0 / np.maximum(0.02, distances[selected]) ** 2
        return float(np.sum(targets[selected] * weights) / np.sum(weights))

    cv_predictions = np.asarray(
        [predict(train_features[index], excluded=index) for index in range(len(train_rows))]
    )
    validation_predictions = np.asarray(
        [
            predict(np.asarray([row[key] for key in feature_keys], dtype=float))
            for row in validation_rows
        ]
    )
    cv_errors = np.abs(cv_predictions - targets)
    validation_targets = np.asarray(
        [row[target] for row in validation_rows], dtype=float
    )
    validation_errors = np.abs(validation_predictions - validation_targets)
    return {
        "type": f"knn-{neighbors}{'-snr' if include_snr else ''}",
        "cv_max": float(np.max(cv_errors)),
        "cv_p95": float(np.quantile(cv_errors, 0.95)),
        "validation_max": (
            float(np.max(validation_errors)) if len(validation_errors) else None
        ),
        "validation_errors": validation_errors.tolist(),
        "validation_predictions": validation_predictions.tolist(),
        "feature_keys": feature_keys,
        "feature_scales": scale.tolist(),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--summary",
        action="store_true",
        help="Only print the best candidates for each target.",
    )
    args = parser.parse_args()
    rows = load_rows()
    train_rows = [row for row in rows if row["split"] == "train"]
    validation_rows = [row for row in rows if row["split"] == "validation"]
    candidates = []
    for target in ("distance_m", "angle_deg"):
        target_train_rows = [
            row for row in train_rows if row[target] is not None
        ]
        target_validation_rows = [
            row for row in validation_rows if row[target] is not None
        ]
        for feature_kind in ("linear", "quadratic", "mean-diff-quadratic"):
            for ridge in (0.0, 0.001, 0.01, 0.1):
                try:
                    result = evaluate_regression(
                        target_train_rows,
                        target_validation_rows,
                        target,
                        feature_kind,
                        ridge,
                    )
                except np.linalg.LinAlgError:
                    continue
                result["target"] = target
                candidates.append(result)
        for neighbors in (1, 2, 3, 4, 6):
            for include_snr in (False, True):
                result = evaluate_knn(
                    target_train_rows,
                    target_validation_rows,
                    target,
                    neighbors,
                    include_snr,
                )
                result["target"] = target
                candidates.append(result)

    sorted_candidates = sorted(
        candidates,
        key=lambda item: (
            item["target"],
            item["validation_max"]
            if item["validation_max"] is not None
            else float("inf"),
            item["cv_p95"],
        ),
    )
    if args.summary:
        sorted_candidates = [
            *[item for item in sorted_candidates if item["target"] == "distance_m"][
                :5
            ],
            *[item for item in sorted_candidates if item["target"] == "angle_deg"][
                :5
            ],
        ]
    output = {
        "training_points": len(train_rows),
        "structured_training_points": sum(
            row["source_dataset"] == "2026-07-31-grid" for row in train_rows
        ),
        "legacy_training_points": sum(
            row["source_dataset"] == "legacy" for row in train_rows
        ),
        "validation_points": len(validation_rows),
        "validation_rows": validation_rows,
        "candidates": sorted_candidates,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
