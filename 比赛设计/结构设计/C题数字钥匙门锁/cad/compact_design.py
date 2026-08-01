"""Configuration contract for the compact C-problem printable enclosure."""

from __future__ import annotations

from dataclasses import dataclass
import json
import math
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class PartSpec:
    name: str
    quantity: int
    assembly: str
    attachment: str
    requires_glue: bool = False


def merge_config(base: dict[str, Any], overrides: dict[str, Any]) -> dict[str, Any]:
    result = dict(base)
    for key, value in overrides.items():
        if key == "extends":
            continue
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = merge_config(result[key], value)
        else:
            result[key] = value
    return result


def load_config_data(path: Path, stack: tuple[Path, ...] = ()) -> dict[str, Any]:
    resolved = path.resolve()
    if resolved in stack:
        chain = " -> ".join(str(item) for item in (*stack, resolved))
        raise ValueError(f"configuration inheritance cycle: {chain}")
    config = json.loads(resolved.read_text(encoding="utf-8"))
    parent = config.get("extends")
    if not parent:
        return config
    parent_path = (resolved.parent / str(parent)).resolve()
    return merge_config(load_config_data(parent_path, (*stack, resolved)), config)


def load_compact_config(path: Path) -> dict[str, Any]:
    config = load_config_data(path)
    validate_compact_config(config)
    return config


def validate_compact_config(config: dict[str, Any]) -> None:
    revision = config.get("revision")
    if revision not in {"0.3", "0.4", "0.5", "0.6"} or config.get("units") != "mm":
        raise ValueError("compact configuration must be v0.3/v0.4/v0.5/v0.6 in millimetres")

    printer = config["printer"]
    process = config["print_process"]
    manufacturing = config["manufacturing"]
    official = config["official_envelope"]
    lock = config["compact_lock"]
    key = config["key_shell"]
    display = config["display"]
    snap = config["snap_fit"]

    if lock["assembled_diameter"] > 276.0:
        raise ValueError("compact lock exceeds the 276 mm design target")
    if lock["assembled_diameter"] > official["lock_diameter"]:
        raise ValueError("compact lock exceeds the official diameter")
    if lock["assembled_height"] > official["lock_height"]:
        raise ValueError("compact lock exceeds the official height")
    if key["outer_x"] > official["key_x"] or key["outer_y"] > official["key_y"]:
        raise ValueError("compact key footprint exceeds the official envelope")
    if key["assembled_z"] > official["key_z"]:
        raise ValueError("compact key height exceeds the official envelope")

    if revision != "0.6":
        bed = min(float(printer["bed_x"]), float(printer["bed_y"]))
        footprint = 2.0 * float(lock["outer_radius"])
        brim = float(process["brim_width"])
        if footprint > 270.0:
            raise ValueError("main shell exceeds the 270 mm part target")
        if footprint + 2.0 * brim > bed - 18.0:
            raise ValueError("main shell and brim do not preserve 9 mm bed margin")

    if [display["board_x"], display["board_y"]] != [56.0, 34.0]:
        raise ValueError("v0.3 requires the confirmed ST7735S board outline")
    if [display["hole_pitch_x"], display["hole_pitch_y"]] != [52.0, 30.0]:
        raise ValueError("v0.3 requires the confirmed ST7735S hole pitch")
    if display["cavity_z"] < display["assembly_z"] + 2.0:
        raise ValueError("display cavity does not preserve connector clearance")
    fascia_corner_radius = math.hypot(
        lock["rear_fascia_x"] / 2.0,
        abs(lock["rear_fascia_plane_y"]),
    )
    if fascia_corner_radius > lock["outer_radius"]:
        raise ValueError("rear fascia corners exceed the compact cylindrical boundary")

    strain = (
        1.5
        * float(snap["arm_thickness"])
        * float(snap["target_deflection"])
        / float(snap["arm_length"]) ** 2
    )
    if strain > float(snap["maximum_design_strain"]):
        raise ValueError("snap arm strain exceeds the configured PETG design limit")
    if manufacturing["clearance_xy"] <= 0.0:
        raise ValueError("clearance_xy must be positive")

    if revision in {"0.4", "0.5"}:
        controls = config["key_controls"]
        key_layout = config["key_layout"]
        opening_x = float(controls["cover_opening_x"])
        opening_y = float(controls["cover_opening_y"])
        panel_x = float(controls["panel_outer_x"])
        panel_y = float(controls["panel_outer_y"])
        chamfer_vertical_span = float(key["outer_y"]) - 2.0 * float(key["corner_chamfer"])
        if opening_x >= float(key["outer_x"]) - 2.0 * float(key["corner_chamfer"]):
            raise ValueError("key control opening leaves insufficient side structure")
        if opening_y >= chamfer_vertical_span:
            raise ValueError("key control opening enters the chamfered corner region")
        if panel_x <= opening_x or panel_y <= opening_y:
            raise ValueError("key control panel must overlap the cover opening")
        if panel_x > float(key["outer_x"]) - 12.0 or panel_y > float(key["outer_y"]) - 12.0:
            raise ValueError("key control panel is too large for the top cover")
        if float(controls["button_head_diameter"]) <= float(controls["button_opening_diameter"]):
            raise ValueError("button head must be retained above the button opening")
        if float(controls["button_square_opening"]) < float(controls["button_opening_diameter"]):
            raise ValueError("button backing opening cannot obstruct the round trim opening")
        if float(controls["slide_slot_x"]) - float(controls["slide_actuator_x"]) < float(
            controls["slide_travel"]
        ):
            raise ValueError("slide slot does not preserve the configured switch travel")
        if float(controls["slide_slot_y"]) <= float(controls["slide_actuator_y"]) + 0.6:
            raise ValueError("slide slot does not preserve actuator side clearance")
        button_hook_outer_radius = (
            float(controls["button_opening_diameter"]) / 2.0
            - 0.25
            + float(controls["button_hook_height"])
        )
        button_hook_deflection = max(
            0.0,
            button_hook_outer_radius - float(controls["button_square_opening"]) / 2.0,
        )
        if button_hook_deflection < 0.2:
            raise ValueError("key button hooks do not positively capture the square opening")
        button_snap_strain = (
            1.5
            * float(controls["button_arm_thickness"])
            * button_hook_deflection
            / float(controls["button_arm_length"]) ** 2
        )
        if button_snap_strain > float(snap["maximum_design_strain"]):
            raise ValueError("key button retention arm strain exceeds the PETG design limit")
        panel_snap_deflection = max(
            0.0,
            float(controls["snap_hook_height"]) - float(controls["insert_clearance"]),
        )
        panel_snap_strain = (
            1.5
            * float(controls["snap_arm_thickness"])
            * panel_snap_deflection
            / float(controls["skirt_z"]) ** 2
        )
        if panel_snap_strain > float(snap["maximum_design_strain"]):
            raise ValueError("key control-panel snap strain exceeds the PETG design limit")

        half_panel_x = panel_x / 2.0
        half_panel_y = panel_y / 2.0
        button_radius = float(controls["button_head_diameter"]) / 2.0
        button_x = float(controls["button_center_x"])
        button_y = float(controls["button_center_y"])
        if abs(button_x) + button_radius > half_panel_x - 1.2:
            raise ValueError("button head exceeds the removable control panel")
        if abs(button_y) + button_radius > half_panel_y - 1.2:
            raise ValueError("button head exceeds the removable control panel")
        slide_half_x = float(controls["slide_knob_x"]) / 2.0
        slide_half_y = float(controls["slide_knob_y"]) / 2.0
        slide_x = float(controls["slide_center_x"])
        slide_y = float(controls["slide_center_y"])
        if abs(slide_x) + slide_half_x > half_panel_x - 1.2:
            raise ValueError("slide knob exceeds the removable control panel")
        if abs(slide_y) + slide_half_y > half_panel_y - 1.2:
            raise ValueError("slide knob exceeds the removable control panel")
        led_x = float(controls["led_center_x"])
        led_y = float(controls["led_center_y"])
        if math.hypot(button_x - led_x, button_y - led_y) <= button_radius + 3.0:
            raise ValueError("button and status LED clearances overlap")
        if abs(slide_x - led_x) <= slide_half_x + 3.0 and abs(slide_y - led_y) <= slide_half_y + 3.0:
            raise ValueError("slide knob and status LED clearances overlap")

        board_x = float(controls["control_board_x"])
        board_y = float(controls["control_board_y"])
        board_z = float(controls["control_board_z"])
        board_center_z = float(controls["control_board_center_z"])
        board_clearance = float(controls["control_board_edge_clearance"])
        skirt_inner_x = opening_x - 2.0 * (
            float(controls["insert_clearance"]) + float(controls["skirt_wall"])
        )
        skirt_inner_y = opening_y - 2.0 * (
            float(controls["insert_clearance"]) + float(controls["skirt_wall"])
        )
        if board_x + 2.0 * board_clearance > skirt_inner_x:
            raise ValueError("key control board does not fit between the panel skirt walls")
        if board_y + 2.0 * board_clearance > skirt_inner_y:
            raise ValueError("key control board does not fit between the panel skirt walls")
        if board_center_z - board_z / 2.0 <= float(controls["panel_z"]):
            raise ValueError("key control board intersects the removable panel")
        if board_center_z + board_z / 2.0 >= float(controls["panel_z"]) + float(
            controls["skirt_z"]
        ):
            raise ValueError("key control board exceeds the removable panel carrier depth")
        switch_gap = (
            board_center_z - board_z / 2.0 - float(controls["panel_z"])
        )
        for switch_key in ("button_switch_height", "slide_switch_height"):
            switch_height = float(controls[switch_key])
            if not switch_gap - 0.5 <= switch_height <= switch_gap + 0.8:
                raise ValueError(f"{switch_key} does not reach the control-panel opening")
        button_contact_distance = (
            board_center_z - board_z / 2.0 - float(controls["button_switch_height"])
        )
        pusher_length = float(controls["button_pusher_length"])
        if not button_contact_distance - 0.2 <= pusher_length <= (
            button_contact_distance + float(controls["button_travel"]) + 0.2
        ):
            raise ValueError("key button pusher cannot reach the tactile switch within its travel")
        if float(controls["slide_actuator_z"]) <= float(controls["panel_z"]):
            raise ValueError("slide-switch actuator does not protrude through the panel")

        component_intervals = sorted(
            [
                (
                    "battery",
                    float(key_layout["battery_center_x"])
                    - float(config["key_battery"]["x"]) / 2.0,
                    float(key_layout["battery_center_x"])
                    + float(config["key_battery"]["x"]) / 2.0,
                ),
                (
                    "power_board",
                    float(key_layout["power_board_center_x"])
                    - float(key_layout["power_board_x"]) / 2.0,
                    float(key_layout["power_board_center_x"])
                    + float(key_layout["power_board_x"]) / 2.0,
                ),
                (
                    "uwb",
                    float(key_layout["uwb_center_x"]) - float(config["uwb"]["board_x"]) / 2.0,
                    float(key_layout["uwb_center_x"]) + float(config["uwb"]["board_x"]) / 2.0,
                ),
            ],
            key=lambda interval: interval[1],
        )
        minimum_gap = float(key_layout["minimum_component_gap"])
        for first, second in zip(component_intervals, component_intervals[1:]):
            if second[1] - first[2] < minimum_gap:
                raise ValueError(
                    f"key components overlap or violate gap: {first[0]} -> {second[0]}"
                )
        inner_half_x = float(key["outer_x"]) / 2.0 - float(manufacturing["wall"])
        if component_intervals[0][1] < -inner_half_x or component_intervals[-1][2] > inner_half_x:
            raise ValueError("key electronics exceed the internal X envelope")
        inner_half_y = float(key["outer_y"]) / 2.0 - float(manufacturing["wall"])
        if float(config["key_battery"]["y"]) / 2.0 > inner_half_y:
            raise ValueError("key battery exceeds the internal Y envelope")
        if float(key_layout["power_board_y"]) / 2.0 > inner_half_y:
            raise ValueError("key power board exceeds the internal Y envelope")
        if float(config["uwb"]["board_y"]) / 2.0 > inner_half_y:
            raise ValueError("key UWB board exceeds the internal Y envelope")
        if not (
            float(key_layout["battery_center_x"])
            < float(key_layout["power_board_center_x"])
            < float(key_layout["uwb_center_x"])
        ):
            raise ValueError("key electronics must run battery -> power -> UWB toward Type-C")
        electronics_top = float(manufacturing["floor"]) + max(
            float(config["key_battery"]["z"]),
            float(key_layout["power_board_z"]),
            float(config["uwb"]["assembly_z"]),
        )
        carrier_depth = max(
            float(controls["panel_z"]) + float(controls["skirt_z"]) + 0.4,
            float(controls["button_arm_length"]),
        )
        carrier_bottom = float(key["base_z"]) + float(key["lid_z"]) - carrier_depth
        if carrier_bottom - electronics_top < 2.0:
            raise ValueError("key control carrier lacks vertical clearance above electronics")

        dip = config["dip_switch"]
        dip_opening_x = float(dip["x"]) + float(dip["operator_margin_x"])
        dip_opening_y = float(dip["y"]) + float(dip["operator_margin_y"])
        dip_center_x = float(dip["panel_center_x"])
        dip_center_y = float(dip["panel_center_y"])
        if abs(dip_center_x) + dip_opening_x / 2.0 > float(lock["rear_fascia_x"]) / 2.0 - 2.0:
            raise ValueError("DIP operator opening leaves insufficient fascia edge")
        if abs(dip_center_y) + dip_opening_y / 2.0 > float(lock["rear_fascia_y"]) / 2.0 - 2.0:
            raise ValueError("DIP operator opening leaves insufficient fascia edge")
        if dip.get("bit_order") != "bit3_left_to_bit0_right":
            raise ValueError("v0.4 requires an explicit bit3-to-bit0 DIP order")
        if dip.get("on_direction") != "toward_display":
            raise ValueError("v0.4 requires an explicit DIP ON direction")
        screw_radius = (
            float(dip["retainer_screw_diameter"])
            + float(dip["retainer_screw_clearance"])
        ) / 2.0
        half_screw_pitch = float(dip["retainer_screw_pitch_x"]) / 2.0
        if (
            abs(dip_center_x) + half_screw_pitch + screw_radius
            > float(lock["rear_fascia_x"]) / 2.0 - 1.2
        ):
            raise ValueError("DIP retainer screw holes exceed the fascia width")
        cage_outer_x = float(dip["x"]) + 2.0 * (
            float(dip["retainer_cage_clearance"])
            + float(dip["retainer_cage_wall"])
        )
        cage_outer_y = float(dip["y"]) + 2.0 * (
            float(dip["retainer_cage_clearance"])
            + float(dip["retainer_cage_wall"])
        )
        if cage_outer_x >= float(dip["retainer_screw_pitch_x"]) - 2.0 * screw_radius:
            raise ValueError("DIP retainer cage collides with its screw lugs")
        if cage_outer_y > dip_opening_y + 2.0 * float(dip["retainer_cage_wall"]):
            raise ValueError("DIP retainer cage is too large for the operator opening")
        if int(lock["top_rib_count"]) < 6:
            raise ValueError("v0.4 lock top cover requires at least six radial ribs")
        if float(lock["top_rib_outer_radius"]) >= float(lock["top_lip_inner_radius"]) - 4.0:
            raise ValueError("top-cover ribs collide with the locating lip")
        if float(lock["top_rib_inner_radius"]) >= float(lock["top_rib_outer_radius"]):
            raise ValueError("top-cover rib radius range is invalid")
        structure_gap = (
            float(lock["cover_post_center_radius"])
            - float(lock["cover_post_radius"])
            - float(lock["top_rib_outer_radius"])
        )
        if structure_gap < float(lock["minimum_structure_gap"]):
            raise ValueError("top-cover ribs collide with the lower-housing support posts")

    if revision == "0.5":
        split = config["lock_split"]
        if split.get("axis") != "y" or split.get("front_side") != "positive_y":
            raise ValueError("v0.5 lock body must split at Y=0 with positive Y as front")
        positions = [float(value) for value in split["joint_x"]]
        widths = [float(value) for value in split["tongue_widths"]]
        if len(positions) != 4 or len(widths) != 4:
            raise ValueError("v0.5 requires exactly four tongue/U-channel joints")
        if positions != sorted(positions) or len(set(positions)) != 4:
            raise ValueError("v0.5 split-joint positions must be unique and ordered")
        if widths.count(float(split["keyed_tongue_width"])) != 1:
            raise ValueError("v0.5 requires exactly one keyed tongue width")
        if min(widths) <= 0.0 or min(
            float(split[key])
            for key in (
                "tongue_depth",
                "tongue_height",
                "clearance_xy",
                "clearance_z",
                "receiver_wall",
            )
        ) <= 0.0:
            raise ValueError("v0.5 split-joint dimensions must be positive")
        if 2.0 * float(lock["outer_radius"]) > 238.0:
            raise ValueError("v0.5 lower body exceeds the 238 mm diameter target")
        if 2.0 * float(lock["top_cover_radius"]) > 240.0:
            raise ValueError("v0.5 top cover exceeds the 240 mm part target")
        half_width = float(lock["inner_bottom_radius"])
        receiver_wall = float(split["receiver_wall"])
        for position, width in zip(positions, widths):
            if abs(position) + width / 2.0 + receiver_wall > half_width:
                raise ValueError("v0.5 split joint exceeds the internal seam width")
        seam_clearance = min(
            float(lock["pcb_center_y"]) - float(config["vehicle_pcb"]["y"]) / 2.0,
            abs(float(lock["battery_center_y"]))
            - float(config["lock_battery"]["y"]) / 2.0,
        )
        receiver_depth = (
            float(split["tongue_depth"])
            + float(split["clearance_xy"])
            + float(split["receiver_wall"])
        )
        if receiver_depth >= seam_clearance:
            raise ValueError("v0.5 split joints collide with PCB or battery keep-outs")

    anchors = config["anchors"]
    if len(anchors) != 3 or len({anchor["id"] for anchor in anchors}) != 3:
        raise ValueError("exactly three uniquely named anchors are required")
    if {anchor["z"] for anchor in anchors} != {lock["anchor_reference_z"]}:
        raise ValueError("all design anchors must share one reference height")
    first, second, third = anchors
    twice_area = abs(
        (second["x"] - first["x"]) * (third["y"] - first["y"])
        - (third["x"] - first["x"]) * (second["y"] - first["y"])
    )
    if twice_area <= 20000.0:
        raise ValueError("anchor triangle is too small or nearly collinear")


def compact_part_plan(config: dict[str, Any]) -> list[PartSpec]:
    validate_compact_config(config)
    key_parts = [
        PartSpec("compact_key_lower_shell", 1, "key_main_shell", "skirt+2 snap tabs"),
        PartSpec("compact_key_top_cover", 1, "key_main_shell", "skirt+2 snap tabs"),
    ]
    if config["revision"] in {"0.4", "0.5"}:
        key_parts.extend(
            [
                PartSpec(
                    "compact_key_control_panel",
                    1,
                    "key_controls",
                    "replaceable snap insert",
                ),
                PartSpec("compact_key_button_cap", 1, "key_controls", "snap-captured"),
                PartSpec(
                    "compact_key_slide_knob",
                    1,
                    "key_controls",
                    "press-fit on switch actuator",
                ),
            ]
        )
    else:
        key_parts.append(
            PartSpec("compact_key_button_cap", 1, "key_controls", "unvalidated loose part")
        )
    lock_main_parts = (
        [
            PartSpec(
                "compact_lock_body_front",
                1,
                "lock_main_shell",
                "4 tongue/U-channel joints + adhesive",
                True,
            ),
            PartSpec(
                "compact_lock_body_rear",
                1,
                "lock_main_shell",
                "4 tongue/U-channel joints + adhesive",
                True,
            ),
        ]
        if config["revision"] == "0.5"
        else [
            PartSpec(
                "compact_lock_lower_housing",
                1,
                "lock_main_shell",
                "lip+4 snap tabs",
            )
        ]
    )
    return key_parts + [
        PartSpec("compact_key_battery_clip", 1, "key_battery", "snap"),
        *lock_main_parts,
        PartSpec("compact_lock_top_cover", 1, "lock_main_shell", "lip+4 snap tabs"),
        PartSpec("compact_uwb_cassette", 3, "lock_uwb", "slide+snap"),
        PartSpec("compact_rear_fascia", 1, "lock_display", "M2.5 screw"),
        *(
            [
                PartSpec(
                    "compact_dip_retainer",
                    1,
                    "lock_id_control",
                    "2×M2.5 screw cage",
                )
            ]
            if config["revision"] in {"0.4", "0.5"}
            else []
        ),
        PartSpec("compact_display_retainer", 1, "lock_display", "M2.5 screw"),
        PartSpec("compact_lock_battery_clip", 2, "lock_battery", "snap"),
    ]


def require_final_slice_ready(config: dict[str, Any]) -> None:
    validate_compact_config(config)
    if not config["manufacturing"]["clearance_verified"]:
        raise ValueError("clearance trial must pass before final lock G-code generation")
