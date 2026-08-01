#!/usr/bin/env python3
"""Validate CR-3040D coordinate, temperature and feed limits in Orca G-code."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
from typing import Any


WORD = re.compile(r"([A-Z])(-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))")
PRINTING_OBJECT = re.compile(
    r"^;\s*printing object\s+(.+?)(?:\s+id:\d+.*)?\s*$",
    re.IGNORECASE,
)
STOP_PRINTING_OBJECT = re.compile(r"^;\s*stop printing object\b", re.IGNORECASE)
PLATE_NUMBER = re.compile(r"plate_(\d+)", re.IGNORECASE)


def load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("extends"):
        from compact_design import load_config_data

        return load_config_data(path)
    return payload


def words(line: str) -> dict[str, float]:
    return {letter: float(value) for letter, value in WORD.findall(line.upper())}


def normalize_object_name(name: str) -> str:
    normalized = name.strip()
    for suffix in (".stl", ".3mf"):
        if normalized.lower().endswith(suffix):
            normalized = normalized[: -len(suffix)]
    return normalized


def positive_intersection(
    first: list[float], second: list[float], tolerance: float = 0.05
) -> tuple[float, float] | None:
    overlap_x = min(first[2], second[2]) - max(first[0], second[0])
    overlap_y = min(first[3], second[3]) - max(first[1], second[1])
    if overlap_x > tolerance and overlap_y > tolerance:
        return overlap_x, overlap_y
    return None


def point_to_bounds_distance(x_value: float, y_value: float, bounds: list[float]) -> float:
    dx = max(float(bounds[0]) - x_value, 0.0, x_value - float(bounds[2]))
    dy = max(float(bounds[1]) - y_value, 0.0, y_value - float(bounds[3]))
    return (dx * dx + dy * dy) ** 0.5


def extend_xy_bounds(
    bounds: list[float],
    start_x: float,
    start_y: float,
    end_x: float,
    end_y: float,
) -> None:
    bounds[0] = min(bounds[0], start_x, end_x)
    bounds[1] = min(bounds[1], start_y, end_y)
    bounds[2] = max(bounds[2], start_x, end_x)
    bounds[3] = max(bounds[3], start_y, end_y)


def validate_file(
    path: Path,
    config: dict[str, Any],
    expected_object_ids: list[str] | None = None,
    expected_object_bounds: dict[str, list[float]] | None = None,
) -> dict[str, Any]:
    printer = config["printer"]
    safe_start = config.get("print_process", {}).get("safe_start", {})
    position = {"X": 0.0, "Y": 0.0, "Z": 0.0}
    extrema = {
        "X": [float("inf"), float("-inf")],
        "Y": [float("inf"), float("-inf")],
        "Z": [float("inf"), float("-inf")],
    }
    absolute = True
    nozzle_targets: set[float] = set()
    bed_targets: set[float] = set()
    maximum_feed_mm_min = 0.0
    maximum_acceleration = 0.0
    errors: list[str] = []
    line_count = 0
    layer_started = False
    layer_markers = 0
    startup_positive_extrusion = 0.0
    first_startup_extrusion_line: int | None = None
    bed_wait_line: int | None = None
    final_nozzle_wait_line: int | None = None
    z_at_bed_wait: float | None = None
    full_nozzle_target_lines: list[int] = []
    extruder_absolute = False
    extruder_position = 0.0
    current_object: str | None = None
    first_layer_bounds: dict[str, list[float]] = {}
    first_layer_segments: dict[str, int] = {}
    first_layer_all_extrusion_bounds = [
        float("inf"),
        float("inf"),
        float("-inf"),
        float("-inf"),
    ]
    expected_bounds_normalized = {
        normalize_object_name(name): [float(value) for value in bounds]
        for name, bounds in (expected_object_bounds or {}).items()
    }
    first_layer_footprint_bounds: dict[str, list[float]] = {}
    first_layer_footprint_segments: dict[str, int] = {}
    unassigned_first_layer_segments = 0
    maximum_unassigned_distance = 0.0

    limits = {
        "X": (float(printer["origin_x"]), float(printer["bed_x"])),
        "Y": (float(printer["origin_y"]), float(printer["bed_y"])),
        "Z": (0.0, float(printer["bed_z"])),
    }
    tolerance = 0.05

    with path.open("r", encoding="utf-8", errors="replace") as stream:
        for line_count, raw_line in enumerate(stream, start=1):
            if raw_line.lstrip().startswith(";LAYER_CHANGE"):
                layer_markers += 1
                layer_started = True
            object_match = PRINTING_OBJECT.match(raw_line.strip())
            if object_match:
                current_object = normalize_object_name(object_match.group(1))
            elif STOP_PRINTING_OBJECT.match(raw_line.strip()):
                current_object = None
            command = raw_line.split(";", 1)[0].strip().upper()
            if not command:
                continue
            opcode = command.split(maxsplit=1)[0]
            values = words(command)
            if opcode == "G90":
                absolute = True
                continue
            if opcode == "G91":
                absolute = False
                continue
            if opcode == "M82":
                extruder_absolute = True
                continue
            if opcode == "M83":
                extruder_absolute = False
                continue
            if opcode == "G28":
                for axis in ("X", "Y", "Z"):
                    if axis in values or not any(candidate in values for candidate in ("X", "Y", "Z")):
                        position[axis] = 0.0
                continue
            if opcode == "G92":
                for axis in ("X", "Y", "Z"):
                    if axis in values:
                        position[axis] = values[axis]
                if "E" in values:
                    extruder_position = values["E"]
                continue
            if opcode in {"G0", "G00", "G1", "G01", "G2", "G02", "G3", "G03"}:
                start_position = dict(position)
                if "F" in values:
                    maximum_feed_mm_min = max(maximum_feed_mm_min, values["F"])
                extrusion_delta = 0.0
                if "E" in values:
                    if extruder_absolute:
                        extrusion_delta = values["E"] - extruder_position
                        extruder_position = values["E"]
                    else:
                        extrusion_delta = values["E"]
                        extruder_position += values["E"]
                if not layer_started and extrusion_delta > 0.0:
                    startup_positive_extrusion += extrusion_delta
                    if first_startup_extrusion_line is None:
                        first_startup_extrusion_line = line_count
                for axis in ("X", "Y", "Z"):
                    if axis not in values:
                        continue
                    position[axis] = values[axis] if absolute else position[axis] + values[axis]
                    extrema[axis][0] = min(extrema[axis][0], position[axis])
                    extrema[axis][1] = max(extrema[axis][1], position[axis])
                    low, high = limits[axis]
                    if position[axis] < low - tolerance or position[axis] > high + tolerance:
                        errors.append(
                            f"line {line_count}: {axis}{position[axis]:.3f} outside {low:g}..{high:g}"
                        )
                first_layer_xy_extrusion = (
                    layer_markers == 1
                    and extrusion_delta > 1e-7
                    and (
                        abs(position["X"] - start_position["X"]) > 1e-7
                        or abs(position["Y"] - start_position["Y"]) > 1e-7
                    )
                )
                if first_layer_xy_extrusion:
                    extend_xy_bounds(
                        first_layer_all_extrusion_bounds,
                        start_position["X"],
                        start_position["Y"],
                        position["X"],
                        position["Y"],
                    )
                    if current_object is not None:
                        bounds = first_layer_bounds.setdefault(
                            current_object,
                            [
                                float("inf"),
                                float("inf"),
                                float("-inf"),
                                float("-inf"),
                            ],
                        )
                        extend_xy_bounds(
                            bounds,
                            start_position["X"],
                            start_position["Y"],
                            position["X"],
                            position["Y"],
                        )
                        first_layer_segments[current_object] = (
                            first_layer_segments.get(current_object, 0) + 1
                        )

                    assigned_object: str | None = None
                    if current_object in expected_bounds_normalized:
                        assigned_object = current_object
                    elif current_object is None and expected_bounds_normalized:
                        midpoint_x = (start_position["X"] + position["X"]) / 2.0
                        midpoint_y = (start_position["Y"] + position["Y"]) / 2.0
                        distances = sorted(
                            (
                                point_to_bounds_distance(midpoint_x, midpoint_y, bounds),
                                name,
                            )
                            for name, bounds in expected_bounds_normalized.items()
                        )
                        nearest_distance, nearest_name = distances[0]
                        assignment_limit = (
                            float(config["print_process"]["brim_width"])
                            + 2.0
                            * float(config["print_process"]["first_layer_line_width"])
                        )
                        if nearest_distance <= assignment_limit + tolerance:
                            assigned_object = nearest_name
                        else:
                            unassigned_first_layer_segments += 1
                            maximum_unassigned_distance = max(
                                maximum_unassigned_distance,
                                nearest_distance,
                            )
                    elif expected_bounds_normalized:
                        unassigned_first_layer_segments += 1

                    if assigned_object is not None:
                        footprint = first_layer_footprint_bounds.setdefault(
                            assigned_object,
                            [
                                float("inf"),
                                float("inf"),
                                float("-inf"),
                                float("-inf"),
                            ],
                        )
                        extend_xy_bounds(
                            footprint,
                            start_position["X"],
                            start_position["Y"],
                            position["X"],
                            position["Y"],
                        )
                        first_layer_footprint_segments[assigned_object] = (
                            first_layer_footprint_segments.get(assigned_object, 0) + 1
                        )
                continue
            if opcode in {"M104", "M109"} and values.get("S", 0.0) > 0.0:
                target = values["S"]
                nozzle_targets.add(target)
                if target == float(printer["nozzle_temperature_initial_layer"]):
                    full_nozzle_target_lines.append(line_count)
                    if opcode == "M109":
                        final_nozzle_wait_line = line_count
            elif opcode in {"M140", "M190"} and values.get("S", 0.0) > 0.0:
                bed_targets.add(values["S"])
                if opcode == "M190":
                    bed_wait_line = line_count
                    z_at_bed_wait = position["Z"]
            elif opcode == "M204":
                maximum_acceleration = max(
                    maximum_acceleration,
                    *(values.get(letter, 0.0) for letter in ("S", "P", "T", "R")),
                )

    maximum_nozzle = max(nozzle_targets, default=0.0)
    maximum_bed = max(bed_targets, default=0.0)
    allowed_nozzle_targets = {
        float(printer["nozzle_temperature"]),
        float(printer["nozzle_temperature_initial_layer"]),
    }
    standby_temperature = safe_start.get("standby_nozzle_temperature")
    if standby_temperature is not None:
        allowed_nozzle_targets.add(float(standby_temperature))
    unexpected_nozzle_targets = nozzle_targets - allowed_nozzle_targets
    if unexpected_nozzle_targets:
        errors.append(f"unexpected nozzle targets: {sorted(unexpected_nozzle_targets)}")
    if float(printer["nozzle_temperature_initial_layer"]) not in nozzle_targets:
        errors.append("initial-layer nozzle target is missing")
    if maximum_nozzle > float(printer["nozzle_temperature_initial_layer"]):
        errors.append(f"nozzle target {maximum_nozzle:g} exceeds configured maximum")
    printing_nozzle_targets = set(nozzle_targets)
    if standby_temperature is not None:
        printing_nozzle_targets.discard(float(standby_temperature))
    material_temperature_min = float(printer["material_print_temperature_min"])
    material_temperature_max = float(printer["material_print_temperature_max"])
    outside_material_temperature_range = sorted(
        target
        for target in printing_nozzle_targets
        if target < material_temperature_min or target > material_temperature_max
    )
    if outside_material_temperature_range:
        errors.append(
            "printing nozzle targets outside material range "
            f"{material_temperature_min:g}..{material_temperature_max:g}: "
            f"{outside_material_temperature_range}"
        )
    expected_bed = float(printer["bed_temperature"])
    expected_initial_bed = float(
        printer.get("bed_temperature_initial_layer", printer["bed_temperature"])
    )
    allowed_bed_targets = {expected_bed, expected_initial_bed}
    unexpected_bed_targets = bed_targets - allowed_bed_targets
    if unexpected_bed_targets:
        errors.append(
            f"unexpected bed targets: {sorted(unexpected_bed_targets)}"
        )
    if expected_initial_bed not in bed_targets:
        errors.append("initial-layer bed target is missing")
    if (
        "first_layer_trial" not in path.name
        and expected_bed != expected_initial_bed
        and expected_bed not in bed_targets
    ):
        errors.append("normal-layer bed target is missing")
    if maximum_bed > max(allowed_bed_targets):
        errors.append(f"bed target {maximum_bed:g} exceeds configured maximum")
    material_bed_temperature_min = float(printer["material_bed_temperature_min"])
    material_bed_temperature_max = float(printer["material_bed_temperature_max"])
    outside_material_bed_range = sorted(
        target
        for target in bed_targets
        if target < material_bed_temperature_min
        or target > material_bed_temperature_max
    )
    if outside_material_bed_range:
        errors.append(
            "bed targets outside material range "
            f"{material_bed_temperature_min:g}..{material_bed_temperature_max:g}: "
            f"{outside_material_bed_range}"
        )
    maximum_feed_allowed = float(printer["maximum_print_speed"]) * 60.0
    if maximum_feed_mm_min > maximum_feed_allowed:
        errors.append(
            f"feed F{maximum_feed_mm_min:g} exceeds configured XY ceiling F{maximum_feed_allowed:g}"
        )
    maximum_acceleration_allowed = max(
        float(printer["maximum_acceleration_extruding"]),
        float(printer["maximum_acceleration_retracting"]),
    )
    if maximum_acceleration > maximum_acceleration_allowed:
        errors.append(
            f"acceleration {maximum_acceleration:g} exceeds configured ceiling {maximum_acceleration_allowed:g}"
        )
    if safe_start:
        standby = float(safe_start["standby_nozzle_temperature"])
        if standby not in nozzle_targets:
            errors.append(f"safe-start standby nozzle target {standby:g} is missing")
        if bed_wait_line is None:
            errors.append("safe-start bed wait M190 is missing")
        if final_nozzle_wait_line is None:
            errors.append("safe-start final nozzle wait M109 is missing")
        if (
            bed_wait_line is not None
            and any(line < bed_wait_line for line in full_nozzle_target_lines)
        ):
            errors.append("full nozzle temperature is commanded before the bed wait completes")
        if (
            bed_wait_line is not None
            and final_nozzle_wait_line is not None
            and bed_wait_line >= final_nozzle_wait_line
        ):
            errors.append("final nozzle wait must occur after the bed wait")
        park_z = float(safe_start["park_z"])
        if z_at_bed_wait is None or z_at_bed_wait < park_z - tolerance:
            errors.append(
                f"nozzle Z at bed wait is {z_at_bed_wait}, expected at least {park_z:g}"
            )
        if (
            final_nozzle_wait_line is not None
            and first_startup_extrusion_line is not None
            and first_startup_extrusion_line <= final_nozzle_wait_line
        ):
            errors.append("startup extrusion occurs before the final nozzle wait")
        maximum_startup_extrusion = float(safe_start["maximum_startup_extrusion"])
        if startup_positive_extrusion > maximum_startup_extrusion + tolerance:
            errors.append(
                "startup extrusion "
                f"{startup_positive_extrusion:g} exceeds configured maximum "
                f"{maximum_startup_extrusion:g}"
            )

    clean_object_bounds = {
        name: [round(value, 3) for value in bounds]
        for name, bounds in sorted(first_layer_bounds.items())
    }
    clean_all_extrusion_bounds = (
        None
        if first_layer_all_extrusion_bounds[0] == float("inf")
        else [round(value, 3) for value in first_layer_all_extrusion_bounds]
    )
    if clean_all_extrusion_bounds is None:
        errors.append("no first-layer extrusion path was found")
    else:
        bed_margin = float(printer.get("bed_edge_margin", 0.0))
        extrusion_limits = {
            "X": (
                float(printer["origin_x"]) + bed_margin,
                float(printer["bed_x"]) - bed_margin,
            ),
            "Y": (
                float(printer["origin_y"]) + bed_margin,
                float(printer["bed_y"]) - bed_margin,
            ),
        }
        for axis, indices in (("X", (0, 2)), ("Y", (1, 3))):
            low, high = extrusion_limits[axis]
            actual_low = clean_all_extrusion_bounds[indices[0]]
            actual_high = clean_all_extrusion_bounds[indices[1]]
            if actual_low < low - tolerance or actual_high > high + tolerance:
                errors.append(
                    f"first-layer extrusion {axis} bounds "
                    f"{actual_low:g}..{actual_high:g} violate configured "
                    f"bed-edge margin {low:g}..{high:g}"
                )

    clean_footprint_bounds = {
        name: [round(value, 3) for value in bounds]
        for name, bounds in sorted(first_layer_footprint_bounds.items())
    }
    footprint_overlaps: list[dict[str, Any]] = []
    footprint_names = sorted(clean_footprint_bounds)
    for index, first_name in enumerate(footprint_names):
        for second_name in footprint_names[index + 1 :]:
            intersection = positive_intersection(
                clean_footprint_bounds[first_name],
                clean_footprint_bounds[second_name],
            )
            if intersection is None:
                continue
            footprint_overlaps.append(
                {
                    "first": first_name,
                    "second": second_name,
                    "overlap_mm": [
                        round(intersection[0], 3),
                        round(intersection[1], 3),
                    ],
                }
            )
    if footprint_overlaps:
        errors.append(
            "first-layer footprints including brim overlap: "
            + json.dumps(footprint_overlaps, ensure_ascii=False)
        )
    if unassigned_first_layer_segments:
        errors.append(
            "unassigned first-layer extrusion segments: "
            f"{unassigned_first_layer_segments}; maximum distance from an "
            f"expected model bound = {maximum_unassigned_distance:.3f} mm"
        )

    first_layer_overlaps: list[dict[str, Any]] = []
    object_names = sorted(clean_object_bounds)
    for index, first_name in enumerate(object_names):
        for second_name in object_names[index + 1 :]:
            intersection = positive_intersection(
                clean_object_bounds[first_name],
                clean_object_bounds[second_name],
            )
            if intersection is None:
                continue
            first_layer_overlaps.append(
                {
                    "first": first_name,
                    "second": second_name,
                    "overlap_mm": [
                        round(intersection[0], 3),
                        round(intersection[1], 3),
                    ],
                }
            )
    if first_layer_overlaps:
        errors.append(
            "first-layer object extrusion bounds overlap: "
            + json.dumps(first_layer_overlaps, ensure_ascii=False)
        )

    expected_normalized = (
        sorted(normalize_object_name(name) for name in expected_object_ids)
        if expected_object_ids is not None
        else None
    )
    if expected_normalized is not None:
        actual_normalized = sorted(clean_object_bounds)
        missing = sorted(set(expected_normalized) - set(actual_normalized))
        unexpected = sorted(set(actual_normalized) - set(expected_normalized))
        if missing:
            errors.append(f"first-layer objects missing from G-code: {missing}")
        if unexpected:
            errors.append(f"unexpected first-layer objects in G-code: {unexpected}")
        if len(actual_normalized) != len(expected_normalized):
            errors.append(
                "first-layer object count "
                f"{len(actual_normalized)} does not equal expected "
                f"{len(expected_normalized)}"
            )
        if expected_bounds_normalized:
            missing_footprints = sorted(
                set(expected_normalized) - set(clean_footprint_bounds)
            )
            if missing_footprints:
                errors.append(
                    "first-layer footprints missing from G-code: "
                    f"{missing_footprints}"
                )
    elif not clean_object_bounds:
        errors.append("no named first-layer object extrusion paths were found")

    clean_extrema = {
        axis: [None, None] if values_[0] == float("inf") else [round(value, 3) for value in values_]
        for axis, values_ in extrema.items()
    }
    return {
        "file": str(path),
        "line_count": line_count,
        "coordinate_extrema_mm": clean_extrema,
        "nozzle_targets_c": sorted(nozzle_targets),
        "printing_nozzle_targets_c": sorted(printing_nozzle_targets),
        "material_print_temperature_range_c": [
            material_temperature_min,
            material_temperature_max,
        ],
        "bed_targets_c": sorted(bed_targets),
        "material_bed_temperature_range_c": [
            material_bed_temperature_min,
            material_bed_temperature_max,
        ],
        "maximum_feed_mm_min": maximum_feed_mm_min,
        "maximum_acceleration_mm_s2": maximum_acceleration,
        "safe_start": {
            "bed_wait_line": bed_wait_line,
            "final_nozzle_wait_line": final_nozzle_wait_line,
            "z_at_bed_wait_mm": z_at_bed_wait,
            "startup_positive_extrusion_mm": round(startup_positive_extrusion, 3),
        },
        "first_layer": {
            "expected_object_ids": expected_normalized,
            "object_count": len(clean_object_bounds),
            "object_bounds_mm": clean_object_bounds,
            "extrusion_segment_counts": {
                name: first_layer_segments[name] for name in sorted(first_layer_segments)
            },
            "overlaps": first_layer_overlaps,
            "non_overlapping": not first_layer_overlaps,
            "all_extrusion_bounds_mm": clean_all_extrusion_bounds,
            "footprint_bounds_including_brim_mm": clean_footprint_bounds,
            "footprint_segment_counts": {
                name: first_layer_footprint_segments[name]
                for name in sorted(first_layer_footprint_segments)
            },
            "footprint_overlaps_including_brim": footprint_overlaps,
            "footprints_non_overlapping_including_brim": not footprint_overlaps,
            "unassigned_extrusion_segments": unassigned_first_layer_segments,
        },
        "errors": errors,
        "passed": not errors,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--gcode-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--manifest",
        type=Path,
        help="Deterministic print manifest used to verify per-plate object names.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config = load_json(args.config)
    expected_by_plate: dict[int, dict[str, list[float]]] = {}
    if args.manifest:
        manifest = load_json(args.manifest)
        for plate in manifest.get("deterministic_plates", []):
            expected_by_plate[int(plate["plate"])] = {
                str(item["id"]): [float(value) for value in item["bounds_mm"]]
                for item in plate["items"]
            }
    paths = sorted(args.gcode_dir.glob("*.gcode"))
    if not paths:
        raise FileNotFoundError(f"no G-code files found in {args.gcode_dir}")
    results: list[dict[str, Any]] = []
    for path in paths:
        plate_match = PLATE_NUMBER.search(path.stem)
        expected_bounds = (
            expected_by_plate.get(int(plate_match.group(1)))
            if plate_match
            else None
        )
        expected_ids = list(expected_bounds) if expected_bounds is not None else None
        results.append(
            validate_file(path, config, expected_ids, expected_bounds)
        )
    report = {
        "printer": config["printer"]["model"],
        "material": config["printer"]["material"],
        "manifest": str(args.manifest) if args.manifest else None,
        "files": len(results),
        "passed": all(result["passed"] for result in results),
        "failed_files": [result["file"] for result in results if not result["passed"]],
        "results": results,
    }
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": report["passed"], "files": len(results)}, ensure_ascii=False))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
