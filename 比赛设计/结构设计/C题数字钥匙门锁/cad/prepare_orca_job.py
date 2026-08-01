#!/usr/bin/env python3
"""Prepare reproducible CR-3040D/PETG OrcaSlicer profiles and print plates."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
from typing import Any
import xml.etree.ElementTree as ET
import zipfile

import numpy as np

from meshlib import load_binary_stl


DEFAULT_ORCA = Path("/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer")
DEFAULT_ORCA_DATA = Path.home() / "Library/Application Support/OrcaSlicer"
DEFAULT_MACHINE = (
    DEFAULT_ORCA_DATA / "user/default/machine/base/cr CR-3040d 0.4 nozzle.json"
)
DEFAULT_PROCESS = (
    DEFAULT_ORCA_DATA
    / "user/default/process/base/process template @cr CR-3040d 0.4 nozzle.json"
)
DEFAULT_FILAMENT = (
    DEFAULT_ORCA_DATA
    / "user/default/filament/base/Generic PET template @cr CR-3040d 0.4 nozzle.json"
)


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def repeated(value: str, existing: Any) -> list[str]:
    count = len(existing) if isinstance(existing, list) and existing else 1
    return [value] * count


def safe_machine_start_gcode(config: dict[str, Any]) -> str:
    """Return a PETG startup with parallel bed/nozzle preheating."""

    safe = config["print_process"]["safe_start"]
    standby = float(safe["standby_nozzle_temperature"])
    park_z = float(safe["park_z"])
    start_x = float(safe["purge_start_x"])
    end_x = float(safe["purge_end_x"])
    purge_y = float(safe["purge_y"])
    spacing_y = float(safe["purge_spacing_y"])
    purge_z = float(safe["purge_z"])
    extrusion = float(safe["purge_extrusion_per_line"])
    return "\n".join(
        (
            "G90 ; use absolute coordinates",
            "M83 ; extruder relative mode",
            "M220 S100 ; reset feed rate",
            "M221 S100 ; reset flow rate",
            "M204 S[machine_max_acceleration_extruding] "
            "T[machine_max_acceleration_retracting]",
            "M140 S[first_layer_bed_temperature] ; start heating bed",
            f"M104 S{standby:g} ; preheat PETG nozzle while the bed heats",
            "G28 ; home all",
            f"G1 Z{park_z:g} F1200 ; keep hot nozzle clear of the bed",
            f"G1 X{start_x:g} Y{purge_y:g} F6000 ; move above purge start",
            "M190 S[first_layer_bed_temperature] ; wait for bed",
            "M109 S[first_layer_temperature] ; finish heating nozzle after bed is ready",
            "M107 ; keep part cooling off for the first layers",
            "G92 E0",
            f"G1 Z{purge_z:g} F1200",
            f"G1 X{end_x:g} E{extrusion:g} F900 ; purge line 1",
            f"G1 Y{purge_y + spacing_y:g} F3000",
            f"G1 X{start_x:g} E{extrusion:g} F900 ; purge line 2",
            "G92 E0",
            "G1 Z1 F1200 ; lift before travelling to the print",
        )
    )


def build_profiles(
    config: dict[str, Any],
    base_machine: dict[str, Any],
    base_process: dict[str, Any],
    base_filament: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    printer = config["printer"]
    print_process = config["print_process"]
    # OrcaSlicer 2.4.2 CLI only accepts presets registered in its system bundle.
    # Keep these three registered compatibility identities while overriding every
    # machine/process/material value below with the confirmed CR-3040D baseline.
    machine_name = "MyToolChanger 0.4 nozzle"
    process_name = "0.20mm Standard @MyToolChanger"
    filament_name = "Generic PETG @MyToolChanger"

    machine = dict(base_machine)
    machine.update(
        {
            "name": machine_name,
            "type": "machine",
            "setting_id": "tJ98aJdTqDwMfyZd",
            "printer_settings_id": machine_name,
            "printer_model": printer["model"],
            "printer_variant": str(printer["nozzle"]),
            "printable_area": [
                "0x0",
                f"{printer['bed_x']:g}x0",
                f"{printer['bed_x']:g}x{printer['bed_y']:g}",
                f"0x{printer['bed_y']:g}",
            ],
            "printable_height": f"{printer['bed_z']:g}",
            "nozzle_diameter": repeated(f"{printer['nozzle']:g}", machine.get("nozzle_diameter")),
            "machine_max_speed_x": repeated(
                f"{printer['maximum_print_speed']:g}", machine.get("machine_max_speed_x")
            ),
            "machine_max_speed_y": repeated(
                f"{printer['maximum_print_speed']:g}", machine.get("machine_max_speed_y")
            ),
            "machine_max_speed_z": repeated(
                f"{printer['maximum_speed_z']:g}", machine.get("machine_max_speed_z")
            ),
            "machine_max_speed_e": repeated(
                f"{printer['maximum_speed_e']:g}", machine.get("machine_max_speed_e")
            ),
            "machine_max_acceleration_x": repeated(
                f"{printer['maximum_acceleration_x']:g}", machine.get("machine_max_acceleration_x")
            ),
            "machine_max_acceleration_y": repeated(
                f"{printer['maximum_acceleration_y']:g}", machine.get("machine_max_acceleration_y")
            ),
            "machine_max_acceleration_z": repeated(
                f"{printer['maximum_acceleration_z']:g}", machine.get("machine_max_acceleration_z")
            ),
            "machine_max_acceleration_e": repeated(
                f"{printer['maximum_acceleration_e']:g}", machine.get("machine_max_acceleration_e")
            ),
            "machine_max_acceleration_extruding": repeated(
                f"{printer['maximum_acceleration_extruding']:g}",
                machine.get("machine_max_acceleration_extruding"),
            ),
            "machine_max_acceleration_retracting": repeated(
                f"{printer['maximum_acceleration_retracting']:g}",
                machine.get("machine_max_acceleration_retracting"),
            ),
            "machine_max_jerk_x": repeated(
                f"{printer['maximum_jerk_x']:g}", machine.get("machine_max_jerk_x")
            ),
            "machine_max_jerk_y": repeated(
                f"{printer['maximum_jerk_y']:g}", machine.get("machine_max_jerk_y")
            ),
            "machine_max_jerk_z": repeated(
                f"{printer['maximum_jerk_z']:g}", machine.get("machine_max_jerk_z")
            ),
            "machine_max_jerk_e": repeated(
                f"{printer['maximum_jerk_e']:g}", machine.get("machine_max_jerk_e")
            ),
            "inherits": "fdm_toolchanger_common",
            "from": "system",
            "printer_notes": "CR-3040D 单色 PETG CLI 切片兼容封装；实际参数以本文件字段为准。",
            "machine_start_gcode": safe_machine_start_gcode(config),
        }
    )
    machine.pop("printer_settings_id", None)

    normal_speed_min = float(printer["material_recommended_speed_min"])
    normal_speed_max = float(printer["material_recommended_speed_max"])
    normal_speeds = {
        "outer_wall_speed": 45.0,
        "inner_wall_speed": 60.0,
        "small_perimeter_speed": 40.0,
        "sparse_infill_speed": 70.0,
        "internal_solid_infill_speed": 60.0,
        "top_surface_speed": 40.0,
        "gap_infill_speed": 40.0,
    }
    outside_material_speed_range = {
        name: speed
        for name, speed in normal_speeds.items()
        if speed < normal_speed_min or speed > normal_speed_max
    }
    if outside_material_speed_range:
        raise ValueError(
            "normal print speeds outside material recommendation "
            f"{normal_speed_min:g}..{normal_speed_max:g} mm/s: "
            f"{outside_material_speed_range}"
        )

    process = dict(base_process)
    process.update(
        {
            "name": process_name,
            "type": "process",
            "setting_id": "MHpNmkShui6fTwVu",
            "print_settings_id": process_name,
            "compatible_printers": [machine_name],
            "inherits": "fdm_process_mytoolchanger_common",
            "from": "system",
            "layer_height": "0.2",
            "initial_layer_print_height": "0.24",
            "wall_loops": "3",
            "top_shell_layers": "5",
            "bottom_shell_layers": "5",
            "sparse_infill_density": "15%",
            "sparse_infill_pattern": "gyroid",
            **{
                name: f"{speed:g}"
                for name, speed in normal_speeds.items()
            },
            "bridge_speed": "30",
            "initial_layer_speed": f"{float(print_process['first_layer_speed']):g}",
            "initial_layer_infill_speed": (
                f"{float(print_process['first_layer_infill_speed']):g}"
            ),
            "initial_layer_travel_speed": (
                f"{int(print_process['first_layer_travel_speed_percent'])}%"
            ),
            "initial_layer_line_width": (
                f"{float(print_process['first_layer_line_width']):g}"
            ),
            "travel_speed": "100",
            "default_acceleration": "700",
            "outer_wall_acceleration": "500",
            "inner_wall_acceleration": "650",
            "sparse_infill_acceleration": "700",
            "initial_layer_acceleration": "400",
            "travel_acceleration": "800",
            "enable_support": "0",
            "brim_type": str(print_process["brim_type"]),
            "brim_width": f"{float(print_process['brim_width']):g}",
            "brim_object_gap": f"{float(print_process['brim_object_gap']):g}",
            "skirt_loops": "0",
            "seam_position": "aligned",
            "elefant_foot_compensation": "0.15",
            "reduce_crossing_wall": (
                "1" if print_process.get("reduce_crossing_wall", False) else "0"
            ),
            "slowdown_for_curled_perimeters": (
                "1"
                if print_process.get("slowdown_for_curled_perimeters", False)
                else "0"
            ),
        }
    )
    process.pop("print_settings_id", None)

    filament = dict(base_filament)
    nozzle_temp = f"{printer['nozzle_temperature']:g}"
    first_layer_temp = f"{printer['nozzle_temperature_initial_layer']:g}"
    bed_temp = f"{printer['bed_temperature']:g}"
    first_layer_bed_temp = f"{printer.get('bed_temperature_initial_layer', printer['bed_temperature']):g}"
    filament.update(
        {
            "name": filament_name,
            "type": "filament",
            "setting_id": "4qShNrl9EWAVBfeG",
            "filament_settings_id": [filament_name],
            "compatible_printers": [machine_name],
            "inherits": "Generic PETG @System",
            "from": "system",
            "filament_vendor": ["彩格"],
            "filament_type": ["PETG"],
            "filament_diameter": [f"{printer['filament_diameter']:g}"],
            "filament_density": [f"{printer['filament_density_g_cm3']:g}"],
            "nozzle_temperature": [nozzle_temp],
            "nozzle_temperature_initial_layer": [first_layer_temp],
            "hot_plate_temp": [bed_temp],
            "hot_plate_temp_initial_layer": [first_layer_bed_temp],
            "textured_plate_temp": [bed_temp],
            "textured_plate_temp_initial_layer": [first_layer_bed_temp],
            "cool_plate_temp": [bed_temp],
            "cool_plate_temp_initial_layer": [first_layer_bed_temp],
            "eng_plate_temp": [bed_temp],
            "eng_plate_temp_initial_layer": [first_layer_bed_temp],
            "supertack_plate_temp": [bed_temp],
            "supertack_plate_temp_initial_layer": [first_layer_bed_temp],
            "textured_cool_plate_temp": [bed_temp],
            "textured_cool_plate_temp_initial_layer": [first_layer_bed_temp],
            "filament_max_volumetric_speed": ["10"],
            "fan_min_speed": ["30"],
            "fan_max_speed": ["70"],
            "close_fan_the_first_x_layers": [
                str(int(print_process["fan_off_layers"]))
            ],
        }
    )
    filament.pop("filament_settings_id", None)
    return machine, process, filament


CORE_3MF_NAMESPACE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships"
CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types"


def item_orientations(item: dict[str, Any]) -> list[tuple[float, float, int]]:
    width, height = (float(item["dimensions_mm"][0]), float(item["dimensions_mm"][1]))
    orientations = [(width, height, 0)]
    if abs(width - height) > 1e-6:
        orientations.append((height, width, 90))
    return orientations


def place_on_plate(
    plate: dict[str, Any],
    item: dict[str, Any],
    usable_x: float,
    usable_y: float,
    gap: float,
) -> bool:
    candidates: list[tuple[float, int, float, float, int, float]] = []
    for width, height, rotation_deg in item_orientations(item):
        if width > usable_x or height > usable_y:
            continue
        for index, shelf in enumerate(plate["shelves"]):
            x_min = float(shelf["used_x"]) + gap
            if height <= shelf["height"] and x_min + width <= usable_x:
                waste = shelf["height"] - height + usable_x - x_min - width
                candidates.append(
                    (waste, index, width, height, rotation_deg, x_min)
                )
    if candidates:
        _, index, width, height, rotation_deg, x_min = min(
            candidates,
            key=lambda candidate: (
                candidate[0],
                candidate[4],
                candidate[1],
            ),
        )
        shelf = plate["shelves"][index]
        y_min = float(shelf["y"])
        shelf["used_x"] = x_min + width
        plate["items"].append(
            {
                **item,
                "rotation_deg": rotation_deg,
                "local_bounds_mm": [x_min, y_min, x_min + width, y_min + height],
            }
        )
        return True

    used_y = (
        max(float(shelf["y"]) + float(shelf["height"]) for shelf in plate["shelves"])
        + gap
        if plate["shelves"]
        else 0.0
    )
    new_shelf = [
        orientation
        for orientation in item_orientations(item)
        if orientation[0] <= usable_x and used_y + orientation[1] <= usable_y
    ]
    if not new_shelf:
        return False
    width, height, rotation_deg = min(
        new_shelf, key=lambda value: (value[1], value[0], value[2])
    )
    plate["shelves"].append({"y": used_y, "height": height, "used_x": width})
    plate["items"].append(
        {
            **item,
            "rotation_deg": rotation_deg,
            "local_bounds_mm": [0.0, used_y, width, used_y + height],
        }
    )
    return True


def expanded_bounds(bounds: list[float], amount: float) -> list[float]:
    return [
        float(bounds[0]) - amount,
        float(bounds[1]) - amount,
        float(bounds[2]) + amount,
        float(bounds[3]) + amount,
    ]


def positive_intersection(
    first: list[float], second: list[float], tolerance: float = 1e-6
) -> tuple[float, float] | None:
    overlap_x = min(first[2], second[2]) - max(first[0], second[0])
    overlap_y = min(first[3], second[3]) - max(first[1], second[1])
    if overlap_x > tolerance and overlap_y > tolerance:
        return overlap_x, overlap_y
    return None


def finalize_plate_layout(
    plate: dict[str, Any],
    bed_x: float,
    bed_y: float,
    edge_clearance: float,
    brim: float,
) -> None:
    local_bounds = [item["local_bounds_mm"] for item in plate["items"]]
    layout_min_x = min(bounds[0] for bounds in local_bounds)
    layout_min_y = min(bounds[1] for bounds in local_bounds)
    layout_max_x = max(bounds[2] for bounds in local_bounds)
    layout_max_y = max(bounds[3] for bounds in local_bounds)
    shift_x = bed_x / 2.0 - (layout_min_x + layout_max_x) / 2.0
    shift_y = bed_y / 2.0 - (layout_min_y + layout_max_y) / 2.0

    for item in plate["items"]:
        local = item.pop("local_bounds_mm")
        bounds = [
            round(local[0] + shift_x, 4),
            round(local[1] + shift_y, 4),
            round(local[2] + shift_x, 4),
            round(local[3] + shift_y, 4),
        ]
        item["bounds_mm"] = bounds
        item["center_mm"] = [
            round((bounds[0] + bounds[2]) / 2.0, 4),
            round((bounds[1] + bounds[3]) / 2.0, 4),
        ]

    model_bounds = [
        min(item["bounds_mm"][0] for item in plate["items"]),
        min(item["bounds_mm"][1] for item in plate["items"]),
        max(item["bounds_mm"][2] for item in plate["items"]),
        max(item["bounds_mm"][3] for item in plate["items"]),
    ]
    brim_bounds = expanded_bounds(model_bounds, brim)
    if (
        brim_bounds[0] < edge_clearance - 1e-6
        or brim_bounds[1] < edge_clearance - 1e-6
        or brim_bounds[2] > bed_x - edge_clearance + 1e-6
        or brim_bounds[3] > bed_y - edge_clearance + 1e-6
    ):
        raise ValueError(
            f"plate layout exceeds bed clearance: models={model_bounds}, brim={brim_bounds}"
        )

    overlaps: list[dict[str, Any]] = []
    for index, first in enumerate(plate["items"]):
        first_with_brim = expanded_bounds(first["bounds_mm"], brim)
        for second in plate["items"][index + 1 :]:
            second_with_brim = expanded_bounds(second["bounds_mm"], brim)
            intersection = positive_intersection(first_with_brim, second_with_brim)
            if intersection is None:
                continue
            overlaps.append(
                {
                    "first": first["id"],
                    "second": second["id"],
                    "overlap_mm": [
                        round(intersection[0], 4),
                        round(intersection[1], 4),
                    ],
                }
            )
    if overlaps:
        raise ValueError(f"deterministic plate layout overlaps: {overlaps}")

    plate["model_bounds_mm"] = [round(value, 4) for value in model_bounds]
    plate["brim_bounds_mm"] = [round(value, 4) for value in brim_bounds]
    plate["layout_verified_non_overlapping"] = True


def build_plates(
    report: dict[str, Any], config: dict[str, Any], models_dir: Path
) -> list[dict[str, Any]]:
    printer = config["printer"]
    bed_x = float(printer["bed_x"])
    bed_y = float(printer["bed_y"])
    margin = float(printer.get("bed_edge_margin", 5.0))
    brim = float(config["print_process"]["brim_width"])
    model_gap = float(config["print_process"].get("minimum_model_gap", 2.0))
    edge_clearance = margin
    packing_clearance = margin + brim
    gap = 2.0 * brim + model_gap
    usable_x = bed_x - 2.0 * packing_clearance
    usable_y = bed_y - 2.0 * packing_clearance
    instances: list[dict[str, Any]] = []
    for name, details in report["parts"].items():
        for occurrence in range(1, int(details["quantity"]) + 1):
            instances.append(
                {
                    "id": f"{name}_{occurrence:02d}",
                    "part": name,
                    "source": str((models_dir / f"{name}.stl").resolve()),
                    "dimensions_mm": details["dimensions_mm"],
                }
            )
    instances.sort(
        key=lambda item: (
            max(float(item["dimensions_mm"][0]), float(item["dimensions_mm"][1])),
            float(item["dimensions_mm"][0]) * float(item["dimensions_mm"][1]),
        ),
        reverse=True,
    )

    plates: list[dict[str, Any]] = []
    for item in instances:
        if any(place_on_plate(plate, item, usable_x, usable_y, gap) for plate in plates):
            continue
        plate: dict[str, Any] = {"items": [], "shelves": []}
        if not place_on_plate(plate, item, usable_x, usable_y, gap):
            raise ValueError(f"part does not fit configured bed with margin: {item['part']}")
        plates.append(plate)
    for index, plate in enumerate(plates, start=1):
        finalize_plate_layout(
            plate,
            bed_x=bed_x,
            bed_y=bed_y,
            edge_clearance=edge_clearance,
            brim=brim,
        )
        plate["plate"] = index
        plate["bed_mm"] = [bed_x, bed_y]
        plate["edge_margin_mm"] = margin
        plate["brim_width_mm"] = brim
        plate["minimum_model_gap_mm"] = model_gap
        plate["minimum_brim_to_brim_gap_mm"] = model_gap
        plate["revision"] = str(config.get("revision", "0.3"))
        plate.pop("shelves", None)
    return plates


def build_individual_part_plates(
    report: dict[str, Any], config: dict[str, Any], models_dir: Path
) -> list[dict[str, Any]]:
    """Build one centered plate per part type, including configured small-part spares."""

    printer = config["printer"]
    bed_x = float(printer["bed_x"])
    bed_y = float(printer["bed_y"])
    margin = float(printer.get("bed_edge_margin", 5.0))
    process = config["print_process"]
    brim = float(process["brim_width"])
    model_gap = float(process.get("minimum_model_gap", 2.0))
    gap = 2.0 * brim + model_gap
    usable_x = bed_x - 2.0 * (margin + brim)
    usable_y = bed_y - 2.0 * (margin + brim)
    quantity_overrides = {
        str(name): int(quantity)
        for name, quantity in process.get("individual_part_quantities", {}).items()
    }

    plates: list[dict[str, Any]] = []
    for plate_number, (name, details) in enumerate(report["parts"].items(), start=1):
        quantity = max(int(details["quantity"]), quantity_overrides.get(name, 1))
        plate: dict[str, Any] = {"items": [], "shelves": []}
        for occurrence in range(1, quantity + 1):
            item = {
                "id": f"{name}_{occurrence:02d}",
                "part": name,
                "source": str((models_dir / f"{name}.stl").resolve()),
                "dimensions_mm": details["dimensions_mm"],
            }
            if not place_on_plate(plate, item, usable_x, usable_y, gap):
                raise ValueError(
                    f"individual part group does not fit configured bed: "
                    f"{name} × {quantity}"
                )

        finalize_plate_layout(
            plate,
            bed_x=bed_x,
            bed_y=bed_y,
            edge_clearance=margin,
            brim=brim,
        )
        plate["plate"] = plate_number
        plate["file_tag"] = f"plate_{plate_number:02d}_{name}_x{quantity}"
        plate["bed_mm"] = [bed_x, bed_y]
        plate["edge_margin_mm"] = margin
        plate["brim_width_mm"] = brim
        plate["minimum_model_gap_mm"] = model_gap
        plate["minimum_brim_to_brim_gap_mm"] = model_gap
        plate["revision"] = str(config.get("revision", "0.3"))
        plate.pop("shelves", None)
        plates.append(plate)
    return plates


def format_3mf_number(value: float) -> str:
    rounded = 0.0 if abs(value) < 5e-10 else float(value)
    return f"{rounded:.9g}"


def three_mf_transform(item: dict[str, Any], mesh_path: Path) -> list[float]:
    mesh = load_binary_stl(mesh_path)
    rotation_deg = float(item["rotation_deg"])
    radians = math.radians(rotation_deg)
    cosine = math.cos(radians)
    sine = math.sin(radians)
    rotation = np.array(
        [
            [cosine, -sine, 0.0],
            [sine, cosine, 0.0],
            [0.0, 0.0, 1.0],
        ]
    )
    rotated_vertices = mesh.vertices @ rotation.T
    rotated_minimum = rotated_vertices.min(axis=0)
    bounds = item["bounds_mm"]
    translation = np.array(
        [
            float(bounds[0]) - float(rotated_minimum[0]),
            float(bounds[1]) - float(rotated_minimum[1]),
            -float(rotated_minimum[2]),
        ]
    )
    return [
        cosine,
        -sine,
        0.0,
        sine,
        cosine,
        0.0,
        0.0,
        0.0,
        1.0,
        float(translation[0]),
        float(translation[1]),
        float(translation[2]),
    ]


def xml_bytes(element: ET.Element) -> bytes:
    return ET.tostring(element, encoding="utf-8", xml_declaration=True)


def deterministic_zip_entry(name: str, payload: bytes) -> tuple[zipfile.ZipInfo, bytes]:
    entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    entry.compress_type = zipfile.ZIP_DEFLATED
    entry.external_attr = 0o100644 << 16
    return entry, payload


def write_plate_3mf(plate: dict[str, Any], path: Path) -> dict[str, Any]:
    ET.register_namespace("", CORE_3MF_NAMESPACE)
    model = ET.Element(
        f"{{{CORE_3MF_NAMESPACE}}}model",
        {
            "unit": "millimeter",
            f"{{http://www.w3.org/XML/1998/namespace}}lang": "zh-CN",
        },
    )
    ET.SubElement(
        model,
        f"{{{CORE_3MF_NAMESPACE}}}metadata",
        {"name": "Application"},
    ).text = "C题确定性打印盘生成器"
    ET.SubElement(
        model,
        f"{{{CORE_3MF_NAMESPACE}}}metadata",
        {"name": "Title"},
    ).text = f"C题 v{plate.get('revision', '0.3')} 打印盘 {int(plate['plate']):02d}"
    resources = ET.SubElement(model, f"{{{CORE_3MF_NAMESPACE}}}resources")
    build = ET.SubElement(model, f"{{{CORE_3MF_NAMESPACE}}}build")

    object_records: list[dict[str, Any]] = []
    for object_id, item in enumerate(plate["items"], start=1):
        mesh_path = Path(item["source"])
        mesh = load_binary_stl(mesh_path, item["id"])
        unique_vertices, inverse = np.unique(
            np.round(mesh.vertices, 8), axis=0, return_inverse=True
        )
        faces = inverse[mesh.faces]
        object_element = ET.SubElement(
            resources,
            f"{{{CORE_3MF_NAMESPACE}}}object",
            {
                "id": str(object_id),
                "type": "model",
                "name": item["id"],
            },
        )
        mesh_element = ET.SubElement(
            object_element, f"{{{CORE_3MF_NAMESPACE}}}mesh"
        )
        vertices_element = ET.SubElement(
            mesh_element, f"{{{CORE_3MF_NAMESPACE}}}vertices"
        )
        for vertex in unique_vertices:
            ET.SubElement(
                vertices_element,
                f"{{{CORE_3MF_NAMESPACE}}}vertex",
                {
                    "x": format_3mf_number(float(vertex[0])),
                    "y": format_3mf_number(float(vertex[1])),
                    "z": format_3mf_number(float(vertex[2])),
                },
            )
        triangles_element = ET.SubElement(
            mesh_element, f"{{{CORE_3MF_NAMESPACE}}}triangles"
        )
        for face in faces:
            ET.SubElement(
                triangles_element,
                f"{{{CORE_3MF_NAMESPACE}}}triangle",
                {
                    "v1": str(int(face[0])),
                    "v2": str(int(face[1])),
                    "v3": str(int(face[2])),
                },
            )
        transform = three_mf_transform(item, mesh_path)
        ET.SubElement(
            build,
            f"{{{CORE_3MF_NAMESPACE}}}item",
            {
                "objectid": str(object_id),
                "transform": " ".join(format_3mf_number(value) for value in transform),
                "printable": "1",
            },
        )
        item["transform_3mf"] = [round(value, 9) for value in transform]
        object_records.append(
            {
                "id": item["id"],
                "object_id": object_id,
                "vertices": int(len(unique_vertices)),
                "triangles": int(len(faces)),
                "transform_3mf": item["transform_3mf"],
            }
        )

    # OrcaSlicer 2.4.2's 3MF reader is stricter than a namespace-aware XML
    # parser and rejects valid OPC files whose root namespaces use an ns0
    # prefix. Keep these two tiny package files in the conventional default-
    # namespace spelling used by Orca's own exporter.
    content_types = b"""<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
"""
    relationships = b"""<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
"""

    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as archive:
        for entry, payload in (
            deterministic_zip_entry("[Content_Types].xml", content_types),
            deterministic_zip_entry("_rels/.rels", relationships),
            deterministic_zip_entry("3D/3dmodel.model", xml_bytes(model)),
        ):
            archive.writestr(entry, payload)
    return {
        "path": str(path),
        "sha256": sha256_file(path),
        "objects": object_records,
    }


def run_orca(
    orca: Path,
    profiles: tuple[Path, Path, Path],
    plates: list[dict[str, Any]],
    output: Path,
    config: dict[str, Any],
) -> dict[str, Any]:
    if not orca.is_file():
        raise FileNotFoundError(f"OrcaSlicer executable not found: {orca}")
    machine, process, filament = profiles
    projects_dir = output / "projects"
    gcode_dir = output / "gcode"
    logs_dir = output / "logs"
    work_dir = output / ".slice-work"
    for directory in (projects_dir, gcode_dir, logs_dir, work_dir):
        if directory.exists():
            shutil.rmtree(directory)
    for directory in (projects_dir, gcode_dir, logs_dir, work_dir):
        directory.mkdir(parents=True, exist_ok=True)
    job_name = str(config.get("job_name", "C_problem_CR3040D_PETG_all_parts"))
    layout_projects: list[dict[str, Any]] = []
    gcodes: list[dict[str, Any]] = []
    for plate in plates:
        plate_number = int(plate["plate"])
        plate_tag = str(plate.get("file_tag", f"plate_{plate_number:02d}"))
        layout_project = (
            projects_dir / f"{job_name}_{plate_tag}_layout.3mf"
        ).resolve()
        layout_record = write_plate_3mf(plate, layout_project)
        layout_record["plate"] = plate_number
        layout_projects.append(layout_record)

        plate_work_dir = work_dir / plate_tag
        plate_work_dir.mkdir(parents=True, exist_ok=True)
        log_path = (logs_dir / f"{plate_tag}.log").resolve()
        command = [
            str(orca),
            "--debug",
            "2",
            "--load-settings",
            f"{machine.resolve()};{process.resolve()}",
            "--load-filaments",
            str(filament.resolve()),
            "--arrange",
            "0",
            "--orient",
            "0",
            "--ensure-on-bed",
            "--slice",
            "0",
            "--outputdir",
            str(plate_work_dir.resolve()),
            "--logfile",
            str(log_path),
            str(layout_project),
        ]
        completed = subprocess.run(command, text=True, capture_output=True, check=False)
        (logs_dir / f"{plate_tag}_stdout.txt").write_text(
            completed.stdout, encoding="utf-8"
        )
        (logs_dir / f"{plate_tag}_stderr.txt").write_text(
            completed.stderr, encoding="utf-8"
        )
        if completed.returncode != 0:
            raise RuntimeError(
                f"OrcaSlicer failed for plate {plate_number} with exit "
                f"{completed.returncode}"
            )
        candidates = sorted(plate_work_dir.glob("*.gcode"))
        if len(candidates) != 1:
            raise RuntimeError(
                f"OrcaSlicer generated {len(candidates)} G-code files for "
                f"plate {plate_number}; expected exactly one"
            )
        path = gcode_dir / f"{job_name}_{plate_tag}.gcode"
        candidates[0].replace(path)
        gcodes.append(
            {
                "plate": plate_number,
                "path": str(path),
                "layout_project_3mf": str(layout_project),
            }
        )
    shutil.rmtree(work_dir)
    return {
        "layout_mode": "deterministic_per_plate_3mf",
        "automatic_arrange_disabled": True,
        "layout_projects_3mf": layout_projects,
        "gcodes": gcodes,
    }


def gcode_stats(path: Path) -> dict[str, Any]:
    stats: dict[str, Any] = {}
    patterns = {
        "estimated_time": re.compile(r"^; estimated printing time \(normal mode\) = (.+)$"),
        "filament_used_g": re.compile(r"^; total filament used \[g\] = ([0-9.]+)$"),
        "filament_used_mm": re.compile(r"^; filament used \[mm\] = ([0-9.]+)$"),
        "filament_cost": re.compile(r"^; total filament cost = ([0-9.]+)$"),
    }
    with path.open("r", encoding="utf-8", errors="replace") as stream:
        for line in stream:
            stripped = line.strip()
            for key, pattern in patterns.items():
                match = pattern.match(stripped)
                if not match:
                    continue
                value: Any = match.group(1)
                if key != "estimated_time":
                    value = float(value)
                stats[key] = value
    if "estimated_time" in stats:
        duration = str(stats["estimated_time"])
        values = {
            unit: int(match.group(1)) if (match := re.search(rf"(\d+){unit}", duration)) else 0
            for unit in ("d", "h", "m", "s")
        }
        stats["estimated_time_seconds"] = (
            values["d"] * 86400 + values["h"] * 3600 + values["m"] * 60 + values["s"]
        )
    return stats


def format_duration(seconds: int) -> str:
    days, remaining = divmod(seconds, 86400)
    hours, remaining = divmod(remaining, 3600)
    minutes, secs = divmod(remaining, 60)
    pieces = []
    if days:
        pieces.append(f"{days}d")
    if hours or days:
        pieces.append(f"{hours}h")
    pieces.extend((f"{minutes}m", f"{secs}s"))
    return " ".join(pieces)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--orca", type=Path, default=DEFAULT_ORCA)
    parser.add_argument("--base-machine", type=Path, default=DEFAULT_MACHINE)
    parser.add_argument("--base-process", type=Path, default=DEFAULT_PROCESS)
    parser.add_argument("--base-filament", type=Path, default=DEFAULT_FILAMENT)
    parser.add_argument("--slice", action="store_true")
    parser.add_argument(
        "--individual-parts",
        action="store_true",
        help="Generate one centered plate per part type, with configured spare quantities.",
    )
    parser.add_argument(
        "--allow-provisional-clearance",
        action="store_true",
        help="Allow prototype G-code when the configured clearance trial has not been marked verified.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config = load_json(args.config)
    clearance_verified = bool(config.get("manufacturing", {}).get("clearance_verified", True))
    provisional_slice = bool(
        args.slice
        and config.get("revision") in {"0.3", "0.4"}
        and not clearance_verified
    )
    if provisional_slice and not args.allow_provisional_clearance:
        raise ValueError(
            "clearance trial must pass before final lock G-code generation; "
            "use --allow-provisional-clearance only for a clearly labelled prototype"
        )
    report = load_json(args.models / "validation_report.json")
    source_profile_paths = (args.base_machine, args.base_process, args.base_filament)
    hashes_before = {str(path): sha256_file(path) for path in source_profile_paths}
    base_machine = load_json(args.base_machine)
    base_process = load_json(args.base_process)
    base_filament = load_json(args.base_filament)
    machine, process, filament = build_profiles(
        config,
        base_machine,
        base_process,
        base_filament,
    )
    profile_dir = args.output / "profiles"
    profile_paths = (
        profile_dir / "CR-3040D_0.4_machine.json",
        profile_dir / "C_problem_PETG_0.20_process.json",
        profile_dir / "Caige_PETG_1.75_filament.json",
    )
    for path, payload in zip(profile_paths, (machine, process, filament)):
        write_json(path, payload)

    plates = (
        build_individual_part_plates(report, config, args.models)
        if args.individual_parts
        else build_plates(report, config, args.models)
    )
    orca_result: dict[str, Any] | None = None
    if args.slice:
        orca_result = run_orca(args.orca, profile_paths, plates, args.output, config)
        for gcode in orca_result["gcodes"]:
            gcode["stats"] = gcode_stats(Path(gcode["path"]))
        total_seconds = sum(
            int(gcode["stats"].get("estimated_time_seconds", 0))
            for gcode in orca_result["gcodes"]
        )
        orca_result["totals"] = {
            "filament_used_g": round(
                sum(float(gcode["stats"].get("filament_used_g", 0.0)) for gcode in orca_result["gcodes"]),
                2,
            ),
            "filament_used_mm": round(
                sum(float(gcode["stats"].get("filament_used_mm", 0.0)) for gcode in orca_result["gcodes"]),
                2,
            ),
            "estimated_time_seconds": total_seconds,
            "estimated_time": format_duration(total_seconds),
        }
    hashes_after = {str(path): sha256_file(path) for path in source_profile_paths}
    hash_validation = {
        "before": hashes_before,
        "after": hashes_after,
        "unchanged": hashes_before == hashes_after,
    }
    write_json(args.output / "user_preset_hash_validation.json", hash_validation)
    if not hash_validation["unchanged"]:
        raise RuntimeError("Orca user preset source files changed during preparation")
    manifest = {
        "status": (
            "公差未实测的原型切片"
            if provisional_slice
            else "待实物接口复核的切片候选"
        ),
        "slicer": config["printer"]["slicer"],
        "printer": config["printer"],
        "clearance_verified": clearance_verified,
        "provisional_clearance_override": bool(provisional_slice and args.allow_provisional_clearance),
        "profile_files": [str(path) for path in profile_paths],
        "user_preset_hash_validation": str(args.output / "user_preset_hash_validation.json"),
        "deterministic_layout_job_count": len(plates),
        "deterministic_plates": plates,
        "layout_policy": {
            "mode": "individual_parts" if args.individual_parts else "combined_plates",
            "automatic_arrange": False,
            "per_plate_slicing": True,
            "brim_aware_spacing": True,
            "all_layouts_verified_non_overlapping": all(
                bool(plate["layout_verified_non_overlapping"]) for plate in plates
            ),
        },
        "orca": orca_result,
    }
    write_json(args.output / "print_manifest.json", manifest)
    print(
        json.dumps(
            {
                "ok": True,
                "deterministic_layout_jobs": len(plates),
                "orca_plates": len(orca_result["gcodes"]) if orca_result else None,
                "instances": sum(len(plate["items"]) for plate in plates),
                "sliced": bool(args.slice),
                "output": str(args.output),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
