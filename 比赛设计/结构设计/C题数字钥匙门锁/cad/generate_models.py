#!/usr/bin/env python3
"""Generate the C-problem key shell and modular lock frame.

The source dimensions live in parameters.json.  Generated STL files are trial
parts until the remaining printer and connector measurements are confirmed.
"""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import re
from typing import Any, Iterable

import numpy as np

from meshlib import (
    Mesh,
    SceneObject,
    box,
    convex_prism,
    cylinder,
    edge_count_validation,
    export_binary_stl,
    load_binary_stl,
    merge,
    render_scene,
    ring_sector,
    u_channel,
)


PLA_DENSITY_G_PER_CM3 = 1.24
MODEL_STATUS = "v0.1 试装版"


def load_config(path: Path) -> dict[str, Any]:
    config = json.loads(path.read_text(encoding="utf-8"))
    if config.get("units") != "mm":
        raise ValueError("parameters.json must use millimetres")
    return config


def require_positive(config: dict[str, Any], paths: Iterable[tuple[str, ...]]) -> None:
    for path in paths:
        value: Any = config
        for key in path:
            value = value[key]
        if not isinstance(value, (int, float)) or value <= 0:
            raise ValueError(f"{'.'.join(path)} must be a positive number")


def validate_config(config: dict[str, Any]) -> None:
    require_positive(
        config,
        [
            ("printer", "bed_x"),
            ("printer", "bed_y"),
            ("manufacturing", "wall"),
            ("manufacturing", "clearance_xy"),
            ("official_envelope", "key_x"),
            ("official_envelope", "lock_diameter"),
            ("uwb", "board_x"),
            ("uwb", "board_y"),
            ("key_battery", "x"),
            ("lock_battery", "x"),
            ("vehicle_pcb", "x"),
            ("display", "board_x"),
            ("display", "board_y"),
            ("dip_switch", "x"),
            ("lock_structure", "zero_ring_outer_radius"),
        ],
    )
    official = config["official_envelope"]
    key = config["key_shell"]
    if key["outer_x"] > official["key_x"]:
        raise ValueError("key shell exceeds official X limit")
    if key["outer_y"] > official["key_y"]:
        raise ValueError("key shell exceeds official Y limit")
    if key["outer_z"] > official["key_z"]:
        raise ValueError("key shell exceeds official Z limit")
    lock = config["lock_structure"]
    if 2.0 * lock["zero_ring_outer_radius"] > official["lock_diameter"]:
        raise ValueError("zero ring exceeds official lock diameter")
    if lock["electronics_tray_z"] > official["lock_height"]:
        raise ValueError("electronics tray exceeds official lock height")
    if config["display"]["visible_x"] > config["display"]["board_x"]:
        raise ValueError("display visible X cannot exceed display board X")
    if config["display"]["visible_y"] > config["display"]["board_y"]:
        raise ValueError("display visible Y cannot exceed display board Y")


def segmented_end_wall(
    name: str,
    x_center: float,
    outer_y: float,
    wall: float,
    wall_height: float,
    floor: float,
    opening_y: float,
    opening_z: float,
) -> Mesh:
    side_width = (outer_y - opening_y) / 2.0
    if side_width <= wall or floor + opening_z >= wall_height:
        raise ValueError(f"{name}: end-wall opening is too large")
    top_height = wall_height - floor - opening_z
    pieces = [
        box(
            f"{name}_left",
            (wall, side_width, wall_height),
            (x_center, -(opening_y + side_width) / 2.0, wall_height / 2.0),
        ),
        box(
            f"{name}_right",
            (wall, side_width, wall_height),
            (x_center, (opening_y + side_width) / 2.0, wall_height / 2.0),
        ),
        box(
            f"{name}_top",
            (wall, opening_y, top_height),
            (x_center, 0.0, floor + opening_z + top_height / 2.0),
        ),
    ]
    return merge(name, pieces)


def corner_stops(
    name: str,
    footprint_x: float,
    footprint_y: float,
    center_x: float,
    center_y: float,
    base_z: float,
    height: float,
    post: float = 3.2,
    clearance: float = 0.35,
) -> Mesh:
    pieces: list[Mesh] = []
    for x_sign in (-1.0, 1.0):
        for y_sign in (-1.0, 1.0):
            pieces.append(
                box(
                    f"{name}_{int(x_sign)}_{int(y_sign)}",
                    (post, post, height),
                    (
                        center_x + x_sign * (footprint_x / 2.0 + clearance + post / 2.0),
                        center_y + y_sign * (footprint_y / 2.0 + clearance + post / 2.0),
                        base_z + height / 2.0,
                    ),
                )
            )
    return merge(name, pieces)


def bridge_clip(
    name: str,
    span: float,
    internal_height: float,
    depth: float,
    wall: float,
    clearance: float,
) -> Mesh:
    inner_span = span + 2.0 * clearance
    outer_span = inner_span + 2.0 * wall
    leg_height = internal_height + clearance
    return merge(
        name,
        [
            box(f"{name}_bridge", (depth, outer_span, wall), (0.0, 0.0, wall / 2.0)),
            box(
                f"{name}_left",
                (depth, wall, leg_height),
                (0.0, -outer_span / 2.0 + wall / 2.0, wall + leg_height / 2.0),
            ),
            box(
                f"{name}_right",
                (depth, wall, leg_height),
                (0.0, outer_span / 2.0 - wall / 2.0, wall + leg_height / 2.0),
            ),
        ],
    ).centered_for_print(name)


def rectangular_frame(
    name: str,
    outer_x: float,
    outer_y: float,
    inner_x: float,
    inner_y: float,
    thickness_z: float,
) -> Mesh:
    if not (outer_x > inner_x > 0 and outer_y > inner_y > 0):
        raise ValueError(f"{name}: invalid frame dimensions")
    side_x = (outer_x - inner_x) / 2.0
    side_y = (outer_y - inner_y) / 2.0
    return merge(
        name,
        [
            box(
                f"{name}_left",
                (side_x, outer_y, thickness_z),
                (-(inner_x + side_x) / 2.0, 0.0, thickness_z / 2.0),
            ),
            box(
                f"{name}_right",
                (side_x, outer_y, thickness_z),
                ((inner_x + side_x) / 2.0, 0.0, thickness_z / 2.0),
            ),
            box(
                f"{name}_bottom",
                (inner_x, side_y, thickness_z),
                (0.0, -(inner_y + side_y) / 2.0, thickness_z / 2.0),
            ),
            box(
                f"{name}_top",
                (inner_x, side_y, thickness_z),
                (0.0, (inner_y + side_y) / 2.0, thickness_z / 2.0),
            ),
        ],
    )


def tiled_panel(
    name: str,
    outer_x: float,
    outer_y: float,
    thickness_z: float,
    holes: list[tuple[float, float, float, float]],
) -> Mesh:
    x_values = {-outer_x / 2.0, outer_x / 2.0}
    y_values = {-outer_y / 2.0, outer_y / 2.0}
    for center_x, center_y, hole_x, hole_y in holes:
        x_values.update((center_x - hole_x / 2.0, center_x + hole_x / 2.0))
        y_values.update((center_y - hole_y / 2.0, center_y + hole_y / 2.0))
    sorted_x = sorted(x_values)
    sorted_y = sorted(y_values)
    width_count = len(sorted_x) - 1
    height_count = len(sorted_y) - 1
    occupied = [[False for _ in range(height_count)] for _ in range(width_count)]
    for x_index, (x_start, x_end) in enumerate(zip(sorted_x, sorted_x[1:])):
        for y_index, (y_start, y_end) in enumerate(zip(sorted_y, sorted_y[1:])):
            center_x = (x_start + x_end) / 2.0
            center_y = (y_start + y_end) / 2.0
            occupied[x_index][y_index] = not any(
                abs(center_x - hole_center_x) < hole_x / 2.0
                and abs(center_y - hole_center_y) < hole_y / 2.0
                for hole_center_x, hole_center_y, hole_x, hole_y in holes
            )

    vertices: list[list[float]] = []
    vertex_ids: dict[tuple[int, int, int], int] = {}
    faces: list[list[int]] = []

    def vertex(x_index: int, y_index: int, top: int) -> int:
        key = (x_index, y_index, top)
        if key not in vertex_ids:
            vertex_ids[key] = len(vertices)
            vertices.append(
                [
                    float(sorted_x[x_index]),
                    float(sorted_y[y_index]),
                    float(thickness_z if top else 0.0),
                ]
            )
        return vertex_ids[key]

    for x_index in range(width_count):
        for y_index in range(height_count):
            if not occupied[x_index][y_index]:
                continue
            bottom_00 = vertex(x_index, y_index, 0)
            bottom_10 = vertex(x_index + 1, y_index, 0)
            bottom_11 = vertex(x_index + 1, y_index + 1, 0)
            bottom_01 = vertex(x_index, y_index + 1, 0)
            top_00 = vertex(x_index, y_index, 1)
            top_10 = vertex(x_index + 1, y_index, 1)
            top_11 = vertex(x_index + 1, y_index + 1, 1)
            top_01 = vertex(x_index, y_index + 1, 1)

            faces.extend(
                [
                    [bottom_00, bottom_11, bottom_10],
                    [bottom_00, bottom_01, bottom_11],
                    [top_00, top_10, top_11],
                    [top_00, top_11, top_01],
                ]
            )
            if x_index == 0 or not occupied[x_index - 1][y_index]:
                faces.extend(
                    [
                        [bottom_00, top_01, bottom_01],
                        [bottom_00, top_00, top_01],
                    ]
                )
            if x_index == width_count - 1 or not occupied[x_index + 1][y_index]:
                faces.extend(
                    [
                        [bottom_10, bottom_11, top_11],
                        [bottom_10, top_11, top_10],
                    ]
                )
            if y_index == 0 or not occupied[x_index][y_index - 1]:
                faces.extend(
                    [
                        [bottom_00, bottom_10, top_10],
                        [bottom_00, top_10, top_00],
                    ]
                )
            if y_index == height_count - 1 or not occupied[x_index][y_index + 1]:
                faces.extend(
                    [
                        [bottom_01, top_11, bottom_11],
                        [bottom_01, top_01, top_11],
                    ]
                )

    if not faces:
        raise ValueError(f"{name}: holes removed the entire panel")
    return Mesh(name, np.asarray(vertices), np.asarray(faces))


def build_key_base(config: dict[str, Any]) -> Mesh:
    key = config["key_shell"]
    manufacturing = config["manufacturing"]
    uwb = config["uwb"]
    battery = config["key_battery"]
    outer_x, outer_y, outer_z = key["outer_x"], key["outer_y"], key["outer_z"]
    wall, floor = manufacturing["wall"], manufacturing["floor"]
    base_height = outer_z - key["lid_z"]
    clearance = manufacturing["clearance_xy"]
    pieces: list[Mesh] = [
        box("key_floor", (outer_x, outer_y, floor), (0.0, 0.0, floor / 2.0)),
        box(
            "key_side_left",
            (outer_x, wall, base_height),
            (0.0, -(outer_y - wall) / 2.0, base_height / 2.0),
        ),
        box(
            "key_side_right",
            (outer_x, wall, base_height),
            (0.0, (outer_y - wall) / 2.0, base_height / 2.0),
        ),
        segmented_end_wall(
            "key_type_c_wall",
            (outer_x - wall) / 2.0,
            outer_y,
            wall,
            base_height,
            floor,
            uwb["type_c_opening_x"],
            uwb["type_c_opening_z"],
        ),
        segmented_end_wall(
            "key_service_wall",
            -(outer_x - wall) / 2.0,
            outer_y,
            wall,
            base_height,
            floor,
            key["service_window_x"],
            key["service_window_z"],
        ),
    ]
    battery_center_x = -17.0
    uwb_center_x = 29.0
    pieces.extend(
        [
            corner_stops(
                "key_battery_stops",
                battery["x"],
                battery["y"],
                battery_center_x,
                0.0,
                floor,
                7.0,
                clearance=clearance,
            ),
            corner_stops(
                "key_uwb_stops",
                uwb["board_x"],
                uwb["board_y"],
                uwb_center_x,
                0.0,
                floor,
                10.0,
                clearance=clearance,
            ),
            box("key_divider", (1.8, outer_y - 2.0 * wall - 4.0, 8.0), (8.0, 0.0, floor + 4.0)),
        ]
    )
    return merge("key_base", pieces).centered_for_print("key_base")


def build_key_lid(config: dict[str, Any]) -> Mesh:
    key = config["key_shell"]
    manufacturing = config["manufacturing"]
    lid_z = key["lid_z"]
    clearance = manufacturing["clearance_xy"]
    clip_wall = manufacturing["clip_wall"]
    lid_x = key["outer_x"] - 0.5
    inner_y = key["outer_y"] + 2.0 * clearance
    outer_y = inner_y + 2.0 * clip_wall
    flange_height = 4.0
    pieces = [
        box("key_lid_plate", (lid_x, outer_y, lid_z), (0.0, 0.0, lid_z / 2.0)),
        box(
            "key_lid_left_flange",
            (lid_x, clip_wall, flange_height),
            (0.0, -outer_y / 2.0 + clip_wall / 2.0, lid_z + flange_height / 2.0),
        ),
        box(
            "key_lid_right_flange",
            (lid_x, clip_wall, flange_height),
            (0.0, outer_y / 2.0 - clip_wall / 2.0, lid_z + flange_height / 2.0),
        ),
        box(
            "key_lid_front_stop",
            (clip_wall, inner_y, flange_height),
            (lid_x / 2.0 - clip_wall / 2.0, 0.0, lid_z + flange_height / 2.0),
        ),
        box("key_lid_latch_left", (3.0, 1.1, 1.2), (-lid_x / 2.0 + 9.0, -inner_y / 2.0, lid_z + 2.0)),
        box("key_lid_latch_right", (3.0, 1.1, 1.2), (-lid_x / 2.0 + 9.0, inner_y / 2.0, lid_z + 2.0)),
    ]
    return merge("key_sliding_lid", pieces).centered_for_print("key_sliding_lid")


def build_key_ref_marker() -> Mesh:
    return merge(
        "key_ref_marker",
        [
            cylinder("key_ref_disc", 4.0, 1.2, 40, (0.0, 0.0, 0.6)),
            box("key_ref_cross_x", (11.0, 1.5, 1.2), (0.0, 0.0, 0.6)),
            box("key_ref_cross_y", (1.5, 11.0, 1.2), (0.0, 0.0, 0.6)),
        ],
    ).centered_for_print("key_ref_marker")


def build_frame_hub(config: dict[str, Any]) -> Mesh:
    structure = config["lock_structure"]
    manufacturing = config["manufacturing"]
    hub_radius = structure["hub_radius"]
    hub_z = structure["hub_z"]
    beam_wall = structure["beam_wall"]
    beam_z = structure["beam_z"]
    channel_width = structure["beam_outer_y"] - 2.0 * beam_wall
    tongue_width = channel_width - 2.0 * manufacturing["clearance_xy"]
    tongue_height = beam_z - beam_wall - 1.2
    tongue_bottom = hub_z + beam_wall + 0.2
    pieces: list[Mesh] = [cylinder("hub_disc", hub_radius, hub_z, 72, (0.0, 0.0, hub_z / 2.0))]
    for anchor in config["anchors"]:
        angle = math.degrees(math.atan2(anchor["y"], anchor["x"]))
        tongue = box(
            f"hub_tongue_{anchor['id']}",
            (36.0, tongue_width, tongue_height),
            (hub_radius + 14.0, 0.0, tongue_bottom + tongue_height / 2.0),
        ).rotated_z(angle)
        pieces.append(tongue)
    pieces.extend(
        [
            box("front_arrow_shaft", (8.0, 28.0, 2.0), (0.0, 42.0, hub_z + 1.0)),
            convex_prism(
                "front_arrow_head",
                [(-12.0, 53.0), (12.0, 53.0), (0.0, 70.0)],
                2.0,
                hub_z + 1.0,
            ),
        ]
    )
    return merge("frame_hub", pieces).centered_for_print("frame_hub")


def build_beam_segment(config: dict[str, Any], length: float, name: str) -> Mesh:
    structure = config["lock_structure"]
    return u_channel(
        name,
        length,
        structure["beam_outer_y"],
        structure["beam_z"],
        structure["beam_wall"],
    ).centered_for_print(name)


def build_beam_joiner_key(config: dict[str, Any]) -> Mesh:
    structure = config["lock_structure"]
    manufacturing = config["manufacturing"]
    channel_width = structure["beam_outer_y"] - 2.0 * structure["beam_wall"]
    return box(
        "beam_joiner_key",
        (
            30.0,
            channel_width - 2.0 * manufacturing["clearance_xy"],
            structure["beam_z"] - structure["beam_wall"] - 1.2,
        ),
        (0.0, 0.0, (structure["beam_z"] - structure["beam_wall"] - 1.2) / 2.0),
    ).centered_for_print("beam_joiner_key")


def build_beam_lock_clip(config: dict[str, Any]) -> Mesh:
    structure = config["lock_structure"]
    manufacturing = config["manufacturing"]
    length = 24.0
    clearance = manufacturing["clearance_xy"]
    wall = manufacturing["clip_wall"]
    inner_width = structure["beam_outer_y"] + 2.0 * clearance
    outer_width = inner_width + 2.0 * wall
    leg_height = structure["beam_z"] + manufacturing["clearance_z"]
    return merge(
        "beam_lock_clip",
        [
            box("beam_clip_bridge", (length, outer_width, wall), (0.0, 0.0, wall / 2.0)),
            box(
                "beam_clip_left",
                (length, wall, leg_height),
                (0.0, -outer_width / 2.0 + wall / 2.0, wall + leg_height / 2.0),
            ),
            box(
                "beam_clip_right",
                (length, wall, leg_height),
                (0.0, outer_width / 2.0 - wall / 2.0, wall + leg_height / 2.0),
            ),
        ],
    ).centered_for_print("beam_lock_clip")


def build_anchor_pod(config: dict[str, Any], yaw_deg: float) -> tuple[Mesh, Mesh]:
    structure = config["lock_structure"]
    manufacturing = config["manufacturing"]
    uwb = config["uwb"]
    beam_wall = structure["beam_wall"]
    channel_width = structure["beam_outer_y"] - 2.0 * beam_wall
    tongue_width = channel_width - 2.0 * manufacturing["clearance_xy"]
    tongue_height = structure["beam_z"] - beam_wall - 1.2
    global_pod_bottom = structure["hub_z"] + beam_wall + 0.2
    reference_local_z = structure["anchor_reference_z"] - global_pod_bottom
    tray_top_z = reference_local_z - uwb["assembly_z"] / 2.0
    tray_thickness = manufacturing["wall"]
    tray_outer_x = uwb["board_x"] + 2.0 * (manufacturing["clearance_xy"] + 2.5)
    tray_outer_y = uwb["board_y"] + 2.0 * (manufacturing["clearance_xy"] + 2.5)
    base_top = tongue_height + 3.0
    tray_bottom = tray_top_z - tray_thickness
    leg_height = tray_bottom - base_top
    if leg_height <= 5.0:
        raise ValueError("anchor pod has insufficient riser height")
    fixed_pieces: list[Mesh] = [
        box("pod_tongue", (32.0, tongue_width, tongue_height), (-16.0, 0.0, tongue_height / 2.0)),
        box("pod_base", (42.0, 34.0, 3.0), (0.0, 0.0, tongue_height + 1.5)),
    ]
    rotating_pieces: list[Mesh] = [
        box("pod_tray", (tray_outer_x, tray_outer_y, tray_thickness), (0.0, 0.0, tray_top_z - tray_thickness / 2.0)),
        box(
            "pod_leg_left",
            (4.5, 4.5, leg_height),
            (-tray_outer_x / 2.0 + 3.5, 0.0, base_top + leg_height / 2.0),
        ),
        box(
            "pod_leg_right",
            (4.5, 4.5, leg_height),
            (tray_outer_x / 2.0 - 3.5, 0.0, base_top + leg_height / 2.0),
        ),
        box(
            "pod_rear_lip",
            (2.5, tray_outer_y, 4.5),
            (-tray_outer_x / 2.0 + 1.25, 0.0, tray_top_z + 2.25),
        ),
        box(
            "pod_side_lip_left",
            (tray_outer_x - 4.0, 2.5, 4.5),
            (1.0, -tray_outer_y / 2.0 + 1.25, tray_top_z + 2.25),
        ),
        box(
            "pod_side_lip_right",
            (tray_outer_x - 4.0, 2.5, 4.5),
            (1.0, tray_outer_y / 2.0 - 1.25, tray_top_z + 2.25),
        ),
    ]
    rotated = [piece.rotated_z(yaw_deg) for piece in rotating_pieces]
    pod_name = f"anchor_pod_{int(round(yaw_deg)):02d}deg"
    pod = merge(pod_name, [*fixed_pieces, *rotated]).centered_for_print(pod_name)
    placeholder = box(
        f"uwb_placeholder_{int(round(yaw_deg)):02d}",
        (uwb["board_x"], uwb["board_y"], uwb["assembly_z"]),
        (0.0, 0.0, reference_local_z),
    ).rotated_z(yaw_deg)
    return pod, placeholder


def build_zero_ring_segment(config: dict[str, Any]) -> Mesh:
    structure = config["lock_structure"]
    angle = structure["zero_ring_segment_deg"]
    segment = ring_sector(
        "zero_ring_segment",
        structure["zero_ring_outer_radius"],
        structure["zero_ring_inner_radius"],
        structure["zero_ring_z"],
        -angle / 2.0,
        angle / 2.0,
        max(12, int(angle)),
        (0.0, 0.0, structure["zero_ring_z"] / 2.0),
    )
    return segment.centered_for_print("zero_ring_segment")


def build_zero_ring_joiner(config: dict[str, Any]) -> Mesh:
    structure = config["lock_structure"]
    manufacturing = config["manufacturing"]
    radial_width = structure["zero_ring_outer_radius"] - structure["zero_ring_inner_radius"]
    clearance = manufacturing["clearance_xy"]
    wall = manufacturing["clip_wall"]
    inner_width = radial_width + 2.0 * clearance
    outer_width = inner_width + 2.0 * wall
    leg_height = structure["zero_ring_z"] + manufacturing["clearance_z"]
    length = 28.0
    return merge(
        "zero_ring_joiner",
        [
            box("ring_joiner_bridge", (length, outer_width, wall), (0.0, 0.0, wall / 2.0)),
            box(
                "ring_joiner_left",
                (length, wall, leg_height),
                (0.0, -outer_width / 2.0 + wall / 2.0, wall + leg_height / 2.0),
            ),
            box(
                "ring_joiner_right",
                (length, wall, leg_height),
                (0.0, outer_width / 2.0 - wall / 2.0, wall + leg_height / 2.0),
            ),
        ],
    ).centered_for_print("zero_ring_joiner")


def build_electronics_tray(config: dict[str, Any]) -> Mesh:
    structure = config["lock_structure"]
    manufacturing = config["manufacturing"]
    pcb = config["vehicle_pcb"]
    battery = config["lock_battery"]
    outer_x = structure["electronics_tray_x"]
    outer_y = structure["electronics_tray_y"]
    outer_z = structure["electronics_tray_z"]
    floor = manufacturing["floor"]
    wall = manufacturing["wall"]
    base_height = outer_z - 2.8
    clearance = manufacturing["clearance_xy"]
    pieces: list[Mesh] = [
        box("tray_floor", (outer_x, outer_y, floor), (0.0, 0.0, floor / 2.0)),
        box("tray_left", (wall, outer_y, base_height), (-(outer_x - wall) / 2.0, 0.0, base_height / 2.0)),
        box("tray_right", (wall, outer_y, base_height), ((outer_x - wall) / 2.0, 0.0, base_height / 2.0)),
        box("tray_front", (outer_x - 2.0 * wall, wall, base_height), (0.0, (outer_y - wall) / 2.0, base_height / 2.0)),
        box("tray_rear_lip", (outer_x - 2.0 * wall, wall, 12.0), (0.0, -(outer_y - wall) / 2.0, 6.0)),
        box("tray_divider", (120.0, 2.0, 11.0), (0.0, 0.0, floor + 5.5)),
        corner_stops("tray_pcb_stops", pcb["x"], pcb["y"], 0.0, 31.0, floor, 12.0, clearance=clearance),
        corner_stops("tray_battery_stops", battery["x"], battery["y"], 0.0, -31.0, floor, 24.0, clearance=clearance),
    ]
    panel_thickness = structure["rear_panel_z"]
    guide_gap = panel_thickness + 2.0 * clearance
    for x_sign in (-1.0, 1.0):
        x_center = x_sign * (outer_x / 2.0 - 5.0)
        for y_offset in (-guide_gap / 2.0 - 1.2, guide_gap / 2.0 + 1.2):
            pieces.append(
                box(
                    f"tray_panel_guide_{x_sign}_{y_offset}",
                    (6.0, 2.4, base_height - 6.0),
                    (x_center, -outer_y / 2.0 + y_offset, (base_height - 6.0) / 2.0 + 3.0),
                )
            )
    return merge("lock_electronics_tray", pieces).centered_for_print("lock_electronics_tray")


def build_electronics_cover(config: dict[str, Any]) -> Mesh:
    structure = config["lock_structure"]
    manufacturing = config["manufacturing"]
    outer_x = structure["electronics_tray_x"] - 0.6
    inner_y = structure["electronics_tray_y"] + 2.0 * manufacturing["clearance_xy"]
    wall = manufacturing["clip_wall"]
    outer_y = inner_y + 2.0 * wall
    cover_z = 2.8
    flange_height = 5.0
    pieces = [
        box("tray_cover_plate", (outer_x, outer_y, cover_z), (0.0, 0.0, cover_z / 2.0)),
        box(
            "tray_cover_left",
            (outer_x, wall, flange_height),
            (0.0, -outer_y / 2.0 + wall / 2.0, cover_z + flange_height / 2.0),
        ),
        box(
            "tray_cover_right",
            (outer_x, wall, flange_height),
            (0.0, outer_y / 2.0 - wall / 2.0, cover_z + flange_height / 2.0),
        ),
        box(
            "tray_cover_front_stop",
            (wall, inner_y, flange_height),
            (outer_x / 2.0 - wall / 2.0, 0.0, cover_z + flange_height / 2.0),
        ),
    ]
    return merge("lock_electronics_cover", pieces).centered_for_print("lock_electronics_cover")


def control_layout(config: dict[str, Any]) -> dict[str, tuple[float, float, float, float]]:
    display = config["display"]
    dip = config["dip_switch"]
    controls = config["controls"]
    return {
        "display": (-34.0, 0.0, display["visible_x"] + 0.8, display["visible_y"] + 0.8),
        "dip": (22.0, 8.0, dip["x"] + dip["panel_clearance"], dip["y"] + dip["panel_clearance"]),
        "lock_led": (47.0, 10.0, controls["lock_led_diameter"] + 0.6, controls["lock_led_diameter"] + 0.6),
        "unlock_led": (63.0, 10.0, controls["lock_led_diameter"] + 0.6, controls["lock_led_diameter"] + 0.6),
        "welcome_led": (47.0, -9.0, controls["welcome_led_diameter"] + 0.6, controls["welcome_led_diameter"] + 0.6),
        "debug": (63.0, -10.0, controls["debug_opening_x"], controls["debug_opening_y"]),
    }


def build_rear_panel(config: dict[str, Any]) -> Mesh:
    structure = config["lock_structure"]
    panel_x = structure["electronics_tray_x"] - 4.0
    panel_y = min(structure["electronics_tray_z"] - 6.0, 64.0)
    holes = list(control_layout(config).values())
    return tiled_panel("lock_rear_panel", panel_x, panel_y, structure["rear_panel_z"], holes).centered_for_print(
        "lock_rear_panel"
    )


def build_display_cassette(config: dict[str, Any]) -> Mesh:
    display = config["display"]
    manufacturing = config["manufacturing"]
    clearance = manufacturing["clearance_xy"]
    frame_wall = 3.0
    outer_x = display["board_x"] + 2.0 * (clearance + frame_wall)
    outer_y = display["board_y"] + 2.0 * (clearance + frame_wall)
    inner_x = display["board_x"] + 2.0 * clearance
    inner_y = display["board_y"] + 2.0 * clearance
    frame = rectangular_frame("display_cassette_frame", outer_x, outer_y, inner_x, inner_y, 3.0)
    clips = [
        box("display_clip_left", (5.0, 8.0, 5.0), (-outer_x / 2.0 + 2.5, 0.0, 5.5)),
        box("display_clip_right", (5.0, 8.0, 5.0), (outer_x / 2.0 - 2.5, 0.0, 5.5)),
        box("display_clip_bottom", (8.0, 5.0, 5.0), (0.0, -outer_y / 2.0 + 2.5, 5.5)),
        box("display_clip_top", (8.0, 5.0, 5.0), (0.0, outer_y / 2.0 - 2.5, 5.5)),
    ]
    return merge("display_quick_cassette", [frame, *clips]).centered_for_print("display_quick_cassette")


def build_display_bezel(config: dict[str, Any]) -> Mesh:
    display = config["display"]
    outer_x = display["visible_x"] + 10.0
    outer_y = display["visible_y"] + 10.0
    return rectangular_frame(
        "display_replaceable_bezel",
        outer_x,
        outer_y,
        display["visible_x"],
        display["visible_y"],
        2.0,
    ).centered_for_print("display_replaceable_bezel")


def beam_segment_plan(config: dict[str, Any]) -> tuple[dict[float, int], dict[str, list[float]]]:
    structure = config["lock_structure"]
    counts: Counter[float] = Counter()
    per_anchor: dict[str, list[float]] = {}
    for anchor in config["anchors"]:
        radius = math.hypot(anchor["x"], anchor["y"])
        remaining = radius - structure["hub_radius"]
        segment_count = max(1, math.ceil(remaining / structure["maximum_beam_segment"]))
        segment_length = remaining / segment_count
        rounded = round(segment_length, 3)
        counts[rounded] += segment_count
        per_anchor[anchor["id"]] = [segment_length] * segment_count
    return dict(counts), per_anchor


def safe_part_name(prefix: str, length: float) -> str:
    length_text = f"{length:.1f}".replace(".", "p")
    return f"{prefix}_{length_text}mm"


def build_parts(config: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], dict[str, list[float]]]:
    manufacturing = config["manufacturing"]
    parts: dict[str, dict[str, Any]] = {}

    def add(name: str, mesh: Mesh, quantity: int, note: str) -> None:
        parts[name] = {"mesh": mesh, "quantity": quantity, "note": note}

    add("key_base", build_key_base(config), 1, "钥匙底壳，Type-C 端与维护端均留开口")
    add("key_sliding_lid", build_key_lid(config), 1, "滑入式快拆盖")
    add("key_ref_marker", build_key_ref_marker(), 1, "粘接或热熔固定在 UWB 天线参考点上方")
    add(
        "key_battery_clip",
        bridge_clip(
            "key_battery_clip",
            config["key_battery"]["y"],
            config["key_battery"]["z"],
            9.0,
            manufacturing["clip_wall"],
            manufacturing["clearance_xy"],
        ),
        1,
        "电池可拆压桥",
    )
    add("frame_hub", build_frame_hub(config), 1, "中心 O 与 FRONT 箭头基准")
    beam_counts, per_anchor = beam_segment_plan(config)
    for length, quantity in sorted(beam_counts.items()):
        name = safe_part_name("beam_segment", length)
        add(name, build_beam_segment(config, length, name), quantity, "U 型走线梁，同长度互换")
    connection_count = sum(len(lengths) + 1 for lengths in per_anchor.values())
    add("beam_joiner_key", build_beam_joiner_key(config), connection_count + 1, "内插键，多打印 1 个备件")
    add("beam_lock_clip", build_beam_lock_clip(config), connection_count + 1, "外滑锁扣，多打印 1 个备件")
    for yaw in (0.0, 15.0, 30.0, 45.0):
        pod, _ = build_anchor_pod(config, yaw)
        quantity = 3 if yaw == 0.0 else 1
        add(pod.name, pod, quantity, "0° 为三节点首版；其他角度用于单节点替换试验")
    segment_count = int(round(360.0 / config["lock_structure"]["zero_ring_segment_deg"]))
    add("zero_ring_segment", build_zero_ring_segment(config), segment_count, "596 mm 外径零点环分段")
    add("zero_ring_joiner", build_zero_ring_joiner(config), segment_count + 1, "零点环快拆夹，多打印 1 个备件")
    add("lock_electronics_tray", build_electronics_tray(config), 1, "主控与门锁电池前后分仓")
    add("lock_electronics_cover", build_electronics_cover(config), 1, "中央舱滑盖")
    add("lock_rear_panel", build_rear_panel(config), 1, "背面显示、拨码、LED 与调试口面板")
    add("display_quick_cassette", build_display_cassette(config), 1, "84×50 mm 屏幕边缘夹持卡匣")
    add("display_replaceable_bezel", build_display_bezel(config), 1, "可视区变化时只重打此前框")
    add(
        "lock_battery_clip",
        bridge_clip(
            "lock_battery_clip",
            config["lock_battery"]["y"],
            config["lock_battery"]["z"],
            12.0,
            manufacturing["clip_wall"],
            manufacturing["clearance_xy"],
        ),
        2,
        "门锁电池组双压桥",
    )
    return parts, per_anchor


def assembly_lock_scene(config: dict[str, Any], per_anchor: dict[str, list[float]]) -> list[SceneObject]:
    structure = config["lock_structure"]
    manufacturing = config["manufacturing"]
    objects: list[SceneObject] = []
    segment_angle = structure["zero_ring_segment_deg"]
    segment_count = int(round(360.0 / segment_angle))
    for index in range(segment_count):
        start = index * segment_angle - segment_angle / 2.0
        end = index * segment_angle + segment_angle / 2.0
        segment = ring_sector(
            f"ring_{index}",
            structure["zero_ring_outer_radius"],
            structure["zero_ring_inner_radius"],
            structure["zero_ring_z"],
            start,
            end,
            max(12, int(segment_angle)),
            (0.0, 0.0, structure["zero_ring_z"] / 2.0),
        )
        objects.append(SceneObject(segment, (58, 75, 95)))
    hub = build_frame_hub(config)
    hub_offset = -hub.minimum[2]
    objects.append(SceneObject(hub.translated((0.0, 0.0, -hub_offset)), (238, 146, 54)))

    beam_global_z = structure["hub_z"]
    pod_global_z = structure["hub_z"] + structure["beam_wall"] + 0.2
    for anchor in config["anchors"]:
        angle = math.degrees(math.atan2(anchor["y"], anchor["x"]))
        direction_x = math.cos(math.radians(angle))
        direction_y = math.sin(math.radians(angle))
        cursor = structure["hub_radius"]
        for segment_length in per_anchor[anchor["id"]]:
            name = safe_part_name("beam_scene", segment_length)
            segment = build_beam_segment(config, segment_length, name)
            segment = segment.rotated_z(angle).translated(
                (
                    direction_x * (cursor + segment_length / 2.0),
                    direction_y * (cursor + segment_length / 2.0),
                    beam_global_z,
                )
            )
            objects.append(SceneObject(segment, (82, 126, 166)))
            cursor += segment_length
        pod, placeholder = build_anchor_pod(config, anchor["yaw_deg"])
        pod = pod.rotated_z(angle).translated((anchor["x"], anchor["y"], pod_global_z))
        placeholder = placeholder.rotated_z(angle).translated((anchor["x"], anchor["y"], pod_global_z))
        objects.append(SceneObject(pod, (232, 174, 74)))
        objects.append(SceneObject(placeholder, (45, 151, 104)))

    tray_base_z = structure["hub_z"] + structure["beam_z"]
    tray = build_electronics_tray(config).translated((0.0, 0.0, tray_base_z))
    objects.append(SceneObject(tray, (188, 196, 207)))
    pcb = config["vehicle_pcb"]
    battery = config["lock_battery"]
    pcb_placeholder = box(
        "pcb_placeholder",
        (pcb["x"], pcb["y"], pcb["assembly_z"]),
        (0.0, 31.0, tray_base_z + config["manufacturing"]["floor"] + pcb["assembly_z"] / 2.0),
    )
    battery_placeholder = box(
        "lock_battery_placeholder",
        (battery["x"], battery["y"], battery["z"]),
        (0.0, -31.0, tray_base_z + config["manufacturing"]["floor"] + battery["z"] / 2.0),
    )
    objects.append(SceneObject(pcb_placeholder, (95, 77, 166)))
    objects.append(SceneObject(battery_placeholder, (221, 118, 43)))

    panel_height = min(structure["electronics_tray_z"] - 6.0, 64.0)
    panel = build_rear_panel(config).rotated_x(90.0).translated(
        (0.0, -structure["electronics_tray_y"] / 2.0, tray_base_z + panel_height / 2.0)
    )
    objects.append(SceneObject(panel, (60, 67, 76)))
    display = config["display"]
    display_board = box(
        "display_board_placeholder",
        (display["board_x"], display["board_y"], 2.0),
        (-34.0, 0.0, 1.0),
    ).rotated_x(90.0).translated(
        (0.0, -structure["electronics_tray_y"] / 2.0 + 5.0, tray_base_z + panel_height / 2.0)
    )
    objects.append(SceneObject(display_board, (35, 111, 155)))
    cover = build_electronics_cover(config).rotated_x(180.0).translated(
        (0.0, 0.0, tray_base_z + structure["electronics_tray_z"] + 10.0)
    )
    objects.append(SceneObject(cover, (215, 220, 226)))
    return objects


def assembly_key_scene(config: dict[str, Any]) -> list[SceneObject]:
    key = config["key_shell"]
    manufacturing = config["manufacturing"]
    base = build_key_base(config)
    lid = build_key_lid(config).rotated_x(180.0).translated((0.0, 0.0, key["outer_z"] + 9.0))
    battery = config["key_battery"]
    uwb = config["uwb"]
    battery_placeholder = box(
        "key_battery_placeholder",
        (battery["x"], battery["y"], battery["z"]),
        (-17.0, 0.0, manufacturing["floor"] + battery["z"] / 2.0),
    )
    uwb_placeholder = box(
        "key_uwb_placeholder",
        (uwb["board_x"], uwb["board_y"], uwb["assembly_z"]),
        (29.0, 0.0, manufacturing["floor"] + uwb["assembly_z"] / 2.0),
    )
    marker = build_key_ref_marker().translated((29.0, 0.0, key["outer_z"] + 9.0))
    return [
        SceneObject(base, (73, 116, 156)),
        SceneObject(battery_placeholder, (221, 118, 43)),
        SceneObject(uwb_placeholder, (45, 151, 104)),
        SceneObject(lid, (205, 211, 219)),
        SceneObject(marker, (211, 63, 73)),
    ]


def write_layout_svg(config: dict[str, Any], path: Path) -> None:
    structure = config["lock_structure"]
    anchors = config["anchors"]
    radius = structure["zero_ring_outer_radius"]
    tray_x = structure["electronics_tray_x"]
    tray_y = structure["electronics_tray_y"]
    anchor_elements = []
    beam_elements = []
    for anchor in anchors:
        anchor_elements.append(
            f'<circle cx="{anchor["x"]}" cy="{-anchor["y"]}" r="8" class="anchor"/>'
            f'<text x="{anchor["x"] + 11}" y="{-anchor["y"] - 11}" class="label">{anchor["id"]}</text>'
        )
        beam_elements.append(
            f'<line x1="0" y1="0" x2="{anchor["x"]}" y2="{-anchor["y"]}" class="beam"/>'
        )
    svg = f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="-320 -320 640 640" width="1200" height="1200">
  <style>
    .ring {{ fill:none; stroke:#34495e; stroke-width:8; }}
    .beam {{ stroke:#527ea5; stroke-width:18; stroke-linecap:round; }}
    .anchor {{ fill:#e9ae4a; stroke:#6b4a14; stroke-width:2; }}
    .tray {{ fill:#d8dde4; stroke:#31363d; stroke-width:3; }}
    .axis {{ stroke:#d9534f; stroke-width:3; marker-end:url(#arrow); }}
    .label {{ font: bold 18px sans-serif; fill:#1f2937; }}
    .note {{ font: 14px sans-serif; fill:#374151; }}
  </style>
  <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#d9534f"/></marker></defs>
  <rect x="-320" y="-320" width="640" height="640" fill="#f7f8fa"/>
  <circle cx="0" cy="0" r="{radius}" class="ring"/>
  {''.join(beam_elements)}
  <rect x="{-tray_x / 2}" y="{-tray_y / 2}" width="{tray_x}" height="{tray_y}" rx="6" class="tray"/>
  {''.join(anchor_elements)}
  <circle cx="0" cy="0" r="5" fill="#d9534f"/>
  <line x1="0" y1="0" x2="0" y2="-255" class="axis"/>
  <text x="12" y="-255" class="label">FRONT</text>
  <text x="10" y="22" class="label">O</text>
  <text x="-300" y="310" class="note">Outer diameter: {2 * radius:.0f} mm; official limit: 600 mm</text>
</svg>
'''
    path.write_text(svg, encoding="utf-8")


def config_sha256(config_path: Path) -> str:
    return hashlib.sha256(config_path.read_bytes()).hexdigest()


def part_fits_bed(mesh: Mesh, config: dict[str, Any]) -> bool:
    part_xy = sorted(float(value) for value in mesh.dimensions[:2])
    bed_xy = sorted((float(config["printer"]["bed_x"]), float(config["printer"]["bed_y"])))
    return part_xy[0] <= bed_xy[0] and part_xy[1] <= bed_xy[1]


def generate(config: dict[str, Any], config_path: Path, output: Path) -> dict[str, Any]:
    output.mkdir(parents=True, exist_ok=True)
    generated_names = {
        "README.md",
        "lock_layout_reference.svg",
        "preview_key_exploded.png",
        "preview_lock_center.png",
        "preview_lock_overall.png",
        "validation_reload_report.json",
        "validation_report.json",
    }
    for stale_path in output.iterdir():
        if stale_path.is_file() and (stale_path.suffix.lower() == ".stl" or stale_path.name in generated_names):
            stale_path.unlink()
    parts, per_anchor = build_parts(config)
    report_parts: dict[str, Any] = {}
    failed_parts: list[str] = []
    for name, part in parts.items():
        mesh = part["mesh"].centered_for_print(name)
        validation = edge_count_validation(mesh)
        validation["quantity"] = part["quantity"]
        validation["note"] = part["note"]
        validation["fits_provisional_bed"] = part_fits_bed(mesh, config)
        validation["estimated_mass_g_each"] = round(
            abs(float(validation["signed_volume_mm3"])) / 1000.0 * PLA_DENSITY_G_PER_CM3,
            2,
        )
        report_parts[name] = validation
        if validation["degenerate_triangles"] or not validation["watertight_by_edges"]:
            failed_parts.append(name)
        export_binary_stl(mesh, output / f"{name}.stl")

    lock_outer_diameter = 2.0 * config["lock_structure"]["zero_ring_outer_radius"]
    lock_max_height = max(
        config["lock_structure"]["hub_z"]
        + config["lock_structure"]["beam_z"]
        + config["lock_structure"]["electronics_tray_z"],
        config["lock_structure"]["anchor_reference_z"] + config["uwb"]["assembly_z"] / 2.0,
    )
    key_lid_width = report_parts["key_sliding_lid"]["dimensions_mm"][1]
    envelope = {
        "key_model_mm": [
            config["key_shell"]["outer_x"],
            max(config["key_shell"]["outer_y"], key_lid_width),
            config["key_shell"]["outer_z"],
        ],
        "key_limit_mm": [
            config["official_envelope"]["key_x"],
            config["official_envelope"]["key_y"],
            config["official_envelope"]["key_z"],
        ],
        "lock_model_diameter_mm": lock_outer_diameter,
        "lock_model_height_mm": lock_max_height,
        "lock_limit_diameter_mm": config["official_envelope"]["lock_diameter"],
        "lock_limit_height_mm": config["official_envelope"]["lock_height"],
    }
    envelope["key_pass"] = all(
        model <= limit for model, limit in zip(envelope["key_model_mm"], envelope["key_limit_mm"], strict=True)
    )
    envelope["lock_pass"] = (
        lock_outer_diameter <= envelope["lock_limit_diameter_mm"]
        and lock_max_height <= envelope["lock_limit_height_mm"]
    )
    if not envelope["key_pass"] or not envelope["lock_pass"]:
        failed_parts.append("official_envelope")

    render_scene(
        assembly_key_scene(config),
        output / "preview_key_exploded.png",
        "C Problem - Key Shell v0.1 (exploded lid)",
        (1500, 1050),
        -50.0,
        30.0,
    )
    lock_scene = assembly_lock_scene(config, per_anchor)
    render_scene(
        lock_scene,
        output / "preview_lock_overall.png",
        "C Problem - Modular Lock Overall v0.1",
        (1600, 1300),
        -55.0,
        45.0,
    )
    center_scene = [
        item
        for item in lock_scene
        if "ring_" not in item.mesh.name
        and not item.mesh.name.startswith("beam_scene")
        and not item.mesh.name.startswith("anchor_pod")
        and not item.mesh.name.startswith("uwb_placeholder")
    ]
    render_scene(
        center_scene,
        output / "preview_lock_center.png",
        "C Problem - Rear Service Module v0.1",
        (1500, 1100),
        -55.0,
        28.0,
    )
    write_layout_svg(config, output / "lock_layout_reference.svg")

    total_mass = sum(
        details["estimated_mass_g_each"] * details["quantity"] for details in report_parts.values()
    )
    report = {
        "model_status": MODEL_STATUS,
        "config": str(config_path),
        "config_sha256": config_sha256(config_path),
        "printer_parameters_provisional": bool(config["printer"]["provisional"]),
        "official_envelope": envelope,
        "all_meshes_passed_edge_validation": not failed_parts,
        "failed_items": failed_parts,
        "estimated_total_mass_g_before_slicer_infill_adjustment": round(total_mass, 1),
        "parts": report_parts,
        "remaining_measurements": [
            "打印机有效热床、喷嘴、材料与实测公差",
            "UWB Type-C 方向、中心高度与天线禁布区",
            "100×55 mm PCB 孔位与最高器件",
            "84×50 mm 屏幕正面可视区与连接器突出高度",
            "按键、蜂鸣器、线缆和紧固件尺寸",
        ],
    }
    (output / "validation_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    lines = [
        f"# C 题 3D 打印输出 {config['revision']}",
        "",
        f"状态：**{MODEL_STATUS}**。打印机与部分接口尺寸仍待确认。",
        "",
        "| STL | 数量 | 尺寸 mm | 临时热床检查 | 说明 |",
        "| --- | ---: | --- | --- | --- |",
    ]
    for name, details in report_parts.items():
        dimensions = " × ".join(str(value) for value in details["dimensions_mm"])
        fit = "通过" if details["fits_provisional_bed"] else "不通过"
        lines.append(f"| `{name}.stl` | {details['quantity']} | {dimensions} | {fit} | {details['note']} |")
    lines.extend(
        [
            "",
            f"名义钥匙包络：`{' × '.join(str(value) for value in envelope['key_model_mm'])} mm`。",
            f"名义门锁包络：直径 `{lock_outer_diameter:.1f} mm`，高度 `{lock_max_height:.1f} mm`。",
            "",
            "完整检查见 `validation_report.json`；装配方向见 PNG 预览和 `lock_layout_reference.svg`。",
        ]
    )
    (output / "README.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    if failed_parts:
        raise RuntimeError(f"mesh or envelope validation failed: {', '.join(failed_parts)}")
    return report


def validate_existing(output: Path) -> dict[str, Any]:
    stl_paths = sorted(output.glob("*.stl"))
    if not stl_paths:
        raise FileNotFoundError(f"no STL files found in {output}")
    results: dict[str, Any] = {}
    failed: list[str] = []
    for stl_path in stl_paths:
        mesh = load_binary_stl(stl_path)
        validation = edge_count_validation(mesh)
        results[stl_path.name] = validation
        if validation["degenerate_triangles"] or not validation["watertight_by_edges"]:
            failed.append(stl_path.name)
    summary = {"files": len(stl_paths), "failed": failed, "results": results}
    (output / "validation_reload_report.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    if failed:
        raise RuntimeError(f"reloaded STL validation failed: {', '.join(failed)}")
    return summary


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--validate-only", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config = load_config(args.config)
    validate_config(config)
    if args.validate_only:
        summary = validate_existing(args.output)
        print(json.dumps({"ok": True, "validated_files": summary["files"]}, ensure_ascii=False))
        return 0
    report = generate(config, args.config, args.output)
    print(
        json.dumps(
            {
                "ok": True,
                "status": report["model_status"],
                "parts": len(report["parts"]),
                "output": str(args.output),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
