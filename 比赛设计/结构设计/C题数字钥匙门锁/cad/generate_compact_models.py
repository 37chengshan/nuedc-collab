#!/usr/bin/env python3
"""Generate the compact C-problem enclosure (v0.3/v0.4/v0.5)."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any, Callable, Sequence

from compact_design import compact_part_plan, load_compact_config
from generate_models import bridge_clip, corner_stops, rectangular_frame, tiled_panel
from generate_product_models import (
    build_key_button_cap as build_legacy_key_button_cap,
    build_key_lower_shell as build_legacy_key_lower_shell,
    build_uwb_cassette as build_legacy_uwb_cassette,
    chamfered_profile,
    edge_wall,
)
from meshlib import (
    Mesh,
    SceneObject,
    annular_frustum_sector,
    box,
    convex_prism,
    cylinder,
    edge_count_validation,
    export_binary_stl,
    load_binary_stl,
    merge,
    render_scene,
    ring,
)


def model_status(config: dict[str, Any]) -> str:
    revision = str(config["revision"])
    if revision == "0.5":
        return "v0.5 238 mm 前后分体门锁软件候选版"
    if revision == "0.4":
        return "v0.4 可拆钥匙控制面板软件候选版"
    return "v0.3 单热床免拼壳软件候选版"


def has_v0_4_features(config: dict[str, Any]) -> bool:
    return str(config["revision"]) in {"0.4", "0.5"}


def build_key_lower_shell(config: dict[str, Any]) -> Mesh:
    return build_legacy_key_lower_shell(config).centered_for_print("compact_key_lower_shell")


def clip_convex_profile_y(
    profile: Sequence[Sequence[float]],
    threshold: float,
    keep_above: bool,
) -> list[tuple[float, float]]:
    """Clip a convex XY profile against one horizontal half plane."""

    points = [(float(point[0]), float(point[1])) for point in profile]
    result: list[tuple[float, float]] = []
    for index, current in enumerate(points):
        following = points[(index + 1) % len(points)]
        current_inside = current[1] >= threshold if keep_above else current[1] <= threshold
        following_inside = (
            following[1] >= threshold if keep_above else following[1] <= threshold
        )
        if current_inside:
            result.append(current)
        if current_inside == following_inside:
            continue
        dy = following[1] - current[1]
        if abs(dy) <= 1e-12:
            continue
        ratio = (threshold - current[1]) / dy
        result.append(
            (
                current[0] + ratio * (following[0] - current[0]),
                threshold,
            )
        )
    if len(result) < 3:
        raise ValueError("profile clipping produced fewer than three points")
    return result


def chamfered_panel_with_rectangular_opening(
    name: str,
    profile: Sequence[Sequence[float]],
    opening_x: float,
    opening_y: float,
    thickness_z: float,
) -> Mesh:
    """Build a chamfered plate around one centered rectangular service opening."""

    half_opening_x = opening_x / 2.0
    half_opening_y = opening_y / 2.0
    minimum_x = min(float(point[0]) for point in profile)
    maximum_x = max(float(point[0]) for point in profile)
    vertical_edge_min_y = max(
        min(float(point[1]) for point in profile if abs(float(point[0]) - minimum_x) < 1e-9),
        min(float(point[1]) for point in profile if abs(float(point[0]) - maximum_x) < 1e-9),
    )
    vertical_edge_max_y = min(
        max(float(point[1]) for point in profile if abs(float(point[0]) - minimum_x) < 1e-9),
        max(float(point[1]) for point in profile if abs(float(point[0]) - maximum_x) < 1e-9),
    )
    if not (
        minimum_x < -half_opening_x < half_opening_x < maximum_x
        and vertical_edge_min_y < -half_opening_y < half_opening_y < vertical_edge_max_y
    ):
        raise ValueError("rectangular opening does not fit the straight section of the profile")

    bottom = clip_convex_profile_y(profile, -half_opening_y, keep_above=False)
    top = clip_convex_profile_y(profile, half_opening_y, keep_above=True)
    pieces = [
        convex_prism(f"{name}_bottom", bottom, thickness_z, thickness_z / 2.0),
        convex_prism(f"{name}_top", top, thickness_z, thickness_z / 2.0),
        box(
            f"{name}_left",
            (-half_opening_x - minimum_x, opening_y, thickness_z),
            ((minimum_x - half_opening_x) / 2.0, 0.0, thickness_z / 2.0),
        ),
        box(
            f"{name}_right",
            (maximum_x - half_opening_x, opening_y, thickness_z),
            ((maximum_x + half_opening_x) / 2.0, 0.0, thickness_z / 2.0),
        ),
    ]
    return merge(name, pieces)


def build_key_top_cover(config: dict[str, Any]) -> Mesh:
    key = config["key_shell"]
    manufacturing = config["manufacturing"]
    skirt_z = float(key["lid_skirt_z"])
    lid_z = float(key["lid_z"])
    outer = chamfered_profile(
        float(key["outer_x"]) - 0.7,
        float(key["outer_y"]) - 0.7,
        float(key["corner_chamfer"]),
    )
    inset = float(manufacturing["wall"]) + float(manufacturing["clearance_xy"])
    inner = chamfered_profile(
        float(key["outer_x"]) - 2.0 * inset,
        float(key["outer_y"]) - 2.0 * inset,
        max(3.0, float(key["corner_chamfer"]) - inset),
    )
    if has_v0_4_features(config):
        controls = config["key_controls"]
        cover_plate = chamfered_panel_with_rectangular_opening(
            "key_cover_plate",
            outer,
            float(controls["cover_opening_x"]),
            float(controls["cover_opening_y"]),
            lid_z,
        )
        key_ref_x = -float(key["outer_x"]) / 2.0 + 7.2
    else:
        cover_plate = convex_prism("key_cover_plate", outer, lid_z, lid_z / 2.0)
        key_ref_x = -float(key["outer_x"]) / 2.0 + 0.6
    pieces: list[Mesh] = [
        cover_plate,
        convex_prism(
            "key_ref_integrated",
            [(0.0, -4.0), (-5.5, 0.0), (0.0, 4.0)],
            lid_z,
            lid_z / 2.0,
        ).translated((key_ref_x, 0.0, 0.0)),
    ]
    for index, start in enumerate(inner):
        pieces.append(
            edge_wall(
                f"key_lid_skirt_{index}",
                start,
                inner[(index + 1) % len(inner)],
                1.4,
                skirt_z,
                lid_z,
            )
        )
    snap_y = float(key["outer_y"]) / 2.0 - inset
    for label, y_position in (("left", -snap_y), ("right", snap_y)):
        pieces.append(
            box(
                f"key_lid_snap_{label}",
                (10.0, 1.8, 4.0),
                (0.0, y_position, lid_z + 2.0),
            )
        )
    return merge("compact_key_top_cover", pieces).centered_for_print("compact_key_top_cover")


def build_key_button_cap(config: dict[str, Any]) -> Mesh:
    if has_v0_4_features(config):
        controls = config["key_controls"]
        head_diameter = float(controls["button_head_diameter"])
        head_z = float(controls["button_head_z"])
        arm_length = float(controls["button_arm_length"])
        arm_thickness = float(controls["button_arm_thickness"])
        pusher_length = float(controls["button_pusher_length"])
        opening_diameter = float(controls["button_opening_diameter"])
        arm_center_x = opening_diameter / 2.0 - arm_thickness / 2.0 - 0.25
        arm_width_y = 4.8
        hook_x = float(controls["button_hook_height"])
        pieces: list[Mesh] = [
            cylinder(
                "key_button_head",
                head_diameter / 2.0,
                head_z,
                64,
                (0.0, 0.0, head_z / 2.0),
            ),
            cylinder(
                "key_button_pusher",
                3.0,
                pusher_length,
                32,
                (0.0, 0.0, head_z + pusher_length / 2.0),
            ),
        ]
        for label, sign in (("left", -1.0), ("right", 1.0)):
            pieces.extend(
                [
                    box(
                        f"key_button_arm_{label}",
                        (arm_thickness, arm_width_y, arm_length),
                        (
                            sign * arm_center_x,
                            0.0,
                            head_z + arm_length / 2.0,
                        ),
                    ),
                    box(
                        f"key_button_hook_{label}",
                        (arm_thickness + hook_x, arm_width_y, 0.8),
                        (
                            sign * (arm_center_x + hook_x / 2.0),
                            0.0,
                            head_z + arm_length - 0.4,
                        ),
                    ),
                ]
            )
        return merge("compact_key_button_cap", pieces).centered_for_print(
            "compact_key_button_cap"
        )
    return build_legacy_key_button_cap(config).centered_for_print("compact_key_button_cap")


def build_key_control_panel(config: dict[str, Any]) -> Mesh:
    controls = config["key_controls"]
    panel_x = float(controls["panel_outer_x"])
    panel_y = float(controls["panel_outer_y"])
    panel_z = float(controls["panel_z"])
    holes = [
        (
            float(controls["button_center_x"]),
            float(controls["button_center_y"]),
            float(controls["button_square_opening"]),
            float(controls["button_square_opening"]),
        ),
        (
            float(controls["led_center_x"]),
            float(controls["led_center_y"]),
            float(controls["led_opening"]),
            float(controls["led_opening"]),
        ),
        (
            float(controls["slide_center_x"]),
            float(controls["slide_center_y"]),
            float(controls["slide_slot_x"]),
            float(controls["slide_slot_y"]),
        ),
    ]
    pieces: list[Mesh] = [
        tiled_panel("key_control_panel_face", panel_x, panel_y, panel_z, holes)
    ]

    opening_x = float(controls["cover_opening_x"])
    opening_y = float(controls["cover_opening_y"])
    insert_clearance = float(controls["insert_clearance"])
    skirt_outer_x = opening_x - 2.0 * insert_clearance
    skirt_outer_y = opening_y - 2.0 * insert_clearance
    skirt_wall = float(controls["skirt_wall"])
    skirt_z = float(controls["skirt_z"])
    snap_x = float(controls["snap_arm_x"])
    snap_thickness = float(controls["snap_arm_thickness"])
    hook_height = float(controls["snap_hook_height"])
    snap_gap = 1.0
    side_segment_x = (
        skirt_outer_x - 2.0 * skirt_wall - snap_x - 2.0 * snap_gap
    ) / 2.0
    if side_segment_x <= 2.0:
        raise ValueError("control-panel skirt leaves no room beside the flex tabs")
    pieces.extend(
        [
            box(
                "key_control_skirt_left",
                (skirt_wall, skirt_outer_y, skirt_z),
                (
                    -skirt_outer_x / 2.0 + skirt_wall / 2.0,
                    0.0,
                    panel_z + skirt_z / 2.0,
                ),
            ),
            box(
                "key_control_skirt_right",
                (skirt_wall, skirt_outer_y, skirt_z),
                (
                    skirt_outer_x / 2.0 - skirt_wall / 2.0,
                    0.0,
                    panel_z + skirt_z / 2.0,
                ),
            ),
        ]
    )
    snap_y = skirt_outer_y / 2.0 - snap_thickness / 2.0
    for label, sign in (("lower", -1.0), ("upper", 1.0)):
        for side_label, x_sign in (("left", -1.0), ("right", 1.0)):
            pieces.append(
                box(
                    f"key_control_skirt_{label}_{side_label}",
                    (side_segment_x, skirt_wall, skirt_z),
                    (
                        x_sign
                        * (snap_x / 2.0 + snap_gap + side_segment_x / 2.0),
                        sign * (skirt_outer_y / 2.0 - skirt_wall / 2.0),
                        panel_z + skirt_z / 2.0,
                    ),
                )
            )
        pieces.extend(
            [
                box(
                    f"key_control_snap_{label}",
                    (snap_x, snap_thickness, skirt_z),
                    (0.0, sign * snap_y, panel_z + skirt_z / 2.0),
                ),
                box(
                    f"key_control_hook_{label}",
                    (snap_x, snap_thickness + hook_height, 0.8),
                    (
                        0.0,
                        sign * (snap_y + hook_height / 2.0),
                        panel_z + skirt_z - 0.4,
                    ),
                ),
            ]
        )
    board_x = float(controls["control_board_x"])
    board_y = float(controls["control_board_y"])
    board_z = float(controls["control_board_z"])
    board_center_z = float(controls["control_board_center_z"])
    board_clearance = float(controls["control_board_edge_clearance"])
    rail_depth = 2.0
    rail_height = 1.2
    rail_y = board_y / 2.0 + board_clearance + rail_depth / 2.0
    support_z = board_center_z - board_z / 2.0 - rail_height / 2.0
    for label, sign in (("lower", -1.0), ("upper", 1.0)):
        pieces.extend(
            [
                box(
                    f"key_control_board_rail_{label}",
                    (board_x + 2.0 * board_clearance, rail_depth, rail_height),
                    (0.0, sign * rail_y, support_z),
                ),
                box(
                    f"key_control_board_detent_{label}",
                    (8.0, rail_depth, 0.8),
                    (
                        0.0,
                        sign * rail_y,
                        board_center_z + board_z / 2.0 + 0.4,
                    ),
                ),
            ]
        )
    return merge("compact_key_control_panel", pieces).centered_for_print(
        "compact_key_control_panel"
    )


def build_key_slide_knob(config: dict[str, Any]) -> Mesh:
    controls = config["key_controls"]
    knob_x = float(controls["slide_knob_x"])
    knob_y = float(controls["slide_knob_y"])
    knob_z = float(controls["slide_knob_z"])
    actuator_x = float(controls["slide_actuator_x"])
    actuator_y = float(controls["slide_actuator_y"])
    clearance = float(controls["slide_socket_clearance"])
    wall = 1.2
    inner_x = actuator_x + 2.0 * clearance
    inner_y = actuator_y + 2.0 * clearance
    outer_x = inner_x + 2.0 * wall
    outer_y = inner_y + 2.0 * wall
    socket_z = float(controls["slide_actuator_z"]) + 0.5
    pieces = [
        box("key_slide_grip", (knob_x, knob_y, knob_z), (0.0, 0.0, knob_z / 2.0)),
        box(
            "key_slide_grip_ridge",
            (knob_x - 2.0, 1.2, 0.8),
            (0.0, 0.0, knob_z + 0.4),
        ),
        box(
            "key_slide_socket_left",
            (wall, outer_y, socket_z),
            (-(inner_x + wall) / 2.0, 0.0, knob_z + socket_z / 2.0),
        ),
        box(
            "key_slide_socket_right",
            (wall, outer_y, socket_z),
            ((inner_x + wall) / 2.0, 0.0, knob_z + socket_z / 2.0),
        ),
        box(
            "key_slide_socket_front",
            (inner_x, wall, socket_z),
            (0.0, -(inner_y + wall) / 2.0, knob_z + socket_z / 2.0),
        ),
        box(
            "key_slide_socket_back",
            (inner_x, wall, socket_z),
            (0.0, (inner_y + wall) / 2.0, knob_z + socket_z / 2.0),
        ),
    ]
    if outer_x > knob_x or outer_y > knob_y:
        raise ValueError("slide actuator socket exceeds the visible knob")
    return merge("compact_key_slide_knob", pieces).centered_for_print(
        "compact_key_slide_knob"
    )


def build_key_battery_clip(config: dict[str, Any]) -> Mesh:
    battery = config["key_battery"]
    return bridge_clip(
        "compact_key_battery_clip",
        float(battery["y"]),
        float(battery["z"]),
        9.0,
        2.2,
        0.35,
    ).centered_for_print("compact_key_battery_clip")


def build_key_parts(config: dict[str, Any]) -> dict[str, Mesh]:
    parts = {
        "compact_key_lower_shell": build_key_lower_shell(config),
        "compact_key_top_cover": build_key_top_cover(config),
        "compact_key_button_cap": build_key_button_cap(config),
        "compact_key_battery_clip": build_key_battery_clip(config),
    }
    if has_v0_4_features(config):
        parts["compact_key_control_panel"] = build_key_control_panel(config)
        parts["compact_key_slide_knob"] = build_key_slide_knob(config)
    return parts


def build_cover_posts(config: dict[str, Any], side: str | None = None) -> list[Mesh]:
    lock = config["compact_lock"]
    floor = float(lock["lower_floor_z"])
    height = float(lock["lower_wall_height"]) - floor
    posts: list[Mesh] = []
    post_center_radius = float(lock.get("cover_post_center_radius", 108.0))
    post_radius = float(lock.get("cover_post_radius", 3.2))
    for index, angle in enumerate((45.0, 135.0, 225.0, 315.0)):
        radians = math.radians(angle)
        center_y = post_center_radius * math.sin(radians)
        if side == "front" and center_y <= 0.0:
            continue
        if side == "rear" and center_y >= 0.0:
            continue
        posts.append(
            cylinder(
                f"cover_support_{index}",
                post_radius,
                height,
                32,
                (
                    post_center_radius * math.cos(radians),
                    center_y,
                    floor + height / 2.0,
                ),
            )
        )
    return posts


def build_uwb_receiver_rails(
    config: dict[str, Any], side: str | None = None
) -> list[Mesh]:
    lock = config["compact_lock"]
    rails: list[Mesh] = []
    for anchor in config["anchors"]:
        anchor_y = float(anchor["y"])
        if side == "front" and anchor_y <= 0.0:
            continue
        if side == "rear" and anchor_y >= 0.0:
            continue
        radius = math.hypot(float(anchor["x"]), float(anchor["y"]))
        anchor_z = float(anchor["z"])
        if anchor["mount"] == "inner_rear":
            support_height = anchor_z + 15.0
            back = box(
                f"{anchor['id']}_receiver_back",
                (36.0, 4.0, support_height),
                (0.0, 0.0, support_height / 2.0),
            )
        else:
            radial_depth = float(lock["inner_bottom_radius"]) - radius + 2.0
            back = box(
                f"{anchor['id']}_receiver_back",
                (36.0, radial_depth, 30.0),
                (0.0, radial_depth / 2.0, anchor_z),
            )
        local = merge(
            f"{anchor['id']}_receiver",
            [
                back,
                box(
                    f"{anchor['id']}_receiver_left",
                    (2.4, 7.0, 30.0),
                    (-16.8, 2.3, anchor_z),
                ),
                box(
                    f"{anchor['id']}_receiver_right",
                    (2.4, 7.0, 30.0),
                    (16.8, 2.3, anchor_z),
                ),
            ],
        )
        angle = math.degrees(math.atan2(float(anchor["y"]), float(anchor["x"]))) - 90.0
        rails.append(local.translated((0.0, radius, 0.0)).rotated_z(angle))
    return rails


def build_rear_fascia_rails(config: dict[str, Any]) -> list[Mesh]:
    lock = config["compact_lock"]
    floor = float(lock["lower_floor_z"])
    height = float(lock["lower_wall_height"]) - floor
    half_x = float(lock["rear_fascia_x"]) / 2.0 + 2.0
    center_z = floor + height / 2.0
    plane_y = float(lock["rear_fascia_plane_y"])
    return [
        box("rear_rail_left", (3.0, 6.0, height), (-half_x, plane_y, center_z)),
        box("rear_rail_right", (3.0, 6.0, height), (half_x, plane_y, center_z)),
    ]


def half_disc(
    name: str,
    radius: float,
    height: float,
    side: str,
    segments: int = 60,
    center_z: float = 0.0,
) -> Mesh:
    if side not in {"front", "rear"}:
        raise ValueError(f"{name}: side must be front or rear")
    start_deg, end_deg = (0.0, 180.0) if side == "front" else (180.0, 360.0)
    profile = [
        (
            radius * math.cos(math.radians(start_deg + (end_deg - start_deg) * index / segments)),
            radius * math.sin(math.radians(start_deg + (end_deg - start_deg) * index / segments)),
        )
        for index in range(segments + 1)
    ]
    return convex_prism(name, profile, height, center_z)


def wall_angle_ranges(config: dict[str, Any], side: str) -> list[tuple[float, float]]:
    lock = config["compact_lock"]
    start = float(lock["rear_wall_start_deg"])
    end = float(lock["rear_wall_end_deg"])
    if side == "front":
        half_start, half_end = 0.0, 180.0
    elif side == "rear":
        half_start, half_end = 180.0, 360.0
    else:
        raise ValueError("side must be front or rear")
    first_cycle = math.floor((start - half_end) / 360.0)
    last_cycle = math.ceil((end - half_start) / 360.0)
    ranges: list[tuple[float, float]] = []
    for cycle in range(first_cycle, last_cycle + 1):
        range_start = max(start, half_start + 360.0 * cycle)
        range_end = min(end, half_end + 360.0 * cycle)
        if range_end - range_start > 1e-9:
            ranges.append((range_start, range_end))
    return ranges


def build_split_joint_components(config: dict[str, Any], side: str) -> list[Mesh]:
    lock = config["compact_lock"]
    split = config["lock_split"]
    floor = float(lock["lower_floor_z"])
    depth = float(split["tongue_depth"])
    height = float(split["tongue_height"])
    clearance_xy = float(split["clearance_xy"])
    clearance_z = float(split["clearance_z"])
    receiver_wall = float(split["receiver_wall"])
    positions = [float(value) for value in split["joint_x"]]
    widths = [float(value) for value in split["tongue_widths"]]
    components: list[Mesh] = []
    for index, (position, width) in enumerate(zip(positions, widths)):
        if side == "front":
            components.append(
                box(
                    f"split_tongue_{index}",
                    (width, depth, height),
                    (position, -depth / 2.0, floor + height / 2.0),
                )
            )
            continue
        if side != "rear":
            raise ValueError("side must be front or rear")
        cavity_width = width + 2.0 * clearance_xy
        cavity_depth = depth + clearance_xy
        receiver_height = height + clearance_z
        components.extend(
            [
                box(
                    f"split_receiver_{index}_left",
                    (receiver_wall, cavity_depth, receiver_height),
                    (
                        position - (cavity_width + receiver_wall) / 2.0,
                        -cavity_depth / 2.0,
                        floor + receiver_height / 2.0,
                    ),
                ),
                box(
                    f"split_receiver_{index}_right",
                    (receiver_wall, cavity_depth, receiver_height),
                    (
                        position + (cavity_width + receiver_wall) / 2.0,
                        -cavity_depth / 2.0,
                        floor + receiver_height / 2.0,
                    ),
                ),
                box(
                    f"split_receiver_{index}_back",
                    (cavity_width + 2.0 * receiver_wall, receiver_wall, receiver_height),
                    (
                        position,
                        -cavity_depth - receiver_wall / 2.0,
                        floor + receiver_height / 2.0,
                    ),
                ),
            ]
        )
    return components


def build_lock_body_half_components(
    config: dict[str, Any], side: str
) -> list[Mesh]:
    if str(config["revision"]) != "0.5":
        raise ValueError("split lock body components require a v0.5 configuration")
    lock = config["compact_lock"]
    floor = float(lock["lower_floor_z"])
    side_height = float(lock["lower_wall_height"]) - floor
    pieces: list[Mesh] = [
        half_disc(
            f"compact_lock_{side}_floor",
            float(lock["outer_radius"]),
            floor,
            side,
            60,
            floor / 2.0,
        )
    ]
    total_wall_span = (
        float(lock["rear_wall_end_deg"]) - float(lock["rear_wall_start_deg"])
    )
    for index, (start_deg, end_deg) in enumerate(wall_angle_ranges(config, side)):
        segments = max(2, round(112.0 * (end_deg - start_deg) / total_wall_span))
        pieces.append(
            annular_frustum_sector(
                f"compact_lock_{side}_sidewall_{index}",
                float(lock["outer_radius"]),
                float(lock["outer_top_radius"]),
                float(lock["inner_bottom_radius"]),
                float(lock["inner_top_radius"]),
                side_height,
                start_deg,
                end_deg,
                segments,
                floor + side_height / 2.0,
            )
        )
    if side == "front":
        pieces.extend(
            [
                corner_stops(
                    "compact_pcb_stops",
                    float(config["vehicle_pcb"]["x"]),
                    float(config["vehicle_pcb"]["y"]),
                    0.0,
                    float(lock["pcb_center_y"]),
                    floor,
                    float(lock["mount_height"]),
                ),
                box(
                    "front_cable_rail",
                    (110.0, 3.0, 6.0),
                    (0.0, 74.0, floor + 3.0),
                ),
            ]
        )
        marker_width = float(lock["front_marker_width"])
        marker_height = float(lock["front_marker_height"])
        pieces.append(
            convex_prism(
                "compact_front_direction_marker",
                [
                    (-marker_width / 2.0, -marker_height / 2.0),
                    (marker_width / 2.0, -marker_height / 2.0),
                    (0.0, marker_height / 2.0),
                ],
                float(lock["front_marker_relief"]),
                0.0,
            )
            .rotated_x(90.0)
            .translated(
                (
                    0.0,
                    float(lock["front_marker_plane_y"]),
                    float(lock["front_marker_center_z"]),
                )
            )
        )
    elif side == "rear":
        pieces.extend(
            [
                corner_stops(
                    "compact_battery_stops",
                    float(config["lock_battery"]["x"]),
                    float(config["lock_battery"]["y"]),
                    0.0,
                    float(lock["battery_center_y"]),
                    floor,
                    float(lock["mount_height"]),
                ),
                box(
                    "rear_cable_rail",
                    (110.0, 3.0, 6.0),
                    (0.0, -74.0, floor + 3.0),
                ),
            ]
        )
        pieces.extend(build_rear_fascia_rails(config))
    else:
        raise ValueError("side must be front or rear")
    pieces.extend(build_cover_posts(config, side))
    pieces.extend(build_uwb_receiver_rails(config, side))
    pieces.extend(build_split_joint_components(config, side))
    return pieces


def build_lock_body_halves(config: dict[str, Any]) -> dict[str, Mesh]:
    return {
        "front": merge(
            "compact_lock_body_front",
            build_lock_body_half_components(config, "front"),
        ),
        "rear": merge(
            "compact_lock_body_rear",
            build_lock_body_half_components(config, "rear"),
        ),
    }


def build_lock_body_front(config: dict[str, Any]) -> Mesh:
    return build_lock_body_halves(config)["front"].centered_for_print(
        "compact_lock_body_front"
    )


def build_lock_body_rear(config: dict[str, Any]) -> Mesh:
    return build_lock_body_halves(config)["rear"].centered_for_print(
        "compact_lock_body_rear"
    )


def build_lock_lower_housing(config: dict[str, Any]) -> Mesh:
    lock = config["compact_lock"]
    floor = float(lock["lower_floor_z"])
    side_height = float(lock["lower_wall_height"]) - floor
    pieces: list[Mesh] = [
        cylinder(
            "compact_lock_floor",
            float(lock["outer_radius"]),
            floor,
            120,
            (0.0, 0.0, floor / 2.0),
        ),
        annular_frustum_sector(
            "compact_lock_sidewall",
            float(lock["outer_radius"]),
            float(lock["outer_top_radius"]),
            float(lock["inner_bottom_radius"]),
            float(lock["inner_top_radius"]),
            side_height,
            float(lock["rear_wall_start_deg"]),
            float(lock["rear_wall_end_deg"]),
            112,
            floor + side_height / 2.0,
        ),
        corner_stops(
            "compact_pcb_stops",
            float(config["vehicle_pcb"]["x"]),
            float(config["vehicle_pcb"]["y"]),
            0.0,
            float(lock["pcb_center_y"]),
            floor,
            float(lock["mount_height"]),
        ),
        corner_stops(
            "compact_battery_stops",
            float(config["lock_battery"]["x"]),
            float(config["lock_battery"]["y"]),
            0.0,
            float(lock["battery_center_y"]),
            floor,
            float(lock["mount_height"]),
        ),
        box("front_cable_rail", (110.0, 3.0, 6.0), (0.0, 74.0, floor + 3.0)),
        box("rear_cable_rail", (110.0, 3.0, 6.0), (0.0, -74.0, floor + 3.0)),
    ]
    if has_v0_4_features(config):
        marker_width = float(lock["front_marker_width"])
        marker_height = float(lock["front_marker_height"])
        marker = convex_prism(
            "compact_front_direction_marker",
            [
                (-marker_width / 2.0, -marker_height / 2.0),
                (marker_width / 2.0, -marker_height / 2.0),
                (0.0, marker_height / 2.0),
            ],
            float(lock["front_marker_relief"]),
            0.0,
        ).rotated_x(90.0).translated(
            (
                0.0,
                float(lock["front_marker_plane_y"]),
                float(lock["front_marker_center_z"]),
            )
        )
        pieces.append(marker)
    pieces.extend(build_cover_posts(config))
    pieces.extend(build_uwb_receiver_rails(config))
    pieces.extend(build_rear_fascia_rails(config))
    return merge("compact_lock_lower_housing", pieces).centered_for_print(
        "compact_lock_lower_housing"
    )


def build_cover_snap_tabs(config: dict[str, Any]) -> list[Mesh]:
    lock = config["compact_lock"]
    snap = config["snap_fit"]
    cover_z = float(lock["top_cover_z"])
    snap_radius = float(lock.get("cover_snap_center_radius", 127.0))
    tabs: list[Mesh] = []
    for index, angle in enumerate((45.0, 135.0, 225.0, 315.0)):
        local = merge(
            f"cover_snap_{index}",
            [
                box(
                    f"cover_snap_{index}_arm",
                    (
                        float(snap["arm_width"]),
                        float(snap["arm_thickness"]),
                        float(snap["arm_length"]),
                    ),
                    (0.0, 0.0, cover_z + float(snap["arm_length"]) / 2.0),
                ),
                box(
                    f"cover_snap_{index}_hook",
                    (
                        float(snap["arm_width"]),
                        float(snap["arm_thickness"]) + float(snap["hook_height"]),
                        1.2,
                    ),
                    (
                        0.0,
                        float(snap["hook_height"]) / 2.0,
                        cover_z + float(snap["arm_length"]) - 0.6,
                    ),
                ),
            ],
        )
        radians = math.radians(angle)
        tabs.append(
            local.rotated_z(angle).translated(
                (
                    snap_radius * math.cos(radians),
                    snap_radius * math.sin(radians),
                    0.0,
                )
            )
        )
    return tabs


def build_lock_top_cover(config: dict[str, Any]) -> Mesh:
    lock = config["compact_lock"]
    cover_z = float(lock["top_cover_z"])
    lip_z = float(lock["top_lip_z"])
    pieces: list[Mesh] = [
        cylinder(
            "compact_top_plate",
            float(lock["top_cover_radius"]),
            cover_z,
            120,
            (0.0, 0.0, cover_z / 2.0),
        ),
        ring(
            "compact_top_lip",
            float(lock["top_lip_outer_radius"]),
            float(lock["top_lip_inner_radius"]),
            lip_z,
            120,
            (0.0, 0.0, cover_z + lip_z / 2.0),
        ),
    ]
    if has_v0_4_features(config):
        rib_inner = float(lock["top_rib_inner_radius"])
        rib_outer = float(lock["top_rib_outer_radius"])
        rib_length = rib_outer - rib_inner
        rib_center = (rib_inner + rib_outer) / 2.0
        rib_width = float(lock["top_rib_width"])
        rib_height = float(lock["top_rib_height"])
        rib_count = int(lock["top_rib_count"])
        for index in range(rib_count):
            angle = 360.0 * index / rib_count
            pieces.append(
                box(
                    f"compact_top_rib_{index}",
                    (rib_length, rib_width, rib_height),
                    (rib_center, 0.0, cover_z + rib_height / 2.0),
                ).rotated_z(angle)
            )
        pieces.append(
            ring(
                "compact_top_center_stiffener",
                rib_inner + rib_width,
                rib_inner,
                rib_height,
                64,
                (0.0, 0.0, cover_z + rib_height / 2.0),
            )
        )
    pieces.extend(build_cover_snap_tabs(config))
    return merge("compact_lock_top_cover", pieces).centered_for_print(
        "compact_lock_top_cover"
    )


def build_uwb_cassette(config: dict[str, Any]) -> Mesh:
    return build_legacy_uwb_cassette(config).centered_for_print("compact_uwb_cassette")


def rear_control_holes(config: dict[str, Any]) -> list[tuple[float, float, float, float]]:
    display = config["display"]
    dip = config["dip_switch"]
    controls = config["controls"]
    if has_v0_4_features(config):
        dip_center_x = float(dip["panel_center_x"])
        dip_center_y = float(dip["panel_center_y"])
        dip_opening_x = float(dip["x"]) + float(dip["operator_margin_x"])
        dip_opening_y = float(dip["y"]) + float(dip["operator_margin_y"])
        control_row_y = float(controls["control_row_y"])
        led_centers_x = [float(value) for value in controls["lock_led_centers_x"]]
        debug_center_x = float(controls["debug_center_x"])
    else:
        dip_center_x = -29.0
        dip_center_y = -20.0
        dip_opening_x = float(dip["x"]) + 0.6
        dip_opening_y = float(dip["y"]) + 0.6
        control_row_y = -20.0
        led_centers_x = [-13.0, 0.0, 13.0]
        debug_center_x = 29.0
    holes = [
        (0.0, 9.0, float(display["visible_x"]) + 0.8, float(display["visible_y"]) + 0.8),
        (dip_center_x, dip_center_y, dip_opening_x, dip_opening_y),
        (
            led_centers_x[0],
            control_row_y,
            float(controls["lock_led_diameter"]) + 0.6,
            float(controls["lock_led_diameter"]) + 0.6,
        ),
        (
            led_centers_x[1],
            control_row_y,
            float(controls["lock_led_diameter"]) + 0.6,
            float(controls["lock_led_diameter"]) + 0.6,
        ),
        (
            led_centers_x[2],
            control_row_y,
            float(controls["welcome_led_diameter"]) + 0.6,
            float(controls["welcome_led_diameter"]) + 0.6,
        ),
        (
            debug_center_x,
            control_row_y,
            float(controls["debug_opening_x"]),
            float(controls["debug_opening_y"]),
        ),
    ]
    if has_v0_4_features(config):
        dip_screw_opening = (
            float(dip["retainer_screw_diameter"])
            + float(dip["retainer_screw_clearance"])
        )
        half_pitch = float(dip["retainer_screw_pitch_x"]) / 2.0
        holes.extend(
            [
                (
                    dip_center_x - half_pitch,
                    dip_center_y,
                    dip_screw_opening,
                    dip_screw_opening,
                ),
                (
                    dip_center_x + half_pitch,
                    dip_center_y,
                    dip_screw_opening,
                    dip_screw_opening,
                ),
            ]
        )
    screw_opening = float(display["hole_diameter"]) + float(display["hole_clearance"])
    for x_position in (
        -float(display["hole_pitch_x"]) / 2.0,
        float(display["hole_pitch_x"]) / 2.0,
    ):
        for y_position in (
            -float(display["hole_pitch_y"]) / 2.0,
            float(display["hole_pitch_y"]) / 2.0,
        ):
            holes.append((x_position, y_position + 9.0, screw_opening, screw_opening))
    return holes


def build_rear_fascia(config: dict[str, Any]) -> Mesh:
    lock = config["compact_lock"]
    panel_z = float(lock["rear_fascia_z"])
    pieces: list[Mesh] = [
        tiled_panel(
            "compact_rear_fascia_panel",
            float(lock["rear_fascia_x"]),
            float(lock["rear_fascia_y"]),
            panel_z,
            rear_control_holes(config),
        )
    ]
    if has_v0_4_features(config):
        dip = config["dip_switch"]
        controls = config["controls"]
        center_x = float(dip["panel_center_x"])
        center_y = float(dip["panel_center_y"])
        opening_x = float(dip["x"]) + float(dip["operator_margin_x"])
        opening_y = float(dip["y"]) + float(dip["operator_margin_y"])
        marker_diameter = float(controls["dip_bit_marker_diameter"])
        marker_z = float(controls["dip_on_marker_z"])
        bit_pitch = float(dip["x"]) / 4.0
        first_bit_x = center_x - 1.5 * bit_pitch
        marker_y = center_y + opening_y / 2.0 + 1.8
        for index in range(4):
            pieces.append(
                cylinder(
                    f"dip_bit_{3 - index}_marker",
                    marker_diameter / 2.0,
                    marker_z,
                    20,
                    (
                        first_bit_x + index * bit_pitch,
                        marker_y,
                        panel_z + marker_z / 2.0,
                    ),
                )
            )
        arrow_y = center_y - opening_y / 2.0 - 2.2
        pieces.append(
            convex_prism(
                "dip_on_direction_marker",
                [(-2.5, -1.6), (2.5, -1.6), (0.0, 1.8)],
                marker_z,
                panel_z + marker_z / 2.0,
            ).translated((center_x, arrow_y, 0.0))
        )
    return merge("compact_rear_fascia", pieces).centered_for_print(
        "compact_rear_fascia"
    )


def build_dip_retainer(config: dict[str, Any]) -> Mesh:
    dip = config["dip_switch"]
    clearance = float(dip["retainer_cage_clearance"])
    wall = float(dip["retainer_cage_wall"])
    frame_z = float(dip["retainer_frame_z"])
    inner_x = float(dip["x"]) + 2.0 * clearance
    inner_y = float(dip["y"]) + 2.0 * clearance
    outer_x = inner_x + 2.0 * wall
    outer_y = inner_y + 2.0 * wall
    cage_z = float(dip["z"]) + clearance
    pieces: list[Mesh] = [
        rectangular_frame(
            "compact_dip_retainer_frame",
            outer_x,
            outer_y,
            inner_x,
            inner_y,
            frame_z,
        ),
        box(
            "compact_dip_cage_left",
            (wall, outer_y, cage_z),
            (-(inner_x + wall) / 2.0, 0.0, frame_z + cage_z / 2.0),
        ),
        box(
            "compact_dip_cage_right",
            (wall, outer_y, cage_z),
            ((inner_x + wall) / 2.0, 0.0, frame_z + cage_z / 2.0),
        ),
        box(
            "compact_dip_cage_bottom",
            (inner_x, wall, cage_z),
            (0.0, -(inner_y + wall) / 2.0, frame_z + cage_z / 2.0),
        ),
        box(
            "compact_dip_cage_top",
            (inner_x, wall, cage_z),
            (0.0, (inner_y + wall) / 2.0, frame_z + cage_z / 2.0),
        ),
    ]
    bridge_y = float(dip["retainer_back_bridge_y"])
    for label, sign in (("bottom", -1.0), ("top", 1.0)):
        pieces.append(
            box(
                f"compact_dip_back_bridge_{label}",
                (outer_x, bridge_y, wall),
                (
                    0.0,
                    sign * (outer_y / 2.0 - bridge_y / 2.0),
                    frame_z + cage_z + wall / 2.0,
                ),
            )
        )

    screw_opening = (
        float(dip["retainer_screw_diameter"])
        + float(dip["retainer_screw_clearance"])
    )
    screw_radius = screw_opening / 2.0
    for label, sign in (("left", -1.0), ("right", 1.0)):
        pieces.append(
            ring(
                f"compact_dip_screw_lug_{label}",
                screw_radius + 1.8,
                screw_radius,
                frame_z,
                32,
                (
                    sign * float(dip["retainer_screw_pitch_x"]) / 2.0,
                    0.0,
                    frame_z / 2.0,
                ),
            )
        )
    return merge("compact_dip_retainer", pieces).centered_for_print(
        "compact_dip_retainer"
    )


def build_display_retainer(config: dict[str, Any]) -> Mesh:
    display = config["display"]
    clearance = float(config["manufacturing"]["clearance_xy"])
    outer_x = float(display["board_x"]) + 7.0
    outer_y = float(display["board_y"]) + 7.0
    pieces: list[Mesh] = [
        rectangular_frame(
            "compact_display_retainer_frame",
            outer_x,
            outer_y,
            float(display["board_x"]) + 2.0 * clearance,
            float(display["board_y"]) + 2.0 * clearance,
            3.0,
        )
    ]
    hole_radius = (float(display["hole_diameter"]) + float(display["hole_clearance"])) / 2.0
    for x_position in (
        -float(display["hole_pitch_x"]) / 2.0,
        float(display["hole_pitch_x"]) / 2.0,
    ):
        for y_position in (
            -float(display["hole_pitch_y"]) / 2.0,
            float(display["hole_pitch_y"]) / 2.0,
        ):
            pieces.append(
                ring(
                    "display_screw_lug",
                    hole_radius + 1.8,
                    hole_radius,
                    3.0,
                    32,
                    (x_position, y_position, 1.5),
                )
            )
    return merge("compact_display_retainer", pieces).centered_for_print(
        "compact_display_retainer"
    )


def build_lock_battery_clip(config: dict[str, Any]) -> Mesh:
    battery = config["lock_battery"]
    return bridge_clip(
        "compact_lock_battery_clip",
        float(battery["y"]),
        float(battery["z"]),
        12.0,
        2.2,
        0.35,
    ).centered_for_print("compact_lock_battery_clip")


def build_parts(config: dict[str, Any]) -> dict[str, dict[str, Any]]:
    builders: dict[str, Callable[[dict[str, Any]], Mesh]] = {
        "compact_key_lower_shell": build_key_lower_shell,
        "compact_key_top_cover": build_key_top_cover,
        "compact_key_control_panel": build_key_control_panel,
        "compact_key_button_cap": build_key_button_cap,
        "compact_key_slide_knob": build_key_slide_knob,
        "compact_key_battery_clip": build_key_battery_clip,
        "compact_lock_lower_housing": build_lock_lower_housing,
        "compact_lock_body_front": build_lock_body_front,
        "compact_lock_body_rear": build_lock_body_rear,
        "compact_lock_top_cover": build_lock_top_cover,
        "compact_uwb_cassette": build_uwb_cassette,
        "compact_rear_fascia": build_rear_fascia,
        "compact_dip_retainer": build_dip_retainer,
        "compact_display_retainer": build_display_retainer,
        "compact_lock_battery_clip": build_lock_battery_clip,
    }
    parts: dict[str, dict[str, Any]] = {}
    for spec in compact_part_plan(config):
        parts[spec.name] = {
            "mesh": builders[spec.name](config),
            "quantity": spec.quantity,
            "attachment": spec.attachment,
            "requires_glue": spec.requires_glue,
        }
    return parts


def vertical_at_radial(mesh: Mesh, x: float, y: float, z: float) -> Mesh:
    angle = math.degrees(math.atan2(y, x))
    return mesh.rotated_x(90.0).rotated_z(angle + 90.0).translated((x, y, z))


def key_scene(config: dict[str, Any], exploded: bool) -> list[SceneObject]:
    key = config["key_shell"]
    layout = config.get(
        "key_layout",
        {
            "battery_center_x": -16.0,
            "power_board_center_x": 9.0,
            "power_board_x": 25.0,
            "power_board_y": 22.0,
            "power_board_z": 8.0,
            "uwb_center_x": 30.0,
        },
    )
    manufacturing = config["manufacturing"]
    base = build_key_lower_shell(config)
    cover_print = build_key_top_cover(config)
    cover = cover_print.rotated_x(180.0)
    cover_lift = 52.0 if exploded else float(key["base_z"]) + float(key["lid_z"])
    cover = cover.translated((0.0, 0.0, cover_lift))
    battery = config["key_battery"]
    uwb = config["uwb"]
    electronics_lift = 24.0 if exploded else 0.0
    battery_mesh = box(
        "key_battery_scene",
        (float(battery["x"]), float(battery["y"]), float(battery["z"])),
        (
            float(layout["battery_center_x"]),
            0.0,
            float(manufacturing["floor"]) + electronics_lift + float(battery["z"]) / 2.0,
        ),
    )
    uwb_mesh = box(
        "key_uwb_scene",
        (float(uwb["board_x"]), float(uwb["board_y"]), float(uwb["assembly_z"])),
        (
            float(layout["uwb_center_x"]),
            0.0,
            float(manufacturing["floor"]) + electronics_lift + float(uwb["assembly_z"]) / 2.0,
        ),
    )
    power_mesh = box(
        "key_power_scene",
        (
            float(layout["power_board_x"]),
            float(layout["power_board_y"]),
            float(layout["power_board_z"]),
        ),
        (
            float(layout["power_board_center_x"]),
            0.0,
            float(manufacturing["floor"])
            + electronics_lift
            + float(layout["power_board_z"]) / 2.0,
        ),
    )
    objects = [
        SceneObject(base, (52, 55, 59)),
        SceneObject(battery_mesh, (219, 130, 53)),
        SceneObject(uwb_mesh, (34, 121, 156)),
        SceneObject(power_mesh, (59, 103, 150)),
        SceneObject(cover, (48, 51, 55)),
    ]
    if has_v0_4_features(config):
        controls = config["key_controls"]
        panel_outer_z = cover_lift + (14.0 if exploded else 0.0)
        panel = build_key_control_panel(config).rotated_x(180.0).translated(
            (0.0, 0.0, panel_outer_z)
        )
        button_outer_z = panel_outer_z + float(controls["button_head_z"]) + (
            12.0 if exploded else 0.0
        )
        button = build_key_button_cap(config).rotated_x(180.0).translated(
            (
                float(controls["button_center_x"]),
                float(controls["button_center_y"]),
                button_outer_z,
            )
        )
        slide_outer_z = panel_outer_z + float(controls["slide_knob_z"]) + (
            12.0 if exploded else 0.0
        )
        slide = build_key_slide_knob(config).rotated_x(180.0).translated(
            (
                float(controls["slide_center_x"]),
                float(controls["slide_center_y"]),
                slide_outer_z,
            )
        )
        led = cylinder(
            "key_status_led_scene",
            float(config["key_shell"]["led_diameter"]) / 2.0,
            3.6,
            32,
            (
                float(controls["led_center_x"]),
                float(controls["led_center_y"]),
                panel_outer_z + 1.8 + (12.0 if exploded else 0.0),
            ),
        )
        board_z = float(controls["control_board_z"])
        board_center_world_z = panel_outer_z - float(controls["control_board_center_z"])
        control_board = box(
            "key_control_board_scene",
            (
                float(controls["control_board_x"]),
                float(controls["control_board_y"]),
                board_z,
            ),
            (0.0, 0.0, board_center_world_z),
        )
        button_switch_height = float(controls["button_switch_height"])
        button_switch = box(
            "key_button_switch_scene",
            (6.0, 6.0, button_switch_height),
            (
                float(controls["button_center_x"]),
                float(controls["button_center_y"]),
                board_center_world_z + board_z / 2.0 + button_switch_height / 2.0,
            ),
        )
        slide_switch_height = float(controls["slide_switch_height"])
        slide_switch = box(
            "key_slide_switch_scene",
            (10.0, 5.0, slide_switch_height),
            (
                float(controls["slide_center_x"]),
                float(controls["slide_center_y"]),
                board_center_world_z + board_z / 2.0 + slide_switch_height / 2.0,
            ),
        )
        slide_actuator_z = float(controls["slide_actuator_z"])
        slide_actuator = box(
            "key_slide_actuator_scene",
            (
                float(controls["slide_actuator_x"]),
                float(controls["slide_actuator_y"]),
                slide_actuator_z,
            ),
            (
                float(controls["slide_center_x"]),
                float(controls["slide_center_y"]),
                board_center_world_z
                + board_z / 2.0
                + slide_switch_height
                + slide_actuator_z / 2.0,
            ),
        )
        objects.extend(
            [
                SceneObject(panel, (72, 76, 83)),
                SceneObject(button, (42, 45, 50)),
                SceneObject(slide, (82, 86, 92)),
                SceneObject(led, (47, 201, 95)),
                SceneObject(control_board, (42, 106, 151)),
                SceneObject(button_switch, (64, 68, 74)),
                SceneObject(slide_switch, (64, 68, 74)),
                SceneObject(slide_actuator, (185, 188, 194)),
            ]
        )
    return objects


def lock_scene(config: dict[str, Any], exploded: bool) -> list[SceneObject]:
    lock = config["compact_lock"]
    if str(config["revision"]) == "0.5":
        halves = build_lock_body_halves(config)
        split_lift = 30.0 if exploded else 0.0
        objects = [
            SceneObject(
                halves["front"].translated((0.0, split_lift, 0.0)),
                (50, 54, 59),
            ),
            SceneObject(
                halves["rear"].translated((0.0, -split_lift, 0.0)),
                (64, 68, 74),
            ),
        ]
    else:
        objects = [SceneObject(build_lock_lower_housing(config), (50, 54, 59))]
    cover_print = build_lock_top_cover(config)
    cover_z = (
        float(lock["lower_wall_height"])
        + float(lock["top_cover_z"])
        + (80.0 if exploded else 0.0)
    )
    cover = cover_print.rotated_x(180.0).translated((0.0, 0.0, cover_z))
    objects.append(SceneObject(cover, (61, 65, 70)))

    pcb = config["vehicle_pcb"]
    battery = config["lock_battery"]
    electronics_lift = 42.0 if exploded else 0.0
    objects.append(
        SceneObject(
            box(
                "pcb_scene",
                (float(pcb["x"]), float(pcb["y"]), float(pcb["assembly_z"])),
                (
                    0.0,
                    float(lock["pcb_center_y"]),
                    float(lock["lower_floor_z"]) + electronics_lift + float(pcb["assembly_z"]) / 2.0,
                ),
            ),
            (86, 76, 145),
        )
    )
    objects.append(
        SceneObject(
            box(
                "lock_battery_scene",
                (float(battery["x"]), float(battery["y"]), float(battery["z"])),
                (
                    0.0,
                    float(lock["battery_center_y"]),
                    float(lock["lower_floor_z"]) + electronics_lift + float(battery["z"]) / 2.0,
                ),
            ),
            (215, 127, 54),
        )
    )

    cassette = build_uwb_cassette(config)
    uwb = config["uwb"]
    board = box(
        "uwb_board_scene",
        (float(uwb["board_x"]), float(uwb["board_y"]), 2.0),
        (0.0, 0.0, 1.0),
    )
    for anchor in config["anchors"]:
        cassette_mesh = vertical_at_radial(
            cassette,
            float(anchor["x"]),
            float(anchor["y"]),
            float(anchor["z"]) + electronics_lift,
        )
        board_mesh = vertical_at_radial(
            board,
            float(anchor["x"]),
            float(anchor["y"]),
            float(anchor["z"]) + electronics_lift,
        )
        objects.extend(
            [
                SceneObject(cassette_mesh, (37, 41, 45)),
                SceneObject(board_mesh, (34, 121, 156)),
            ]
        )

    fascia_lift = 90.0 if exploded else 0.0
    fascia = build_rear_fascia(config).rotated_x(90.0).translated(
        (
            0.0,
            float(lock["rear_fascia_plane_y"]),
            float(lock["rear_fascia_center_z"]) + fascia_lift,
        )
    )
    display = config["display"]
    display_board = box(
        "display_scene",
        (float(display["board_x"]), float(display["board_y"]), 2.0),
        (0.0, 0.0, 1.0),
    ).rotated_x(90.0).translated(
        (
            0.0,
            float(lock["rear_fascia_plane_y"]) + 3.0,
            float(lock["rear_fascia_center_z"]) + 9.0 + fascia_lift,
        )
    )
    objects.extend(
        [
            SceneObject(fascia, (35, 38, 42)),
            SceneObject(display_board, (24, 97, 132)),
        ]
    )
    if has_v0_4_features(config):
        dip = config["dip_switch"]
        dip_world_z = float(lock["rear_fascia_center_z"]) + float(
            dip["panel_center_y"]
        )
        dip_retainer = build_dip_retainer(config).rotated_x(-90.0).translated(
            (
                float(dip["panel_center_x"]),
                float(lock["rear_fascia_plane_y"]),
                dip_world_z,
            )
        )
        dip_body = box(
            "dip_switch_scene",
            (float(dip["x"]), float(dip["y"]), float(dip["z"])),
            (0.0, 0.0, float(dip["z"]) / 2.0),
        ).rotated_x(-90.0).translated(
            (
                float(dip["panel_center_x"]),
                float(lock["rear_fascia_plane_y"]),
                dip_world_z,
            )
        )
        objects.extend(
            [
                SceneObject(dip_retainer, (72, 76, 82)),
                SceneObject(dip_body, (47, 55, 65)),
            ]
        )
    return objects


def config_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def part_fits_bed(mesh: Mesh, config: dict[str, Any]) -> bool:
    brim = float(config["print_process"]["brim_width"])
    return (
        float(mesh.dimensions[0]) + 2.0 * brim <= float(config["printer"]["bed_x"])
        and float(mesh.dimensions[1]) + 2.0 * brim <= float(config["printer"]["bed_y"])
    )


def clean_output(output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    generated_suffixes = {".stl", ".png", ".svg"}
    generated_names = {"README.md", "validation_report.json", "validation_reload_report.json"}
    for path in output.iterdir():
        if path.is_file() and (path.suffix.lower() in generated_suffixes or path.name in generated_names):
            path.unlink()


def generate(config: dict[str, Any], config_path: Path, output: Path) -> dict[str, Any]:
    clean_output(output)
    parts = build_parts(config)
    report_parts: dict[str, Any] = {}
    failures: list[str] = []
    for name, details in parts.items():
        mesh = details["mesh"].centered_for_print(name)
        validation = edge_count_validation(mesh)
        validation["quantity"] = details["quantity"]
        validation["attachment"] = details["attachment"]
        validation["requires_glue"] = details["requires_glue"]
        validation["fits_configured_bed_with_brim"] = part_fits_bed(mesh, config)
        validation["estimated_mass_g_each"] = round(
            abs(float(validation["signed_volume_mm3"]))
            / 1000.0
            * float(config["printer"]["filament_density_g_cm3"]),
            2,
        )
        report_parts[name] = validation
        if (
            validation["degenerate_triangles"]
            or not validation["watertight_by_edges"]
            or not validation["fits_configured_bed_with_brim"]
        ):
            failures.append(name)
        export_binary_stl(mesh, output / f"{name}.stl")

    revision = str(config["revision"])
    render_scene(
        key_scene(config, exploded=False),
        output / "preview_key_assembled.png",
        f"C Problem - Compact Product Key v{revision}",
        (1500, 1050),
        -50.0,
        30.0,
    )
    render_scene(
        key_scene(config, exploded=True),
        output / "preview_key_exploded.png",
        f"C Problem - Compact Product Key Exploded v{revision}",
        (1500, 1100),
        -50.0,
        30.0,
    )
    render_scene(
        lock_scene(config, exploded=False),
        output / "preview_lock_assembled.png",
        f"C Problem - Compact Smart Lock v{revision}",
        (1600, 1250),
        -55.0,
        36.0,
    )
    render_scene(
        lock_scene(config, exploded=True),
        output / "preview_lock_exploded.png",
        f"C Problem - Compact Smart Lock Exploded v{revision}",
        (1600, 1350),
        -55.0,
        42.0,
    )

    key_model = [
        float(config["key_shell"]["outer_x"]),
        float(config["key_shell"]["outer_y"]),
        float(config["key_shell"]["assembled_z"]),
    ]
    key_limit = [
        float(config["official_envelope"]["key_x"]),
        float(config["official_envelope"]["key_y"]),
        float(config["official_envelope"]["key_z"]),
    ]
    envelope = {
        "key_model_mm": key_model,
        "key_limit_mm": key_limit,
        "key_pass": all(model <= limit for model, limit in zip(key_model, key_limit)),
        "lock_model_diameter_mm": float(config["compact_lock"]["assembled_diameter"]),
        "lock_model_height_mm": float(config["compact_lock"]["assembled_height"]),
        "lock_limit_diameter_mm": float(config["official_envelope"]["lock_diameter"]),
        "lock_limit_height_mm": float(config["official_envelope"]["lock_height"]),
    }
    envelope["lock_pass"] = (
        envelope["lock_model_diameter_mm"] <= envelope["lock_limit_diameter_mm"]
        and envelope["lock_model_height_mm"] <= envelope["lock_limit_height_mm"]
    )
    if not envelope["key_pass"] or not envelope["lock_pass"]:
        failures.append("official_envelope")

    report = {
        "model_status": model_status(config),
        "design_variant": config["design_variant"],
        "config": str(config_path),
        "config_sha256": config_hash(config_path),
        "clearance_verified": bool(config["manufacturing"]["clearance_verified"]),
        "anchor_layout_status": config["anchor_layout_status"],
        "official_envelope": envelope,
        "all_meshes_passed_closed_shell_validation": not failures,
        "failed_items": failures,
        "unique_stl_count": len(report_parts),
        "print_instance_count": sum(int(item["quantity"]) for item in report_parts.values()),
        "estimated_total_mass_g_before_slicer_settings": round(
            sum(
                float(item["estimated_mass_g_each"]) * int(item["quantity"])
                for item in report_parts.values()
            ),
            1,
        ),
        "parts": report_parts,
        "remaining_measurements": [
            "公差试片最终选定间隙",
            "UWB Type-C 方向、接口高度与天线禁布区",
            "100×55 mm PCB 孔位与最高器件",
            "ST7735S 模块厚度、排针突出高度与连接器方向",
            "启动按键、拨动开关、LED、蜂鸣器与电源板尺寸",
            "装配后 A1/A2/A3 天线参考点坐标",
        ],
    }
    (output / "validation_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    lines = [
        f"# C 题紧凑型免拼壳外壳 v{revision}",
        "",
        f"状态：**{model_status(config)}**。",
        "",
        "| STL | 数量 | 尺寸 mm | 连接方式 | CR-3040D + brim |",
        "| --- | ---: | --- | --- | --- |",
    ]
    for name, details in report_parts.items():
        dimensions = " × ".join(str(value) for value in details["dimensions_mm"])
        fit = "通过" if details["fits_configured_bed_with_brim"] else "失败"
        lines.append(
            f"| `{name}.stl` | {details['quantity']} | {dimensions} | "
            f"{details['attachment']} | {fit} |"
        )
    shell_description = (
        "主壳沿 Y=0 分为前后两半，使用四组插舌/U 形插槽定位并预留胶粘接缝。"
        if revision == "0.5"
        else "主壳为一体底壳和一体上盖，不需要扇区粘接。"
    )
    lines.extend(
        [
            "",
            f"钥匙名义包络：`{' × '.join(str(value) for value in key_model)} mm`。",
            f"门锁名义包络：`Ø{envelope['lock_model_diameter_mm']} × "
            f"{envelope['lock_model_height_mm']} mm`。",
            "",
            shell_description,
            "当前间隙与锚点仍是候选值；软件验证不代表实机装配或定位通过。",
        ]
    )
    (output / "README.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    if failures:
        raise RuntimeError(f"v{revision} validation failed: {', '.join(failures)}")
    return report


def validate_existing(output: Path) -> dict[str, Any]:
    paths = sorted(output.glob("*.stl"))
    if not paths:
        raise FileNotFoundError(f"no STL files in {output}")
    results: dict[str, Any] = {}
    failed: list[str] = []
    for path in paths:
        validation = edge_count_validation(load_binary_stl(path))
        results[path.name] = validation
        if validation["degenerate_triangles"] or not validation["watertight_by_edges"]:
            failed.append(path.name)
    summary = {"files": len(paths), "failed": failed, "results": results}
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
    config = load_compact_config(args.config)
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
                "parts": report["unique_stl_count"],
                "instances": report["print_instance_count"],
                "output": str(args.output),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
