#!/usr/bin/env python3
"""生成并验证 v0.6 数字钥匙盒体与锁定的 v0.4 旧盖。

盒体完全由闭合 primitive 合并而成，避免依赖外部 CAD/布尔运算。旧盖不是
重新建模件：生成时先验证仓库内 v0.4 源文件 SHA-256，再进行字节复制。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import shutil
from typing import Any, Iterable

from generate_product_models import chamfered_profile, edge_wall
from meshlib import (
    Mesh,
    box,
    convex_prism,
    edge_count_validation,
    export_binary_stl,
    load_binary_stl,
    merge,
)


CAD_ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = CAD_ROOT.parents[3]
DEFAULT_CONFIG = CAD_ROOT / "parameters_v0_6.json"
DEFAULT_OUTPUT = REPOSITORY_ROOT / "生成内容/3D打印/C题/v0.6/钥匙盒二件套"

BODY_FILENAME = "钥匙盒体_v0.6.stl"
COVER_FILENAME = "钥匙盒盖_v0.4.stl"
VALIDATION_REPORT_FILENAME = "validation_report.json"
EXPECTED_STL_FILENAMES = {BODY_FILENAME, COVER_FILENAME}
EXPECTED_COVER_SHA256 = "05317c264a8327e5853fb774c1f9568e3b9d3e38bddd5eb73f3069ae7fb398ef"
DIMENSION_TOLERANCE_MM = 0.001


def sha256_file(path: Path) -> str:
    """Return a complete-file SHA-256 digest."""

    return hashlib.sha256(path.read_bytes()).hexdigest()


def _nested_value(payload: dict[str, Any], dotted_path: str) -> Any:
    current: Any = payload
    for key in dotted_path.split("."):
        if not isinstance(current, dict) or key not in current:
            raise ValueError(f"parameters_v0_6.json lacks required field: {dotted_path}")
        current = current[key]
    return current


def _require_close(
    payload: dict[str, Any],
    dotted_path: str,
    expected: float,
    *,
    tolerance: float = 1e-9,
) -> float:
    actual = float(_nested_value(payload, dotted_path))
    if not math.isclose(actual, expected, abs_tol=tolerance):
        raise ValueError(
            f"parameters_v0_6.json field {dotted_path} must be {expected}, got {actual}"
        )
    return actual


def load_parameters(path: Path = DEFAULT_CONFIG) -> dict[str, Any]:
    """Load the v0.6 parameter record and reject a different revision."""

    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schema_version") != 1 or str(payload.get("revision")) != "0.6":
        raise ValueError("generate_key_box_v0_6.py requires schema 1 revision 0.6")
    key = payload.get("key_box_v0_6")
    if not isinstance(key, dict):
        raise ValueError("parameters_v0_6.json lacks key_box_v0_6")
    return key


def assert_parameter_contract(key: dict[str, Any]) -> dict[str, Any]:
    """Assert all measured and provisional v0.6 inputs used by this exporter.

    This deliberately turns user measurements into executable checks.  It also
    records provisional values rather than presenting them as hardware-verified.
    """

    required_numbers = {
        "body.outer_x": 105.0,
        "body.outer_y": 58.0,
        "body.height": 35.0,
        "body.floor_thickness": 3.2,
        "body.lower_wall_thickness": 2.4,
        "body.cover_fit_wall_thickness": 1.8,
        "body.cover_fit_depth": 4.0,
        "body.assembled_outer_x": 105.0,
        "body.assembled_outer_y": 58.0,
        "body.assembled_height_with_cover": 38.0,
        "body.official_limit_x": 120.0,
        "body.official_limit_y": 80.0,
        "body.official_height_limit": 40.0,
        "body.margin_below_limit_x": 15.0,
        "body.margin_below_limit_y": 22.0,
        "body.margin_below_height_limit": 2.0,
        "body.expected_top_opening_x": 101.4,
        "body.expected_top_opening_y": 54.4,
        "pcb.x": 60.0,
        "pcb.y": 31.0,
        "pcb.datasheet_nominal_x": 58.0,
        "pcb.datasheet_nominal_y": 30.0,
        "pcb.center_x": 18.5,
        "pcb.bottom_z": 23.0,
        "pcb.highest_z": 34.0,
        "pcb.top_clearance": 1.0,
        "headers.pin_length": 12.0,
        "headers.dupont_female_height": 15.0,
        "headers.row_center_spacing": 15.0,
        "antenna.slot_width_y": 28.0,
        "antenna.slot_bottom_z": 21.0,
        "antenna.slot_top_z": 27.0,
        "pcb_support_table.x": 40.0,
        "pcb_support_table.y": 8.0,
        "pcb_support_table.center_x": 18.5,
        "pcb_support_table.bottom_z": 3.2,
        "pcb_support_table.top_z": 23.0,
        "pcb_support_table.height_z": 19.8,
        "pcb_support_table.height_over_pin_length": 7.8,
        "wire_management.dupont_lowest_z": 8.0,
        "wire_management.dupont_floor_clearance": 4.8,
        "wire_management.pin_lowest_z": 11.0,
        "wire_management.pin_floor_clearance": 7.8,
        "cover_v0_4.measured_skirt_outer_x": 98.0,
        "cover_v0_4.measured_skirt_outer_y": 50.0,
        "cover_v0_4.measured_snap_thickness": 2.0,
        "cover_v0_4.measured_snap_width": 6.0,
        "snap_fit.insertion_clearance_y": 0.2,
    }
    checked = {
        dotted_path: _require_close(key, dotted_path, expected)
        for dotted_path, expected in required_numbers.items()
    }
    if bool(_nested_value(key, "snap_fit.retention_pad_enabled")):
        raise ValueError("v0.6 must not add a local cover retention pad")
    if int(_nested_value(key, "cover_v0_4.measured_snap_height")) != 4:
        raise ValueError("old-cover measured snap height must remain 4 mm")
    if int(_nested_value(key, "headers.row_count")) != 2:
        raise ValueError("the header layout requires exactly two rows")
    if _nested_value(key, "headers.pins_per_row") is not None:
        raise ValueError("v0.6 pin count must remain unmeasured/provisional")
    if not bool(_nested_value(key, "headers.pin_count_provisional")):
        raise ValueError("the unmeasured header pin count must remain provisional")
    for removed_section in ("battery", "regulator", "pcb_locators"):
        if removed_section in key:
            raise ValueError(
                f"v0.6 must not define a printed {removed_section} mounting section"
            )

    body = key["body"]
    pcb = key["pcb"]
    antenna = key["antenna"]
    support = key["pcb_support_table"]
    wire = key["wire_management"]
    assembled = float(body["height"]) + float(body["cover_plate_thickness"])
    if not math.isclose(
        assembled, float(body["assembled_height_with_cover"]), abs_tol=1e-9
    ):
        raise ValueError("assembled height must equal body plus cover plate thickness")
    assembled_x = max(
        float(body["outer_x"]),
        float(key["cover_v0_4"]["source_stl_dimensions_mm"][0]),
    )
    assembled_y = max(
        float(body["outer_y"]),
        float(key["cover_v0_4"]["source_stl_dimensions_mm"][1]),
    )
    if not math.isclose(
        assembled_x, float(body["assembled_outer_x"]), abs_tol=1e-9
    ) or not math.isclose(
        assembled_y, float(body["assembled_outer_y"]), abs_tol=1e-9
    ):
        raise ValueError("assembled XY dimensions do not match body/cover envelopes")
    margins = {
        "x": float(body["official_limit_x"]) - assembled_x,
        "y": float(body["official_limit_y"]) - assembled_y,
        "z": float(body["official_height_limit"]) - assembled,
    }
    if not math.isclose(
        margins["x"], float(body["margin_below_limit_x"]), abs_tol=1e-9
    ) or not math.isclose(
        margins["y"], float(body["margin_below_limit_y"]), abs_tol=1e-9
    ) or not math.isclose(
        margins["z"], float(body["margin_below_height_limit"]), abs_tol=1e-9
    ):
        raise ValueError("official size-limit margins are inconsistent")
    if min(margins.values()) < 2.0:
        raise ValueError("v0.6 must preserve at least 2 mm margin to every size limit")
    if not math.isclose(
        float(body["outer_x"]) - 2.0 * float(body["cover_fit_wall_thickness"]),
        float(body["expected_top_opening_x"]),
        abs_tol=1e-9,
    ) or not math.isclose(
        float(body["outer_y"]) - 2.0 * float(body["cover_fit_wall_thickness"]),
        float(body["expected_top_opening_y"]),
        abs_tol=1e-9,
    ):
        raise ValueError("top opening does not match the configured cover-fit wall")
    if not math.isclose(
        float(antenna["tongue_end_x"]),
        float(antenna["tongue_start_x"]) + float(antenna["tongue_length"]),
        abs_tol=1e-9,
    ):
        raise ValueError("antenna tongue X dimensions are inconsistent")
    if not math.isclose(
        float(pcb["main_x_min"]),
        float(pcb["center_x"]) - float(pcb["x"]) / 2.0,
        abs_tol=1e-9,
    ) or not math.isclose(
        float(pcb["main_x_max"]),
        float(pcb["center_x"]) + float(pcb["x"]) / 2.0,
        abs_tol=1e-9,
    ):
        raise ValueError("PCB X bounds do not match its center and length")
    if not math.isclose(
        float(pcb["right_wall_clearance"]),
        float(pcb["expected_right_inner_wall_x"]) - float(pcb["main_x_max"]),
        abs_tol=1e-9,
    ):
        raise ValueError("PCB right-wall clearance is inconsistent")
    if not math.isclose(
        float(pcb["highest_z"]),
        float(pcb["bottom_z"]) + float(pcb["component_envelope_from_bottom"]),
        abs_tol=1e-9,
    ):
        raise ValueError("PCB highest Z does not match its component envelope")
    if not math.isclose(
        float(pcb["top_clearance"]),
        float(body["height"]) - float(pcb["highest_z"]),
        abs_tol=1e-9,
    ):
        raise ValueError("PCB top clearance is inconsistent")
    if not math.isclose(
        float(support["bottom_z"]), float(body["floor_thickness"]), abs_tol=1e-9
    ):
        raise ValueError("UWB support must start at the floor top")
    if not math.isclose(
        float(support["top_z"]), float(pcb["bottom_z"]), abs_tol=1e-9
    ):
        raise ValueError("UWB support top must meet the PCB bottom")
    if not math.isclose(
        float(support["height_z"]),
        float(support["top_z"]) - float(support["bottom_z"]),
        abs_tol=1e-9,
    ):
        raise ValueError("UWB support height is inconsistent")
    support_over_pin = float(support["height_z"]) - float(key["headers"]["pin_length"])
    if support_over_pin <= 0.0 or not math.isclose(
        support_over_pin,
        float(support["height_over_pin_length"]),
        abs_tol=1e-9,
    ):
        raise ValueError("UWB support must be taller than the 12 mm pins")
    support_min_x = float(support["center_x"]) - float(support["x"]) / 2.0
    support_max_x = float(support["center_x"]) + float(support["x"]) / 2.0
    if (
        support_min_x < float(pcb["main_x_min"])
        or support_max_x > float(pcb["main_x_max"])
    ):
        raise ValueError("UWB support must remain below the PCB footprint")
    row_clearance = (
        float(key["headers"]["row_center_spacing"])
        - float(support["y"])
        - float(wire["row_channel_width"])
    ) / 2.0
    if row_clearance < 0.0:
        raise ValueError("PCB support overlaps the provisional header wire channels")
    dupont_lowest = float(pcb["bottom_z"]) - float(
        key["headers"]["dupont_female_height"]
    )
    pin_lowest = float(pcb["bottom_z"]) - float(key["headers"]["pin_length"])
    if not math.isclose(
        dupont_lowest, float(wire["dupont_lowest_z"]), abs_tol=1e-9
    ) or not math.isclose(
        dupont_lowest - float(body["floor_thickness"]),
        float(wire["dupont_floor_clearance"]),
        abs_tol=1e-9,
    ):
        raise ValueError("DuPont connector floor clearance is inconsistent")
    if not math.isclose(
        pin_lowest, float(wire["pin_lowest_z"]), abs_tol=1e-9
    ) or not math.isclose(
        pin_lowest - float(body["floor_thickness"]),
        float(wire["pin_floor_clearance"]),
        abs_tol=1e-9,
    ):
        raise ValueError("header pin floor clearance is inconsistent")
    if not (
        float(antenna["slot_bottom_z"])
        <= float(pcb["bottom_z"])
        <= float(antenna["slot_top_z"])
    ):
        raise ValueError("antenna slot must cross the PCB bottom plane")
    power = key["power_components"]
    if (
        bool(power["battery_dimensions_known"])
        or bool(power["regulator_dimensions_known"])
        or bool(power["printed_supports_enabled"])
        or not bool(power["reserved_cavity_only"])
        or power["mount_method"] != "user_hot_melt_glue"
    ):
        raise ValueError("battery/regulator must remain unknown-size hot-glue items")
    internal = key["internal_features"]
    if not bool(internal["uwb_support_only"]) or any(
        bool(internal[name])
        for name in (
            "battery_supports_enabled",
            "regulator_supports_enabled",
            "pcb_locator_columns_enabled",
            "internal_snap_features_enabled",
        )
    ):
        raise ValueError("the UWB pedestal must be the only printed internal feature")

    provisional_fields = _nested_value(key, "provisional_fields")
    if not isinstance(provisional_fields, list) or not provisional_fields:
        raise ValueError("provisional_fields must remain an explicit non-empty list")
    expected_provisional = {
        "pcb.thickness",
        "pcb.component_envelope_from_bottom",
        "headers.active_x_min",
        "headers.active_x_max",
        "antenna.slot_width_y",
        "wire_management.row_channel_width",
    }
    if set(provisional_fields) != expected_provisional:
        raise ValueError("provisional_fields no longer represents the v0.6 uncertainty")
    if not bool(_nested_value(key, "pcb.component_envelope_provisional")):
        raise ValueError("PCB top envelope must remain marked provisional")
    if not bool(_nested_value(key, "antenna.slot_width_provisional")):
        raise ValueError("antenna slot width must remain marked provisional")
    provisional_values = {
        dotted_path: _require_close(key, dotted_path, expected)
        for dotted_path, expected in {
            "pcb.thickness": 1.6,
            "pcb.component_envelope_from_bottom": 11.0,
            "headers.active_x_min": 4.0,
            "headers.active_x_max": 34.0,
            "antenna.slot_width_y": 28.0,
            "wire_management.row_channel_width": 6.0,
        }.items()
    }

    return {
        "measured_and_design_constraints_mm": checked,
        "legacy_cover_measurement": {
            "skirt_outer_mm": [98.0, 50.0],
            "snap_thickness_mm": 2.0,
            "snap_width_mm": 6.0,
            "snap_height_mm": 4.0,
            "local_retention_pad": False,
        },
        "provisional_fields": provisional_fields,
        "provisional_values_mm": provisional_values,
        "provisional_top_component": {
            "highest_z_mm": float(_nested_value(key, "pcb.highest_z")),
            "top_clearance_mm": float(_nested_value(key, "pcb.top_clearance")),
            "hardware_verified": False,
        },
        "provisional_header_count": {
            "pins_per_row": None,
            "pin_length_mm": float(_nested_value(key, "headers.pin_length")),
            "hardware_verified": False,
        },
        "clearance_chain_mm": {
            "assembled_size": [assembled_x, assembled_y, assembled],
            "official_limit": [
                float(body["official_limit_x"]),
                float(body["official_limit_y"]),
                float(body["official_height_limit"]),
            ],
            "margin_below_limit": [margins["x"], margins["y"], margins["z"]],
            "support_height": float(support["height_z"]),
            "support_height_over_pin": round(support_over_pin, 6),
            "dupont_lowest_z": dupont_lowest,
            "dupont_floor_clearance": float(wire["dupont_floor_clearance"]),
            "pin_lowest_z": pin_lowest,
            "pin_floor_clearance": float(wire["pin_floor_clearance"]),
            "pcb_top_clearance": float(pcb["top_clearance"]),
            "row_channel_side_clearance": round(row_clearance, 6),
        },
        "power_component_mounting": {
            "battery_dimensions_known": False,
            "regulator_dimensions_known": False,
            "printed_supports": False,
            "method": "user_hot_melt_glue",
        },
    }


def _append_wall(
    pieces: list[Mesh],
    name: str,
    profile: list[tuple[float, float]],
    index: int,
    wall: float,
    height: float,
    bottom_z: float,
    fraction_start: float = 0.0,
    fraction_end: float = 1.0,
) -> None:
    pieces.append(
        edge_wall(
            name,
            profile[index],
            profile[(index + 1) % len(profile)],
            wall,
            height,
            bottom_z,
            fraction_start,
            fraction_end,
        )
    )


def _build_outer_shell(key: dict[str, Any]) -> list[Mesh]:
    body = key["body"]
    antenna = key["antenna"]
    outer_x = float(body["outer_x"])
    outer_y = float(body["outer_y"])
    height = float(body["height"])
    lower_wall = float(body["lower_wall_thickness"])
    fit_wall = float(body["cover_fit_wall_thickness"])
    fit_depth = float(body["cover_fit_depth"])
    profile = chamfered_profile(
        outer_x,
        outer_y,
        float(body["corner_chamfer"]),
    )
    lower_height = height - fit_depth
    pieces: list[Mesh] = [
        convex_prism(
            "key_box_floor",
            profile,
            float(body["floor_thickness"]),
            float(body["floor_thickness"]) / 2.0,
        )
    ]

    # The +X vertical segment is index 2.  Its middle interval remains open
    # from slot_bottom_z to slot_top_z, forming the narrow antenna tongue exit.
    right_edge_length = math.dist(profile[2], profile[3])
    slot_fraction = float(antenna["slot_width_y"]) / right_edge_length
    if not 0.0 < slot_fraction < 1.0:
        raise ValueError("antenna slot width does not fit the +X straight shell edge")
    side_fraction = (1.0 - slot_fraction) / 2.0
    slot_bottom = float(antenna["slot_bottom_z"])
    slot_top = float(antenna["slot_top_z"])
    if not 0.0 < slot_bottom < slot_top < lower_height:
        raise ValueError("antenna slot Z limits do not fit the lower shell wall")

    for index in range(len(profile)):
        if index == 2:
            for side, start, end in (
                ("lower_y", 0.0, side_fraction),
                ("upper_y", 1.0 - side_fraction, 1.0),
            ):
                _append_wall(
                    pieces,
                    f"key_box_right_wall_{side}",
                    profile,
                    index,
                    lower_wall,
                    lower_height,
                    0.0,
                    start,
                    end,
                )
                _append_wall(
                    pieces,
                    f"key_box_right_fit_{side}",
                    profile,
                    index,
                    fit_wall,
                    fit_depth,
                    lower_height,
                    start,
                    end,
                )
            _append_wall(
                pieces,
                "key_box_antenna_exit_below",
                profile,
                index,
                lower_wall,
                slot_bottom,
                0.0,
                side_fraction,
                1.0 - side_fraction,
            )
            _append_wall(
                pieces,
                "key_box_antenna_exit_above",
                profile,
                index,
                lower_wall,
                lower_height - slot_top,
                slot_top,
                side_fraction,
                1.0 - side_fraction,
            )
            _append_wall(
                pieces,
                "key_box_antenna_exit_fit",
                profile,
                index,
                fit_wall,
                fit_depth,
                lower_height,
                side_fraction,
                1.0 - side_fraction,
            )
            continue
        _append_wall(
            pieces,
            f"key_box_lower_wall_{index}",
            profile,
            index,
            lower_wall,
            lower_height,
            0.0,
        )
        _append_wall(
            pieces,
            f"key_box_cover_fit_wall_{index}",
            profile,
            index,
            fit_wall,
            fit_depth,
            lower_height,
        )
    return pieces


def _box_from_z(
    name: str,
    size_x: float,
    size_y: float,
    bottom_z: float,
    top_z: float,
    center_x: float,
    center_y: float,
) -> Mesh:
    if top_z <= bottom_z:
        raise ValueError(f"{name}: top must be above bottom")
    return box(
        name,
        (size_x, size_y, top_z - bottom_z),
        (center_x, center_y, (bottom_z + top_z) / 2.0),
    )


def _build_internal_features(key: dict[str, Any]) -> list[Mesh]:
    """Build only the requested UWB PCB pedestal.

    Battery and regulator sizes are intentionally unknown.  Their cavity stays
    empty so the user can place and hot-glue the actual parts after printing.
    """

    support = key["pcb_support_table"]
    return [
        _box_from_z(
            "uwb_pcb_support_pedestal_40x8",
            float(support["x"]),
            float(support["y"]),
            float(support["bottom_z"]),
            float(support["top_z"]),
            float(support["center_x"]),
            float(support["center_y"]),
        )
    ]


def build_key_box_components(key: dict[str, Any]) -> dict[str, Mesh]:
    """Return named shell/support primitives for geometry-level verification."""

    assert_parameter_contract(key)
    pieces = [*_build_outer_shell(key), *_build_internal_features(key)]
    return {piece.name: piece for piece in pieces}


def build_key_box(key: dict[str, Any]) -> Mesh:
    """Return the v0.6 body mesh at its final 105 x 58 x 35 mm envelope."""

    return merge("钥匙盒体_v0.6", build_key_box_components(key).values())


def dimensions_match(first: Iterable[float], second: Iterable[float]) -> bool:
    return all(
        abs(float(left) - float(right)) <= DIMENSION_TOLERANCE_MM
        for left, right in zip(first, second)
    )


def validate_mesh(mesh: Mesh, *, expected_dimensions: list[float] | None = None) -> dict[str, Any]:
    """Validate closed primitives after export/reload, without demanding one manifold."""

    validation = edge_count_validation(mesh)
    if validation["degenerate_triangles"] != 0:
        raise RuntimeError(f"{mesh.name}: contains degenerate triangles")
    if validation["open_boundary_edges"] != 0:
        raise RuntimeError(f"{mesh.name}: contains open boundary edges")
    if expected_dimensions is not None and not dimensions_match(
        validation["dimensions_mm"], expected_dimensions
    ):
        raise RuntimeError(
            f"{mesh.name}: dimensions {validation['dimensions_mm']} do not match "
            f"{expected_dimensions}"
        )
    return validation


def _remove_previous_stls(output: Path) -> None:
    for path in output.iterdir() if output.exists() else ():
        if path.is_file() and path.suffix.lower() == ".stl":
            path.unlink()


def _strict_stl_inventory(output: Path) -> set[str]:
    actual = {
        path.name
        for path in output.iterdir()
        if path.is_file() and path.suffix.lower() == ".stl"
    }
    if actual != EXPECTED_STL_FILENAMES:
        raise RuntimeError(
            f"output must contain exactly {sorted(EXPECTED_STL_FILENAMES)}, got {sorted(actual)}"
        )
    return actual


def _cover_source_path(key: dict[str, Any]) -> Path:
    source = REPOSITORY_ROOT / str(key["cover_v0_4"]["source_path_from_repository_root"])
    if not source.is_file():
        raise FileNotFoundError(f"locked v0.4 cover source not found: {source}")
    return source


def _write_report(path: Path, report: dict[str, Any]) -> None:
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def generate(key: dict[str, Any], output: Path) -> dict[str, Any]:
    """Generate exactly two STL files and a machine-readable validation report."""

    assertions = assert_parameter_contract(key)
    output.mkdir(parents=True, exist_ok=True)
    _remove_previous_stls(output)

    body_path = output / BODY_FILENAME
    body_mesh = build_key_box(key)
    expected_body_dimensions = [
        float(key["body"]["outer_x"]),
        float(key["body"]["outer_y"]),
        float(key["body"]["height"]),
    ]
    body_validation = validate_mesh(body_mesh, expected_dimensions=expected_body_dimensions)
    export_binary_stl(body_mesh, body_path)
    body_reloaded = load_binary_stl(body_path, body_mesh.name)
    body_reload_validation = validate_mesh(
        body_reloaded,
        expected_dimensions=expected_body_dimensions,
    )
    if not dimensions_match(
        body_validation["dimensions_mm"],
        body_reload_validation["dimensions_mm"],
    ):
        raise RuntimeError("body STL dimensions changed after binary STL reload")

    source_cover = _cover_source_path(key)
    source_hash = sha256_file(source_cover)
    expected_cover_hash = str(key["cover_v0_4"]["source_sha256"])
    if source_hash != EXPECTED_COVER_SHA256 or source_hash != expected_cover_hash:
        raise RuntimeError(
            "v0.4 cover hash mismatch: expected locked "
            f"{EXPECTED_COVER_SHA256}, got {source_hash}"
        )
    cover_path = output / COVER_FILENAME
    shutil.copyfile(source_cover, cover_path)
    if sha256_file(cover_path) != source_hash:
        raise RuntimeError("copied v0.4 cover does not byte-match its locked source")
    cover_validation = validate_mesh(load_binary_stl(cover_path, cover_path.stem))

    _strict_stl_inventory(output)
    report = {
        "ok": True,
        "revision": "0.6",
        "model_status": (
            "盒体参数化建模与软件网格验证候选；仅保留 UWB 支撑台，电池与"
            "稳压模块由用户热熔胶固定；PCB 顶部器件和天线槽 provisional"
        ),
        "source_parameters": str(DEFAULT_CONFIG),
        "parameter_assertions": assertions,
        "stl_inventory": sorted(EXPECTED_STL_FILENAMES),
        "body": {
            "path": str(body_path),
            "sha256": sha256_file(body_path),
            "dimensions_mm": body_validation["dimensions_mm"],
            "mesh_validation": body_validation,
            "reload_mesh_validation": body_reload_validation,
            "reload_dimensions_match": True,
            "top_opening_mm": [
                float(key["body"]["expected_top_opening_x"]),
                float(key["body"]["expected_top_opening_y"]),
            ],
            "assembled_height_with_v0_4_cover_mm": float(
                key["body"]["assembled_height_with_cover"]
            ),
            "official_height_limit_mm": float(
                key["body"]["official_height_limit"]
            ),
            "official_size_limit_mm": [
                float(key["body"]["official_limit_x"]),
                float(key["body"]["official_limit_y"]),
                float(key["body"]["official_height_limit"]),
            ],
            "assembled_size_mm": [
                float(key["body"]["assembled_outer_x"]),
                float(key["body"]["assembled_outer_y"]),
                float(key["body"]["assembled_height_with_cover"]),
            ],
            "margin_below_official_limit_mm": [
                float(key["body"]["margin_below_limit_x"]),
                float(key["body"]["margin_below_limit_y"]),
                float(key["body"]["margin_below_height_limit"]),
            ],
            "antenna_exit": {
                "side": "+X",
                "width_y_mm": float(key["antenna"]["slot_width_y"]),
                "bottom_z_mm": float(key["antenna"]["slot_bottom_z"]),
                "top_z_mm": float(key["antenna"]["slot_top_z"]),
            },
            "pcb_support": {
                "mode": str(key["pcb_support_table"]["mode"]),
                "size_mm": [
                    float(key["pcb_support_table"]["x"]),
                    float(key["pcb_support_table"]["y"]),
                    float(key["pcb_support_table"]["height_z"]),
                ],
                "center_xy_mm": [
                    float(key["pcb_support_table"]["center_x"]),
                    float(key["pcb_support_table"]["center_y"]),
                ],
                "top_z_mm": float(key["pcb_support_table"]["top_z"]),
                "height_over_pin_length_mm": float(
                    key["pcb_support_table"]["height_over_pin_length"]
                ),
            },
            "wire_clearance": {
                "dupont_lowest_z_mm": float(
                    key["wire_management"]["dupont_lowest_z"]
                ),
                "dupont_floor_clearance_mm": float(
                    key["wire_management"]["dupont_floor_clearance"]
                ),
                "pin_lowest_z_mm": float(key["wire_management"]["pin_lowest_z"]),
                "pin_floor_clearance_mm": float(
                    key["wire_management"]["pin_floor_clearance"]
                ),
            },
            "internal_layout": {
                "printed_features": ["uwb_pcb_support_pedestal_40x8"],
                "battery_and_regulator_dimensions_known": False,
                "battery_and_regulator_mount_method": "user_hot_melt_glue",
                "battery_and_regulator_printed_supports": False,
                "remaining_cavity": "empty",
            },
        },
        "cover": {
            "mode": "byte_copy_from_v0.4",
            "source_path": str(source_cover),
            "path": str(cover_path),
            "sha256": sha256_file(cover_path),
            "source_sha256": source_hash,
            "hash_locked": True,
            "dimensions_mm": cover_validation["dimensions_mm"],
            "mesh_validation": cover_validation,
            "measured_fit": {
                "skirt_outer_mm": [
                    float(key["cover_v0_4"]["measured_skirt_outer_x"]),
                    float(key["cover_v0_4"]["measured_skirt_outer_y"]),
                ],
                "ordinary_clearance_per_side_mm": [
                    round(
                        (
                            float(key["body"]["expected_top_opening_x"])
                            - float(key["cover_v0_4"]["measured_skirt_outer_x"])
                        )
                        / 2.0,
                        3,
                    ),
                    round(
                        (
                            float(key["body"]["expected_top_opening_y"])
                            - float(key["cover_v0_4"]["measured_skirt_outer_y"])
                        )
                        / 2.0,
                        3,
                    ),
                ],
                "snap_insertion_clearance_y_mm": float(
                    key["snap_fit"]["insertion_clearance_y"]
                ),
                "retention_pad_enabled": bool(
                    key["snap_fit"]["retention_pad_enabled"]
                ),
            },
        },
        "requirements": {
            "exactly_two_stl_files": True,
            "body_no_degenerate_triangles": True,
            "body_no_open_boundary_edges": True,
            "cover_no_degenerate_triangles": True,
            "cover_no_open_boundary_edges": True,
            "single_manifold_required": False,
            "official_key_height_passed": float(
                key["body"]["assembled_height_with_cover"]
            )
            <= float(key["body"]["official_height_limit"]),
            "official_key_size_passed": all(
                actual <= limit
                for actual, limit in zip(
                    (
                        float(key["body"]["assembled_outer_x"]),
                        float(key["body"]["assembled_outer_y"]),
                        float(key["body"]["assembled_height_with_cover"]),
                    ),
                    (
                        float(key["body"]["official_limit_x"]),
                        float(key["body"]["official_limit_y"]),
                        float(key["body"]["official_height_limit"]),
                    ),
                )
            ),
            "at_least_2_mm_size_margin": min(
                float(key["body"]["margin_below_limit_x"]),
                float(key["body"]["margin_below_limit_y"]),
                float(key["body"]["margin_below_height_limit"]),
            )
            >= 2.0,
            "only_uwb_internal_support": True,
            "battery_regulator_supports_absent": True,
            "user_measured_pcb_height_prioritized": True,
        },
        "warnings": [
            "盒体加旧盖的设计总高为 38.0 mm，相对 40 mm 限制保留 2.0 mm 设计余量；打印与装配公差仍需实物确认。",
            "天线槽宽、PCB 厚度和最高器件包络仍为 provisional，软件网格通过不等于实物装配通过。",
            "电池和稳压模块尺寸未知，模型未添加其支架、导轨、定位柱或内部卡扣，需由用户热熔胶固定。",
            "为优先解决旧盖无法插入的问题，v0.6 不设置局部卡扣干涉台，盖子可能较松。",
        ],
    }
    report_path = output / VALIDATION_REPORT_FILENAME
    _write_report(report_path, report)
    return {"output": output, "report_path": report_path, "report": report}


def validate_existing(key: dict[str, Any], output: Path) -> dict[str, Any]:
    """Validate an already generated two-STL delivery without rewriting it."""

    assertions = assert_parameter_contract(key)
    _strict_stl_inventory(output)
    body = load_binary_stl(output / BODY_FILENAME, BODY_FILENAME)
    body_validation = validate_mesh(
        body,
        expected_dimensions=[
            float(key["body"]["outer_x"]),
            float(key["body"]["outer_y"]),
            float(key["body"]["height"]),
        ],
    )
    cover_path = output / COVER_FILENAME
    cover_hash = sha256_file(cover_path)
    if cover_hash != EXPECTED_COVER_SHA256:
        raise RuntimeError("output v0.4 cover no longer matches the locked SHA-256")
    cover_validation = validate_mesh(load_binary_stl(cover_path, COVER_FILENAME))
    return {
        "ok": True,
        "output": str(output),
        "parameter_assertions": assertions,
        "body": body_validation,
        "cover": {"sha256": cover_hash, "mesh_validation": cover_validation},
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--validate-only", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    key = load_parameters(args.config)
    result = (
        validate_existing(key, args.output)
        if args.validate_only
        else generate(key, args.output)
    )
    print(json.dumps({"ok": True, **result}, ensure_ascii=False, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
