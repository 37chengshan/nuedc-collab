#!/usr/bin/env python3
"""Prepare measured four-station inputs for the MATLAB Monte Carlo simulation.

The generated MAT file contains:

- the 27 frozen physical-point prototypes;
- the exact deployed distance scales and ridge-angle coefficients;
- residual vectors from every real 0.8 s rolling window, measured relative to
  the prototype at the same physical point.

MATLAB uses these data to build a continuous forward measurement field and to
inject correlated, measured noise into simulated trajectories.  This script
does not generate any performance result by itself.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from scipy.io import savemat

from build_four_station_model import fit_angle_linear
from evaluate_four_station_model import DEFAULT_CAPTURES, point_key, rolling_vectors


SCRIPT_PATH = Path(__file__).resolve()
PROJECT_ROOT = SCRIPT_PATH.parents[3]
MODULE_DIR = SCRIPT_PATH.parents[1]
DEFAULT_MANIFEST = MODULE_DIR / "calibration" / "four_station_20260801.json"
DEFAULT_OUTPUT = (
    PROJECT_ROOT
    / "比赛设计"
    / "总体方案"
    / "仿真图"
    / "四站190mm_20260801"
    / "matlab_simulation_input.mat"
)

# Report geometry fixed by the current four-station design.
REPORT_STATION_XY_MM = np.asarray(
    [
        [95.0, 0.0],
        [-95.0, 0.0],
        [0.0, 70.0],
        [0.0, -75.0],
    ],
    dtype=np.float64,
)


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser(
        description="导出四站 MATLAB 动态/Monte Carlo 仿真的实测输入"
    )
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--captures", type=Path, default=DEFAULT_CAPTURES)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    manifest = load_json(args.manifest)
    prototypes = list(manifest["prototypes"])
    prototype_by_point = {
        point_key(row): np.asarray(row["rangesMm"], dtype=np.float64)
        for row in prototypes
    }

    residual_rows: list[np.ndarray] = []
    residual_capture_index: list[int] = []
    residual_timestamp_ms: list[int] = []
    residual_center_mm: list[float] = []
    residual_angle_deg: list[float] = []
    for capture_index, capture in enumerate(manifest["captures"]):
        baseline = prototype_by_point[point_key(capture)]
        for vector in rolling_vectors(args.captures, capture):
            residual_rows.append(
                np.asarray(vector["rangesMm"], dtype=np.float64) - baseline
            )
            residual_capture_index.append(capture_index + 1)
            residual_timestamp_ms.append(int(vector["nowMs"]))
            residual_center_mm.append(float(capture["centerDistanceMm"]))
            residual_angle_deg.append(float(capture["angleDeg"]))

    angle_model = fit_angle_linear(prototypes)
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    savemat(
        output,
        {
            "prototype_center_mm": np.asarray(
                [row["centerDistanceMm"] for row in prototypes],
                dtype=np.float64,
            ).reshape(-1, 1),
            "prototype_boundary_mm": np.asarray(
                [row["boundaryDistanceMm"] for row in prototypes],
                dtype=np.float64,
            ).reshape(-1, 1),
            "prototype_angle_deg": np.asarray(
                [row["angleDeg"] for row in prototypes],
                dtype=np.float64,
            ).reshape(-1, 1),
            "prototype_ranges_mm": np.asarray(
                [row["rangesMm"] for row in prototypes],
                dtype=np.float64,
            ),
            "noise_residuals_mm": np.asarray(residual_rows, dtype=np.float64),
            "noise_capture_index": np.asarray(
                residual_capture_index, dtype=np.int32
            ).reshape(-1, 1),
            "noise_timestamp_ms": np.asarray(
                residual_timestamp_ms, dtype=np.int64
            ).reshape(-1, 1),
            "noise_center_mm": np.asarray(
                residual_center_mm, dtype=np.float64
            ).reshape(-1, 1),
            "noise_angle_deg": np.asarray(
                residual_angle_deg, dtype=np.float64
            ).reshape(-1, 1),
            "distance_scale_mm": np.asarray(
                manifest["runtime"]["scaleMm"], dtype=np.float64
            ).reshape(1, -1),
            "angle_mean_mm": np.asarray(
                angle_model["meanMm"], dtype=np.float64
            ).reshape(1, -1),
            "angle_scale_mm": np.asarray(
                [angle_model["scaleMm"]], dtype=np.float64
            ),
            "angle_coefficients": np.asarray(
                angle_model["coefficients"], dtype=np.float64
            ).reshape(1, -1),
            "station_xy_mm": REPORT_STATION_XY_MM,
            "q_floor": np.asarray(
                [manifest["runtime"]["qFloor"]], dtype=np.float64
            ),
            "neighbor_count": np.asarray(
                [manifest["runtime"]["neighborCount"]], dtype=np.int32
            ),
            "minimum_center_mm": np.asarray(
                [manifest["runtime"]["minimumDistanceMm"]], dtype=np.float64
            ),
            "maximum_center_mm": np.asarray(
                [manifest["runtime"]["maximumDistanceMm"]], dtype=np.float64
            ),
            "source_model_id": np.asarray([manifest["modelId"]], dtype=object),
            "source_capture_count": np.asarray(
                [len(manifest["captures"])], dtype=np.int32
            ),
            "source_physical_point_count": np.asarray(
                [len(prototypes)], dtype=np.int32
            ),
        },
        do_compression=True,
    )
    print(
        json.dumps(
            {
                "output": str(output),
                "physicalPointCount": len(prototypes),
                "rollingResidualCount": len(residual_rows),
                "residualStdMm": np.std(
                    np.asarray(residual_rows, dtype=np.float64), axis=0
                ).tolist(),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
