#!/usr/bin/env python3
"""Generate and validate the v0.5 three-piece split lock as exactly three STL files."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from compact_design import load_compact_config
from generate_compact_models import (
    build_lock_body_front,
    build_lock_body_rear,
    build_lock_top_cover,
)
from meshlib import Mesh, edge_count_validation, export_binary_stl, load_binary_stl


ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG = ROOT / "parameters_v0_5.json"
OUTPUT_FILENAMES = {
    "门锁主体_前半.stl": build_lock_body_front,
    "门锁主体_后半.stl": build_lock_body_rear,
    "门锁上盖.stl": build_lock_top_cover,
}
MAX_PART_DIMENSION_MM = 240.0
DIMENSION_TOLERANCE_MM = 0.001


def validate_mesh(mesh: Mesh) -> dict[str, Any]:
    validation = edge_count_validation(mesh)
    if validation["degenerate_triangles"]:
        raise RuntimeError(f"{mesh.name}: contains degenerate triangles")
    if not validation["watertight_by_edges"]:
        raise RuntimeError(f"{mesh.name}: mesh is not watertight")
    if max(float(value) for value in validation["dimensions_mm"]) > MAX_PART_DIMENSION_MM:
        raise RuntimeError(f"{mesh.name}: exceeds the 240 mm part limit")
    return validation


def dimensions_match(first: list[float], second: list[float]) -> bool:
    return all(
        abs(float(left) - float(right)) <= DIMENSION_TOLERANCE_MM
        for left, right in zip(first, second)
    )


def build_models(config: dict[str, Any]) -> dict[str, Mesh]:
    if str(config["revision"]) != "0.5":
        raise ValueError("the split-lock exporter requires a v0.5 configuration")
    return {
        filename: builder(config).centered_for_print(Path(filename).stem)
        for filename, builder in OUTPUT_FILENAMES.items()
    }


def generate(config: dict[str, Any], output: Path) -> dict[str, Any]:
    output.mkdir(parents=True, exist_ok=True)
    for path in output.glob("*.stl"):
        path.unlink()

    generated: dict[str, Any] = {}
    for filename, mesh in build_models(config).items():
        validation = validate_mesh(mesh)
        path = output / filename
        export_binary_stl(mesh, path)
        reloaded = validate_mesh(load_binary_stl(path, mesh.name))
        if not dimensions_match(
            validation["dimensions_mm"],
            reloaded["dimensions_mm"],
        ):
            raise RuntimeError(f"{filename}: reloaded dimensions differ from source mesh")
        generated[filename] = {
            "dimensions_mm": validation["dimensions_mm"],
            "vertices": validation["vertices"],
            "triangles": validation["triangles"],
            "watertight": validation["watertight_by_edges"],
        }

    actual_files = {path.name for path in output.glob("*.stl")}
    if actual_files != set(OUTPUT_FILENAMES):
        raise RuntimeError("split-lock output must contain exactly the three requested STL files")
    return {"files": generated, "output": str(output)}


def validate_existing(output: Path) -> dict[str, Any]:
    actual_files = {path.name for path in output.glob("*.stl")}
    if actual_files != set(OUTPUT_FILENAMES):
        raise RuntimeError("split-lock output must contain exactly the three requested STL files")
    results = {
        filename: validate_mesh(load_binary_stl(output / filename))
        for filename in OUTPUT_FILENAMES
    }
    return {"files": results, "output": str(output)}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--validate-only", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config = load_compact_config(args.config)
    result = (
        validate_existing(args.output)
        if args.validate_only
        else generate(config, args.output)
    )
    print(json.dumps({"ok": True, **result}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
