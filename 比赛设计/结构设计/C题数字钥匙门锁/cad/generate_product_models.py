#!/usr/bin/env python3
"""Generate the integrated product-style C-problem enclosure (v0.2)."""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
from typing import Any, Iterable, Sequence

from generate_models import bridge_clip, corner_stops, rectangular_frame, tiled_panel
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
    ring_sector,
    u_channel,
)


MODEL_STATUS = "v0.2 CR-3040D/PETG 切片候选版"


def load_config(path: Path) -> dict[str, Any]:
    config = json.loads(path.read_text(encoding="utf-8"))
    if config.get("units") != "mm" or config.get("revision") != "0.2":
        raise ValueError("generate_product_models.py requires the millimetre v0.2 parameter file")
    return config


def chamfered_profile(length: float, width: float, chamfer: float) -> list[tuple[float, float]]:
    if min(length, width) <= 2.0 * chamfer:
        raise ValueError("chamfer is too large for the requested profile")
    half_x, half_y = length / 2.0, width / 2.0
    return [
        (-half_x + chamfer, -half_y),
        (half_x - chamfer, -half_y),
        (half_x, -half_y + chamfer),
        (half_x, half_y - chamfer),
        (half_x - chamfer, half_y),
        (-half_x + chamfer, half_y),
        (-half_x, half_y - chamfer),
        (-half_x, -half_y + chamfer),
    ]


def edge_wall(
    name: str,
    start: Sequence[float],
    end: Sequence[float],
    wall: float,
    height: float,
    bottom_z: float,
    fraction_start: float = 0.0,
    fraction_end: float = 1.0,
) -> Mesh:
    x0, y0 = float(start[0]), float(start[1])
    x1, y1 = float(end[0]), float(end[1])
    dx, dy = x1 - x0, y1 - y0
    full_length = math.hypot(dx, dy)
    tangent_x, tangent_y = dx / full_length, dy / full_length
    segment_start_x = x0 + dx * fraction_start
    segment_start_y = y0 + dy * fraction_start
    segment_end_x = x0 + dx * fraction_end
    segment_end_y = y0 + dy * fraction_end
    segment_length = full_length * (fraction_end - fraction_start)
    midpoint_x = (segment_start_x + segment_end_x) / 2.0
    midpoint_y = (segment_start_y + segment_end_y) / 2.0
    inward_x, inward_y = -tangent_y, tangent_x
    center_x = midpoint_x + inward_x * wall / 2.0
    center_y = midpoint_y + inward_y * wall / 2.0
    angle = math.degrees(math.atan2(tangent_y, tangent_x))
    return box(
        name,
        (segment_length, wall, height),
        (0.0, 0.0, bottom_z + height / 2.0),
    ).rotated_z(angle).translated((center_x, center_y, 0.0))


def build_key_lower_shell(config: dict[str, Any]) -> Mesh:
    key = config["key_shell"]
    layout = config.get(
        "key_layout",
        {
            "battery_center_x": -16.0,
            "power_board_center_x": 9.0,
            "power_board_x": 25.0,
            "power_board_y": 22.0,
            "uwb_center_x": 30.0,
        },
    )
    manufacturing = config["manufacturing"]
    battery = config["key_battery"]
    uwb = config["uwb"]
    profile = chamfered_profile(key["outer_x"], key["outer_y"], key["corner_chamfer"])
    floor = manufacturing["floor"]
    wall = manufacturing["wall"]
    base_height = key["base_z"]
    pieces: list[Mesh] = [convex_prism("key_floor", profile, floor, floor / 2.0)]
    for index, start in enumerate(profile):
        end = profile[(index + 1) % len(profile)]
        if index != 2:
            pieces.append(edge_wall(f"key_wall_{index}", start, end, wall, base_height, 0.0))
            continue
        edge_length = math.dist(start, end)
        gap = key["service_opening"]
        side_fraction = (edge_length - gap) / (2.0 * edge_length)
        pieces.append(edge_wall("key_port_wall_lower", start, end, wall, base_height, 0.0, 0.0, side_fraction))
        pieces.append(
            edge_wall("key_port_wall_upper", start, end, wall, base_height, 0.0, 1.0 - side_fraction, 1.0)
        )
        port_height = config["uwb"]["type_c_opening_z"]
        bridge_height = base_height - floor - port_height
        pieces.append(
            edge_wall(
                "key_port_bridge",
                start,
                end,
                wall,
                bridge_height,
                floor + port_height,
                side_fraction,
                1.0 - side_fraction,
            )
        )
    pieces.extend(
        [
            corner_stops(
                "product_key_battery_stops",
                battery["x"],
                battery["y"],
                float(layout["battery_center_x"]),
                0.0,
                floor,
                7.0,
            ),
            corner_stops(
                "product_key_uwb_stops",
                uwb["board_x"],
                uwb["board_y"],
                float(layout["uwb_center_x"]),
                0.0,
                floor,
                9.0,
            ),
            box(
                "key_power_board_rail_left",
                (float(layout["power_board_x"]) + 1.0, 2.4, 6.0),
                (
                    float(layout["power_board_center_x"]),
                    -float(layout["power_board_y"]) / 2.0 - 2.5,
                    floor + 3.0,
                ),
            ),
            box(
                "key_power_board_rail_right",
                (float(layout["power_board_x"]) + 1.0, 2.4, 6.0),
                (
                    float(layout["power_board_center_x"]),
                    float(layout["power_board_y"]) / 2.0 + 2.5,
                    floor + 3.0,
                ),
            ),
        ]
    )
    return merge("product_key_lower_shell", pieces).centered_for_print("product_key_lower_shell")


def build_key_top_cover(config: dict[str, Any]) -> Mesh:
    key = config["key_shell"]
    profile = chamfered_profile(key["outer_x"] - 0.7, key["outer_y"] - 0.7, key["corner_chamfer"])
    decorative = chamfered_profile(key["outer_x"] - 13.0, key["outer_y"] - 13.0, key["corner_chamfer"] - 2.0)
    lid_z = key["lid_z"]
    pieces = [
        convex_prism("key_cover_plate", profile, lid_z, lid_z / 2.0),
        convex_prism("key_cover_decor", decorative, 1.0, lid_z + 0.5),
        ring("key_button_rim", key["button_diameter"] / 2.0 + 2.2, key["button_diameter"] / 2.0 + 0.4, 2.2, 48, (-15.0, 0.0, lid_z + 1.1)),
        cylinder("key_status_led_rim", key["led_diameter"] / 2.0 + 1.0, 1.4, 32, (3.0, 0.0, lid_z + 0.7)),
        box("key_style_line_left", (22.0, 1.2, 0.8), (22.0, -14.0, lid_z + 0.4)),
        box("key_style_line_right", (22.0, 1.2, 0.8), (22.0, 14.0, lid_z + 0.4)),
    ]
    return merge("product_key_top_cover", pieces).centered_for_print("product_key_top_cover")


def build_key_lid_insert(config: dict[str, Any]) -> Mesh:
    key = config["key_shell"]
    inset = config["manufacturing"]["wall"] + config["manufacturing"]["clearance_xy"]
    profile = chamfered_profile(
        key["outer_x"] - 2.0 * inset,
        key["outer_y"] - 2.0 * inset,
        max(3.0, key["corner_chamfer"] - inset),
    )
    return convex_prism("key_lid_friction_insert", profile, 1.8, 0.9).centered_for_print(
        "key_lid_friction_insert"
    )


def build_key_button_cap(config: dict[str, Any]) -> Mesh:
    diameter = config["key_shell"]["button_diameter"]
    return merge(
        "key_button_cap",
        [
            cylinder("key_button_main", diameter / 2.0, 4.0, 48, (0.0, 0.0, 2.0)),
            cylinder("key_button_top", diameter / 2.0 - 1.0, 1.0, 48, (0.0, 0.0, 4.5)),
        ],
    ).centered_for_print("key_button_cap")


def build_key_ref_marker() -> Mesh:
    return convex_prism("key_ref_marker", [(-6.0, -4.0), (6.0, 0.0), (-6.0, 4.0)], 1.6, 0.8).centered_for_print(
        "key_ref_marker"
    )


def build_base_rim_sector(config: dict[str, Any]) -> Mesh:
    lock = config["product_lock"]
    half = lock["sector_deg"] / 2.0
    return ring_sector(
        "product_base_rim_sector",
        lock["outer_radius"],
        lock["rim_inner_radius"],
        lock["base_z"],
        -half,
        half,
        int(lock["sector_deg"]),
        (0.0, 0.0, lock["base_z"] / 2.0),
    ).centered_for_print("product_base_rim_sector")


def build_middle_ring_sector(config: dict[str, Any]) -> Mesh:
    lock = config["product_lock"]
    half = lock["sector_deg"] / 2.0
    return ring_sector(
        "product_middle_ring_sector",
        lock["middle_ring_outer_radius"],
        lock["middle_ring_inner_radius"],
        8.0,
        -half,
        half,
        int(lock["sector_deg"]),
        (0.0, 0.0, 4.0),
    ).centered_for_print("product_middle_ring_sector")


def build_spoke_segment(config: dict[str, Any], length: float) -> Mesh:
    lock = config["product_lock"]
    name = f"product_spoke_{length:.1f}mm".replace(".", "p")
    return u_channel(name, length, lock["spoke_width"], lock["spoke_z"], 2.0).centered_for_print(name)


def build_spoke_joiner(config: dict[str, Any]) -> Mesh:
    lock = config["product_lock"]
    clearance = config["manufacturing"]["clearance_xy"]
    return box(
        "product_spoke_joiner",
        (30.0, lock["spoke_width"] - 4.0 - 2.0 * clearance, lock["spoke_z"] - 2.8),
        (0.0, 0.0, (lock["spoke_z"] - 2.8) / 2.0),
    ).centered_for_print("product_spoke_joiner")


def build_center_base(config: dict[str, Any]) -> Mesh:
    lock = config["product_lock"]
    return cylinder("product_center_base", lock["center_base_radius"], 5.0, 80, (0.0, 0.0, 2.5)).centered_for_print(
        "product_center_base"
    )


def build_electronics_deck(config: dict[str, Any]) -> Mesh:
    lock = config["product_lock"]
    pcb = config["vehicle_pcb"]
    floor = lock["electronics_deck_z"]
    pieces = [
        cylinder("electronics_deck_disc", lock["electronics_deck_radius"], floor, 80, (0.0, 0.0, floor / 2.0)),
        corner_stops("electronics_pcb_stops", pcb["x"], pcb["y"], 0.0, 0.0, floor, 10.0),
        box("electronics_front_rail", (110.0, 3.0, 6.0), (0.0, 35.0, floor + 3.0)),
        box("electronics_rear_rail", (110.0, 3.0, 6.0), (0.0, -35.0, floor + 3.0)),
    ]
    return merge("product_electronics_deck", pieces).centered_for_print("product_electronics_deck")


def build_outer_shell_sector(config: dict[str, Any]) -> Mesh:
    lock = config["product_lock"]
    half = lock["sector_deg"] / 2.0
    height = lock["shell_top_z"] - lock["shell_bottom_z"]
    return annular_frustum_sector(
        "product_outer_shell_sector",
        lock["outer_radius"],
        lock["shell_outer_top_radius"],
        lock["shell_inner_bottom_radius"],
        lock["shell_inner_top_radius"],
        height,
        -half,
        half,
        int(lock["sector_deg"]),
        (lock["shell_bottom_z"] + lock["shell_top_z"]) / 2.0,
    ).centered_for_print("product_outer_shell_sector")


def build_top_outer_sector(config: dict[str, Any]) -> Mesh:
    lock = config["product_lock"]
    half = lock["sector_deg"] / 2.0
    return ring_sector(
        "product_top_outer_sector",
        lock["shell_outer_top_radius"],
        lock["top_outer_inner_radius"],
        lock["top_outer_z"],
        -half,
        half,
        int(lock["sector_deg"]),
        (0.0, 0.0, lock["top_outer_z"] / 2.0),
    ).centered_for_print("product_top_outer_sector")


def build_top_inner_sector(config: dict[str, Any]) -> Mesh:
    lock = config["product_lock"]
    angle = lock["top_inner_sector_deg"]
    return ring_sector(
        "product_top_inner_sector",
        lock["top_inner_outer_radius"],
        lock["top_cover_inner_radius"],
        lock["top_inner_z"],
        -angle / 2.0,
        angle / 2.0,
        int(angle),
        (0.0, 0.0, lock["top_inner_z"] / 2.0),
    ).centered_for_print("product_top_inner_sector")


def build_center_service_lid(config: dict[str, Any]) -> Mesh:
    lock = config["product_lock"]
    return merge(
        "product_center_service_lid",
        [
            cylinder("service_lid_disc", lock["center_lid_radius"], lock["center_lid_z"], 80, (0.0, 0.0, lock["center_lid_z"] / 2.0)),
            ring("service_lid_rim", lock["center_lid_radius"] - 4.0, lock["center_lid_radius"] - 6.0, 2.0, 80, (0.0, 0.0, lock["center_lid_z"] + 1.0)),
        ],
    ).centered_for_print("product_center_service_lid")


def build_top_handle(config: dict[str, Any]) -> Mesh:
    lock = config["product_lock"]
    length, width, height = lock["handle_x"], lock["handle_y"], lock["handle_z"]
    radius = width / 2.0
    straight = length - width
    return merge(
        "product_top_handle",
        [
            box("handle_center", (straight, width, height), (0.0, 0.0, height / 2.0)),
            cylinder("handle_left", radius, height, 48, (-straight / 2.0, 0.0, height / 2.0)),
            cylinder("handle_right", radius, height, 48, (straight / 2.0, 0.0, height / 2.0)),
            box("handle_recess", (straight - 10.0, width - 12.0, 1.2), (0.0, 0.0, height + 0.6)),
        ],
    ).centered_for_print("product_top_handle")


def build_uwb_cassette(config: dict[str, Any]) -> Mesh:
    uwb = config["uwb"]
    clearance = config["manufacturing"]["clearance_xy"]
    outer_x = uwb["board_x"] + 9.0
    outer_y = uwb["board_y"] + 9.0
    inner_x = uwb["board_x"] + 2.0 * clearance
    inner_y = uwb["board_y"] + 2.0 * clearance
    frame = rectangular_frame("uwb_cassette_frame", outer_x, outer_y, inner_x, inner_y, 3.0)
    pieces = [
        frame,
        box("uwb_cassette_top_clip", (8.0, 3.0, 5.0), (0.0, outer_y / 2.0 - 1.5, 5.5)),
        box("uwb_cassette_bottom_clip", (8.0, 3.0, 5.0), (0.0, -outer_y / 2.0 + 1.5, 5.5)),
        box("uwb_shell_tongue", (16.0, 8.0, 4.0), (0.0, 0.0, 5.0)),
    ]
    return merge("product_uwb_cassette", pieces).centered_for_print("product_uwb_cassette")


def rear_control_holes(config: dict[str, Any]) -> list[tuple[float, float, float, float]]:
    display = config["display"]
    dip = config["dip_switch"]
    controls = config["controls"]
    return [
        (0.0, 10.0, display["visible_x"] + 0.8, display["visible_y"] + 0.8),
        (-31.0, -25.0, dip["x"] + dip["panel_clearance"], dip["y"] + dip["panel_clearance"]),
        (-8.0, -25.0, controls["lock_led_diameter"] + 0.6, controls["lock_led_diameter"] + 0.6),
        (8.0, -25.0, controls["lock_led_diameter"] + 0.6, controls["lock_led_diameter"] + 0.6),
        (24.0, -25.0, controls["welcome_led_diameter"] + 0.6, controls["welcome_led_diameter"] + 0.6),
        (43.0, -25.0, controls["debug_opening_x"], controls["debug_opening_y"]),
    ]


def build_rear_fascia(config: dict[str, Any]) -> Mesh:
    lock = config["product_lock"]
    return tiled_panel(
        "product_rear_fascia",
        lock["rear_fascia_x"],
        lock["rear_fascia_y"],
        lock["rear_fascia_z"],
        rear_control_holes(config),
    ).centered_for_print("product_rear_fascia")


def build_display_cassette(config: dict[str, Any]) -> Mesh:
    display = config["display"]
    clearance = config["manufacturing"]["clearance_xy"]
    outer_x = display["board_x"] + 7.0
    outer_y = display["board_y"] + 7.0
    frame = rectangular_frame(
        "product_display_cassette_frame",
        outer_x,
        outer_y,
        display["board_x"] + 2.0 * clearance,
        display["board_y"] + 2.0 * clearance,
        3.0,
    )
    return merge(
        "product_display_cassette",
        [
            frame,
            box("display_retainer_left", (4.0, 10.0, 5.0), (-outer_x / 2.0 + 2.0, 0.0, 5.5)),
            box("display_retainer_right", (4.0, 10.0, 5.0), (outer_x / 2.0 - 2.0, 0.0, 5.5)),
        ],
    ).centered_for_print("product_display_cassette")


def build_display_bezel(config: dict[str, Any]) -> Mesh:
    display = config["display"]
    return rectangular_frame(
        "product_display_bezel",
        display["visible_x"] + 9.0,
        display["visible_y"] + 9.0,
        display["visible_x"],
        display["visible_y"],
        2.0,
    ).centered_for_print("product_display_bezel")


def build_sector_seam_clip(config: dict[str, Any]) -> Mesh:
    wall = config["manufacturing"]["clip_wall"]
    return merge(
        "product_sector_seam_clip",
        [
            box("sector_clip_bridge", (28.0, 10.0, wall), (0.0, 0.0, wall / 2.0)),
            box("sector_clip_left", (28.0, wall, 7.0), (0.0, -6.1, wall + 3.5)),
            box("sector_clip_right", (28.0, wall, 7.0), (0.0, 6.1, wall + 3.5)),
        ],
    ).centered_for_print("product_sector_seam_clip")


def validate_config(config: dict[str, Any]) -> None:
    official = config["official_envelope"]
    key = config["key_shell"]
    lock = config["product_lock"]
    if key["outer_x"] > official["key_x"] or key["outer_y"] > official["key_y"]:
        raise ValueError("product key footprint exceeds the official envelope")
    if 2.0 * lock["outer_radius"] > official["lock_diameter"]:
        raise ValueError("product lock diameter exceeds the official envelope")
    if lock["shell_inner_bottom_radius"] >= lock["outer_radius"]:
        raise ValueError("outer shell wall has no positive thickness")
    if lock["shell_inner_top_radius"] >= lock["shell_outer_top_radius"]:
        raise ValueError("upper shell wall has no positive thickness")


def spoke_plan(config: dict[str, Any]) -> tuple[float, int]:
    lock = config["product_lock"]
    length = lock["rim_inner_radius"] - lock["center_base_radius"]
    segment_count = max(1, math.ceil(length / lock["maximum_spoke_segment"]))
    return length / segment_count, segment_count


def build_parts(config: dict[str, Any]) -> dict[str, dict[str, Any]]:
    parts: dict[str, dict[str, Any]] = {}

    def add(name: str, mesh: Mesh, quantity: int, note: str) -> None:
        parts[name] = {"mesh": mesh, "quantity": quantity, "note": note}

    add("product_key_lower_shell", build_key_lower_shell(config), 1, "圆角倒角钥匙底壳")
    add("product_key_top_cover", build_key_top_cover(config), 1, "商品化顶盖与装饰层")
    add("key_lid_friction_insert", build_key_lid_insert(config), 1, "粘接在顶盖内侧的快拆定位片")
    add("key_button_cap", build_key_button_cap(config), 1, "启动按键帽；开孔待按键实物确认")
    add("key_ref_marker", build_key_ref_marker(), 1, "钥匙定位点三角标")
    add(
        "product_key_battery_clip",
        bridge_clip("product_key_battery_clip", config["key_battery"]["y"], config["key_battery"]["z"], 9.0, 2.2, 0.35),
        1,
        "503040 电池快拆压桥",
    )
    sector_count = int(round(360.0 / config["product_lock"]["sector_deg"]))
    add("product_base_rim_sector", build_base_rim_sector(config), sector_count, "隐藏分缝的底部外圈")
    add("product_middle_ring_sector", build_middle_ring_sector(config), sector_count, "底部中间加强环")
    segment_length, segment_count = spoke_plan(config)
    spoke_name = f"product_spoke_{segment_length:.1f}mm".replace(".", "p")
    add(spoke_name, build_spoke_segment(config, segment_length), 12 * segment_count, "隐藏式径向加强筋")
    if segment_count > 1:
        add(
            "product_spoke_joiner",
            build_spoke_joiner(config),
            12 * (segment_count - 1) + 2,
            "加强筋内插键，含 2 个备件",
        )
    add("product_center_base", build_center_base(config), 1, "底部中心基准盘")
    add("product_electronics_deck", build_electronics_deck(config), 1, "中层主控安装盘")
    add("product_outer_shell_sector", build_outer_shell_sector(config), sector_count, "装配后连续的薄壁锥形外壳")
    add("product_top_outer_sector", build_top_outer_sector(config), sector_count, "外圈顶盖扇区")
    inner_sector_count = int(round(360.0 / config["product_lock"]["top_inner_sector_deg"]))
    add("product_top_inner_sector", build_top_inner_sector(config), inner_sector_count, "内圈顶盖扇区")
    add("product_center_service_lid", build_center_service_lid(config), 1, "中央独立检修盖")
    add("product_top_handle", build_top_handle(config), 1, "检修盖提手")
    add("product_uwb_cassette", build_uwb_cassette(config), 3, "三枚等高 UWB 外壳卡匣")
    add("product_rear_fascia", build_rear_fascia(config), 1, "84×50 屏与控制件背面板")
    add("product_display_cassette", build_display_cassette(config), 1, "屏幕边缘夹持卡匣")
    add("product_display_bezel", build_display_bezel(config), 1, "可替换显示前框")
    add("product_sector_seam_clip", build_sector_seam_clip(config), sector_count * 2 + 4, "内侧隐藏拼缝扣，含 4 个备件")
    add(
        "product_lock_battery_clip",
        bridge_clip("product_lock_battery_clip", config["lock_battery"]["y"], config["lock_battery"]["z"], 12.0, 2.2, 0.35),
        2,
        "门锁电池组双压桥",
    )
    return parts


def vertical_at_radial(mesh: Mesh, x: float, y: float, z: float) -> Mesh:
    angle = math.degrees(math.atan2(y, x))
    return mesh.rotated_x(90.0).rotated_z(angle + 90.0).translated((x, y, z))


def lock_scene(config: dict[str, Any], exploded: bool) -> list[SceneObject]:
    lock = config["product_lock"]
    objects: list[SceneObject] = []
    sector_angle = lock["sector_deg"]
    sector_count = int(round(360.0 / sector_angle))
    shell_lift = 200.0 if exploded else 0.0
    deck_lift = 60.0 if exploded else 0.0
    deck_offset_y = -330.0 if exploded else 0.0

    for index in range(sector_count):
        start = index * sector_angle - sector_angle / 2.0
        end = index * sector_angle + sector_angle / 2.0
        objects.append(
            SceneObject(
                ring_sector(
                    f"base_rim_{index}", lock["outer_radius"], lock["rim_inner_radius"], lock["base_z"], start, end, int(sector_angle), (0.0, 0.0, lock["base_z"] / 2.0)
                ),
                (49, 53, 58),
            )
        )
        objects.append(
            SceneObject(
                ring_sector(
                    f"middle_ring_{index}", lock["middle_ring_outer_radius"], lock["middle_ring_inner_radius"], 8.0, start, end, int(sector_angle), (0.0, 0.0, 4.0)
                ),
                (63, 68, 74),
            )
        )
    center_base = cylinder("center_base_scene", lock["center_base_radius"], 5.0, 80, (0.0, 0.0, 2.5))
    objects.append(SceneObject(center_base, (55, 60, 66)))
    spoke_start = lock["center_base_radius"]
    spoke_end = lock["rim_inner_radius"]
    spoke_length = spoke_end - spoke_start
    for index in range(12):
        angle = index * 30.0
        spoke = u_channel("spoke_scene", spoke_length, lock["spoke_width"], lock["spoke_z"], 2.0)
        spoke = spoke.rotated_z(angle).translated(
            (
                math.cos(math.radians(angle)) * (spoke_start + spoke_length / 2.0),
                math.sin(math.radians(angle)) * (spoke_start + spoke_length / 2.0),
                5.0,
            )
        )
        objects.append(SceneObject(spoke, (73, 79, 86)))

    deck = build_electronics_deck(config).translated(
        (0.0, deck_offset_y, lock["electronics_deck_height"] + deck_lift)
    )
    objects.append(SceneObject(deck, (83, 89, 97)))
    pcb = config["vehicle_pcb"]
    battery = config["lock_battery"]
    battery_base_z = lock["electronics_deck_height"] + deck_lift + 5.0
    battery_placeholder = box(
        "battery_scene",
        (battery["x"], battery["y"], battery["z"]),
        (0.0, deck_offset_y, battery_base_z + battery["z"] / 2.0),
    )
    pcb_placeholder = box(
        "pcb_scene",
        (pcb["x"], pcb["y"], pcb["assembly_z"]),
        (
            0.0,
            deck_offset_y,
            lock["electronics_deck_height"] + deck_lift + 4.0 + pcb["assembly_z"] / 2.0,
        ),
    )
    objects.append(SceneObject(battery_placeholder, (215, 127, 54)))
    objects.append(SceneObject(pcb_placeholder, (86, 76, 145)))

    shell_height = lock["shell_top_z"] - lock["shell_bottom_z"]
    for index in range(sector_count):
        start = index * sector_angle - sector_angle / 2.0
        end = index * sector_angle + sector_angle / 2.0
        shell = annular_frustum_sector(
            f"outer_shell_{index}",
            lock["outer_radius"],
            lock["shell_outer_top_radius"],
            lock["shell_inner_bottom_radius"],
            lock["shell_inner_top_radius"],
            shell_height,
            start,
            end,
            int(sector_angle),
            (lock["shell_bottom_z"] + lock["shell_top_z"]) / 2.0 + shell_lift,
        )
        objects.append(SceneObject(shell, (54, 57, 61)))
        outer_top = ring_sector(
            f"top_outer_{index}",
            lock["shell_outer_top_radius"],
            lock["top_outer_inner_radius"],
            lock["top_outer_z"],
            start,
            end,
            int(sector_angle),
            (0.0, 0.0, lock["shell_top_z"] + lock["top_outer_z"] / 2.0 + shell_lift),
        )
        objects.append(SceneObject(outer_top, (61, 64, 68)))
    inner_angle = lock["top_inner_sector_deg"]
    inner_count = int(round(360.0 / inner_angle))
    for index in range(inner_count):
        start = index * inner_angle - inner_angle / 2.0
        end = index * inner_angle + inner_angle / 2.0
        inner_top = ring_sector(
            f"top_inner_{index}",
            lock["top_inner_outer_radius"],
            lock["top_cover_inner_radius"],
            lock["top_inner_z"],
            start,
            end,
            int(inner_angle),
            (0.0, 0.0, lock["shell_top_z"] + lock["top_outer_z"] + lock["top_inner_z"] / 2.0 + shell_lift),
        )
        objects.append(SceneObject(inner_top, (66, 69, 73)))
    lid = build_center_service_lid(config).translated((0.0, 0.0, lock["center_lid_bottom_z"] + shell_lift))
    handle = build_top_handle(config).translated(
        (0.0, 0.0, lock["center_lid_bottom_z"] + lock["center_lid_z"] + shell_lift)
    )
    objects.extend([SceneObject(lid, (70, 73, 77)), SceneObject(handle, (47, 50, 54))])

    cassette = build_uwb_cassette(config)
    uwb = config["uwb"]
    board_flat = box("uwb_board_scene", (uwb["board_x"], uwb["board_y"], 2.0), (0.0, 0.0, 1.0))
    for anchor in config["anchors"]:
        cassette_scene = vertical_at_radial(cassette, anchor["x"], anchor["y"], lock["anchor_reference_z"] + shell_lift)
        board_scene = vertical_at_radial(board_flat, anchor["x"], anchor["y"], lock["anchor_reference_z"] + shell_lift)
        objects.append(SceneObject(cassette_scene, (37, 41, 45)))
        objects.append(SceneObject(board_scene, (34, 121, 156)))

    fascia = build_rear_fascia(config).rotated_x(90.0).translated(
        (0.0, -294.0, lock["rear_fascia_center_z"] + shell_lift)
    )
    display = config["display"]
    display_board = box("display_scene", (display["board_x"], display["board_y"], 2.0), (0.0, 0.0, 1.0))
    display_board = display_board.rotated_x(90.0).translated(
        (0.0, -291.0, lock["rear_fascia_center_z"] + 10.0 + shell_lift)
    )
    objects.append(SceneObject(fascia, (35, 38, 42)))
    objects.append(SceneObject(display_board, (24, 97, 132)))
    return objects


def key_scene(config: dict[str, Any], exploded: bool) -> list[SceneObject]:
    key = config["key_shell"]
    manufacturing = config["manufacturing"]
    base = build_key_lower_shell(config)
    cover_z = 62.0 if exploded else key["base_z"]
    insert_z = 54.0 if exploded else key["base_z"] - 1.8
    electronics_lift = 29.0 if exploded else 0.0
    cover = build_key_top_cover(config).translated((0.0, 0.0, cover_z))
    insert = build_key_lid_insert(config).translated((0.0, 0.0, insert_z))
    button = build_key_button_cap(config).translated((-15.0, 0.0, cover_z + key["lid_z"] + 2.0))
    marker = build_key_ref_marker().translated((-45.0, 0.0, cover_z + key["lid_z"] + 1.0))
    battery = config["key_battery"]
    uwb = config["uwb"]
    battery_scene = box(
        "key_battery_scene",
        (battery["x"], battery["y"], battery["z"]),
        (-16.0, 0.0, manufacturing["floor"] + electronics_lift + battery["z"] / 2.0),
    )
    uwb_scene = box(
        "key_uwb_scene",
        (uwb["board_x"], uwb["board_y"], uwb["assembly_z"]),
        (30.0, 0.0, manufacturing["floor"] + electronics_lift + uwb["assembly_z"] / 2.0),
    )
    power_scene = box(
        "key_power_scene",
        (25.0, 22.0, 8.0),
        (9.0, 0.0, manufacturing["floor"] + electronics_lift + 4.0),
    )
    return [
        SceneObject(base, (52, 55, 59)),
        SceneObject(battery_scene, (219, 130, 53)),
        SceneObject(uwb_scene, (34, 121, 156)),
        SceneObject(power_scene, (59, 103, 150)),
        SceneObject(insert, (77, 81, 86)),
        SceneObject(cover, (48, 51, 55)),
        SceneObject(button, (28, 30, 33)),
        SceneObject(marker, (208, 211, 215)),
    ]


def part_fits_bed(mesh: Mesh, config: dict[str, Any]) -> bool:
    part_xy = sorted(float(value) for value in mesh.dimensions[:2])
    margin = float(config["printer"].get("bed_edge_margin", 0.0))
    bed_xy = sorted(
        (
            float(config["printer"]["bed_x"]) - 2.0 * margin,
            float(config["printer"]["bed_y"]) - 2.0 * margin,
        )
    )
    return part_xy[0] <= bed_xy[0] and part_xy[1] <= bed_xy[1]


def config_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def clean_output(output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    generated_suffixes = {".stl", ".png", ".svg"}
    generated_names = {"README.md", "validation_report.json", "validation_reload_report.json"}
    for path in output.iterdir():
        if path.is_file() and (path.suffix.lower() in generated_suffixes or path.name in generated_names):
            path.unlink()


def generate(config: dict[str, Any], config_path: Path, output: Path) -> dict[str, Any]:
    validate_config(config)
    clean_output(output)
    parts = build_parts(config)
    report_parts: dict[str, Any] = {}
    failures: list[str] = []
    for name, part in parts.items():
        mesh = part["mesh"].centered_for_print(name)
        validation = edge_count_validation(mesh)
        validation["quantity"] = part["quantity"]
        validation["note"] = part["note"]
        validation["fits_configured_bed"] = part_fits_bed(mesh, config)
        validation["estimated_mass_g_each"] = round(
            abs(float(validation["signed_volume_mm3"]))
            / 1000.0
            * float(config["printer"]["filament_density_g_cm3"]),
            2,
        )
        report_parts[name] = validation
        if validation["degenerate_triangles"] or not validation["watertight_by_edges"]:
            failures.append(name)
        export_binary_stl(mesh, output / f"{name}.stl")

    key_height = config["key_shell"]["base_z"] + config["key_shell"]["lid_z"] + 1.0 + 5.0
    lock_height = (
        config["product_lock"]["center_lid_bottom_z"]
        + config["product_lock"]["center_lid_z"]
        + config["product_lock"]["handle_z"]
    )
    envelope = {
        "key_model_mm": [config["key_shell"]["outer_x"], config["key_shell"]["outer_y"], key_height],
        "key_limit_mm": [
            config["official_envelope"]["key_x"],
            config["official_envelope"]["key_y"],
            config["official_envelope"]["key_z"],
        ],
        "lock_model_diameter_mm": 2.0 * config["product_lock"]["outer_radius"],
        "lock_model_height_mm": lock_height,
        "lock_limit_diameter_mm": config["official_envelope"]["lock_diameter"],
        "lock_limit_height_mm": config["official_envelope"]["lock_height"],
    }
    envelope["key_pass"] = all(
        model <= limit for model, limit in zip(envelope["key_model_mm"], envelope["key_limit_mm"])
    )
    envelope["lock_pass"] = (
        envelope["lock_model_diameter_mm"] <= envelope["lock_limit_diameter_mm"]
        and envelope["lock_model_height_mm"] <= envelope["lock_limit_height_mm"]
    )
    if not envelope["key_pass"] or not envelope["lock_pass"]:
        failures.append("official_envelope")
    bed_failures = [name for name, details in report_parts.items() if not details["fits_configured_bed"]]

    render_scene(
        key_scene(config, exploded=False),
        output / "preview_key_assembled.png",
        "C Problem - Product Key v0.2",
        (1500, 1050),
        -50.0,
        30.0,
    )
    render_scene(
        key_scene(config, exploded=True),
        output / "preview_key_exploded.png",
        "C Problem - Product Key Exploded v0.2",
        (1500, 1100),
        -50.0,
        30.0,
    )
    render_scene(
        lock_scene(config, exploded=False),
        output / "preview_lock_assembled.png",
        "C Problem - Integrated Smart Lock v0.2",
        (1600, 1250),
        -55.0,
        36.0,
    )
    render_scene(
        lock_scene(config, exploded=True),
        output / "preview_lock_exploded.png",
        "C Problem - Smart Lock Exploded v0.2",
        (1600, 1350),
        -55.0,
        46.0,
    )

    total_mass = sum(
        details["estimated_mass_g_each"] * details["quantity"] for details in report_parts.values()
    )
    report = {
        "model_status": MODEL_STATUS,
        "design_variant": config["design_variant"],
        "config": str(config_path),
        "config_sha256": config_hash(config_path),
        "printer_parameters_provisional": bool(config["printer"]["provisional"]),
        "official_envelope": envelope,
        "all_meshes_passed_closed_shell_validation": not failures,
        "failed_items": failures,
        "parts_not_fitting_configured_bed": bed_failures,
        "estimated_total_mass_g_before_slicer_settings": round(total_mass, 1),
        "parts": report_parts,
        "remaining_measurements": [
            "UWB Type-C 方向、接口高度与天线禁布区",
            "100×55 mm PCB 孔位与最高器件",
            "84×50 mm 屏幕正面可视区、厚度与连接器位置",
            "启动按键、LED、蜂鸣器与电源板尺寸",
        ],
    }
    (output / "validation_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    lines = [
        "# C 题一体化外壳 v0.2",
        "",
        f"状态：**{MODEL_STATUS}**。v0.1 裸露框架方向已废弃。",
        "",
        "| STL | 数量 | 尺寸 mm | CR-3040D 热床 | 说明 |",
        "| --- | ---: | --- | --- | --- |",
    ]
    for name, details in report_parts.items():
        dimensions = " × ".join(str(value) for value in details["dimensions_mm"])
        fit = "通过" if details["fits_configured_bed"] else "需继续分件"
        lines.append(f"| `{name}.stl` | {details['quantity']} | {dimensions} | {fit} | {details['note']} |")
    lines.extend(
        [
            "",
            f"钥匙名义包络：`{' × '.join(str(value) for value in envelope['key_model_mm'])} mm`。",
            f"门锁名义包络：`Ø{envelope['lock_model_diameter_mm']} × {envelope['lock_model_height_mm']} mm`。",
            "",
            "PNG 为产品装配与爆炸预览；STL 已按 CR-3040D 300×300×400 mm 热床分件。",
            "电子件孔位、接口与天线禁布区尚未实测，当前仅可作为结构试装和切片候选。",
        ]
    )
    (output / "README.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    if failures:
        raise RuntimeError(f"v0.2 validation failed: {', '.join(failures)}")
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
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
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
