from __future__ import annotations

import json
from pathlib import Path
import unittest

import numpy as np

from compact_design import compact_part_plan, load_compact_config
from generate_models import tiled_panel
from generate_compact_models import (
    build_dip_retainer,
    build_key_control_panel,
    build_key_parts,
    build_key_top_cover,
    build_lock_lower_housing,
    build_lock_top_cover,
    rear_control_holes,
)
from meshlib import edge_count_validation
from prepare_orca_job import (
    build_individual_part_plates,
    build_plates,
    build_profiles,
)


ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "parameters_v0_4.json"
REPOSITORY = ROOT.parents[3]
MODELS = REPOSITORY / "生成内容/3D打印/C题/v0.4"


def vertical_triangle_hits(mesh, x: float, y: float) -> list[float]:
    """Return Z intersections for non-vertical triangles covering one XY point."""

    point = np.array([x, y], dtype=np.float64)
    hits: list[float] = []
    for face in mesh.faces:
        triangle = mesh.vertices[face]
        xy = triangle[:, :2]
        denominator = (
            (xy[1, 1] - xy[2, 1]) * (xy[0, 0] - xy[2, 0])
            + (xy[2, 0] - xy[1, 0]) * (xy[0, 1] - xy[2, 1])
        )
        if abs(float(denominator)) <= 1e-10:
            continue
        first = (
            (xy[1, 1] - xy[2, 1]) * (point[0] - xy[2, 0])
            + (xy[2, 0] - xy[1, 0]) * (point[1] - xy[2, 1])
        ) / denominator
        second = (
            (xy[2, 1] - xy[0, 1]) * (point[0] - xy[2, 0])
            + (xy[0, 0] - xy[2, 0]) * (point[1] - xy[2, 1])
        ) / denominator
        third = 1.0 - first - second
        if min(first, second, third) < -1e-8:
            continue
        hits.append(float(first * triangle[0, 2] + second * triangle[1, 2] + third * triangle[2, 2]))
    return hits


class V04ControlGeometryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = load_compact_config(CONFIG)

    def assert_closed(self, mesh) -> None:
        validation = edge_count_validation(mesh)
        self.assertEqual(validation["degenerate_triangles"], 0)
        self.assertTrue(validation["watertight_by_edges"])

    def test_requested_petg_temperatures_and_original_three_plate_layout(self) -> None:
        machine, _, filament = build_profiles(self.config, {}, {}, {})
        start = machine["machine_start_gcode"]
        self.assertIn("M104 S220", start)
        self.assertIn("M109 S[first_layer_temperature]", start)
        self.assertEqual(filament["nozzle_temperature_initial_layer"], ["255"])
        self.assertEqual(filament["nozzle_temperature"], ["250"])
        self.assertEqual(filament["hot_plate_temp_initial_layer"], ["90"])
        self.assertEqual(filament["hot_plate_temp"], ["85"])

        report = json.loads((MODELS / "validation_report.json").read_text(encoding="utf-8"))
        plates = build_plates(report, self.config, MODELS)
        self.assertEqual(len(plates), 3)
        self.assertEqual([len(plate["items"]) for plate in plates], [1, 1, 14])

    def test_individual_part_jobs_are_centered_with_small_part_spares(self) -> None:
        report = json.loads((MODELS / "validation_report.json").read_text(encoding="utf-8"))
        plates = build_individual_part_plates(report, self.config, MODELS)
        self.assertEqual(len(plates), 13)

        quantities = {
            plate["items"][0]["part"]: len(plate["items"])
            for plate in plates
        }
        self.assertEqual(quantities["compact_key_button_cap"], 3)
        self.assertEqual(quantities["compact_key_slide_knob"], 3)
        self.assertEqual(quantities["compact_key_battery_clip"], 2)
        self.assertEqual(quantities["compact_dip_retainer"], 2)
        self.assertEqual(quantities["compact_uwb_cassette"], 3)
        self.assertEqual(quantities["compact_lock_battery_clip"], 2)

        for plate in plates:
            bounds = plate["model_bounds_mm"]
            self.assertAlmostEqual((bounds[0] + bounds[2]) / 2.0, 150.0)
            self.assertAlmostEqual((bounds[1] + bounds[3]) / 2.0, 150.0)
            self.assertTrue(plate["layout_verified_non_overlapping"])

    def test_v04_inventory_includes_real_key_controls(self) -> None:
        plan = compact_part_plan(self.config)
        names = {part.name for part in plan}
        self.assertIn("compact_key_control_panel", names)
        self.assertIn("compact_key_button_cap", names)
        self.assertIn("compact_key_slide_knob", names)
        self.assertIn("compact_dip_retainer", names)
        self.assertEqual(len(plan), 13)
        self.assertEqual(sum(part.quantity for part in plan), 16)

        key_parts = build_key_parts(self.config)
        self.assertEqual(
            set(key_parts),
            {
                "compact_key_lower_shell",
                "compact_key_top_cover",
                "compact_key_control_panel",
                "compact_key_button_cap",
                "compact_key_slide_knob",
                "compact_key_battery_clip",
            },
        )
        for mesh in key_parts.values():
            self.assert_closed(mesh)

    def test_top_cover_and_control_panel_have_real_through_openings(self) -> None:
        cover = build_key_top_cover(self.config)
        self.assertEqual(vertical_triangle_hits(cover, 0.0, 0.0), [])

        panel = build_key_control_panel(self.config)
        controls = self.config["key_controls"]
        for x_key, y_key in (
            ("button_center_x", "button_center_y"),
            ("led_center_x", "led_center_y"),
            ("slide_center_x", "slide_center_y"),
        ):
            self.assertEqual(
                vertical_triangle_hits(panel, float(controls[x_key]), float(controls[y_key])),
                [],
            )

    def test_tiled_panel_is_a_single_manifold_with_real_holes(self) -> None:
        panel = tiled_panel(
            "panel_test",
            40.0,
            30.0,
            3.0,
            [(0.0, 0.0, 10.0, 8.0), (12.0, 0.0, 4.0, 4.0)],
        )
        validation = edge_count_validation(panel)
        self.assertTrue(validation["watertight_by_edges"])
        self.assertTrue(validation["single_manifold_by_edges"])
        self.assertEqual(validation["components"], 1)
        self.assertEqual(vertical_triangle_hits(panel, 0.0, 0.0), [])

    def test_button_slide_and_led_clearances_are_explicit(self) -> None:
        controls = self.config["key_controls"]
        self.assertGreater(
            controls["button_head_diameter"],
            controls["button_opening_diameter"],
        )
        self.assertGreaterEqual(
            controls["slide_slot_x"] - controls["slide_actuator_x"],
            controls["slide_travel"],
        )
        self.assertTrue(controls["switch_dimensions_provisional"])
        snap = self.config["snap_fit"]
        button_strain = (
            1.5
            * controls["button_arm_thickness"]
            * (
                controls["button_opening_diameter"] / 2.0
                - 0.25
                + controls["button_hook_height"]
                - controls["button_square_opening"] / 2.0
            )
            / controls["button_arm_length"] ** 2
        )
        panel_strain = (
            1.5
            * controls["snap_arm_thickness"]
            * (controls["snap_hook_height"] - controls["insert_clearance"])
            / controls["skirt_z"] ** 2
        )
        self.assertLessEqual(button_strain, snap["maximum_design_strain"])
        self.assertLessEqual(panel_strain, snap["maximum_design_strain"])
        board_face = (
            controls["control_board_center_z"] - controls["control_board_z"] / 2.0
        )
        button_contact_distance = board_face - controls["button_switch_height"]
        self.assertLessEqual(
            abs(controls["button_pusher_length"] - button_contact_distance),
            controls["button_travel"],
        )
        self.assertGreater(controls["slide_actuator_z"], controls["panel_z"])

    def test_key_battery_power_and_uwb_do_not_overlap(self) -> None:
        layout = self.config["key_layout"]
        intervals = [
            (
                "battery",
                layout["battery_center_x"] - self.config["key_battery"]["x"] / 2.0,
                layout["battery_center_x"] + self.config["key_battery"]["x"] / 2.0,
            ),
            (
                "power",
                layout["power_board_center_x"] - layout["power_board_x"] / 2.0,
                layout["power_board_center_x"] + layout["power_board_x"] / 2.0,
            ),
            (
                "uwb",
                layout["uwb_center_x"] - self.config["uwb"]["board_x"] / 2.0,
                layout["uwb_center_x"] + self.config["uwb"]["board_x"] / 2.0,
            ),
        ]
        intervals.sort(key=lambda item: item[1])
        for first, second in zip(intervals, intervals[1:]):
            self.assertGreaterEqual(
                second[1] - first[2],
                layout["minimum_component_gap"],
                f"{first[0]} overlaps {second[0]}",
            )

    def test_dip_operator_opening_and_identity_marking_contract(self) -> None:
        dip = self.config["dip_switch"]
        holes = rear_control_holes(self.config)
        dip_hole = holes[1]
        self.assertEqual(dip_hole[0], dip["panel_center_x"])
        self.assertEqual(dip_hole[1], dip["panel_center_y"])
        self.assertEqual(dip_hole[2], dip["x"] + dip["operator_margin_x"])
        self.assertEqual(dip_hole[3], dip["y"] + dip["operator_margin_y"])
        self.assertEqual(dip["bit_order"], "bit3_left_to_bit0_right")
        self.assertEqual(dip["on_direction"], "toward_display")
        half_pitch = dip["retainer_screw_pitch_x"] / 2.0
        screw_holes = holes[6:8]
        self.assertEqual(
            [hole[0] for hole in screw_holes],
            [dip["panel_center_x"] - half_pitch, dip["panel_center_x"] + half_pitch],
        )
        self.assert_closed(build_dip_retainer(self.config))

    def test_front_direction_marker_is_part_of_lock_mesh(self) -> None:
        mesh = build_lock_lower_housing(self.config)
        self.assert_closed(mesh)
        self.assertGreater(float(mesh.maximum[1]), 133.0)

    def test_large_top_cover_has_radial_stiffening_ribs(self) -> None:
        lock = self.config["compact_lock"]
        self.assertGreaterEqual(lock["top_rib_count"], 6)
        self.assertGreaterEqual(lock["top_rib_height"], 3.0)
        self.assertGreaterEqual(
            lock["cover_post_center_radius"]
            - lock["cover_post_radius"]
            - lock["top_rib_outer_radius"],
            lock["minimum_structure_gap"],
        )
        mesh = build_lock_top_cover(self.config)
        self.assert_closed(mesh)


if __name__ == "__main__":
    unittest.main()
