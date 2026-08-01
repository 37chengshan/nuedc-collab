from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np

import generate_key_box_v0_6 as key_box
from meshlib import edge_count_validation, load_binary_stl


CAD_ROOT = Path(__file__).resolve().parents[1]
CONFIG = CAD_ROOT / "parameters_v0_6.json"
V04_COVER = (
    CAD_ROOT.parents[3]
    / "生成内容/3D打印/C题/v0.4/STL模型文件/compact_key_top_cover.stl"
)


class KeyBoxV06Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.key = key_box.load_parameters(CONFIG)

    def test_parameter_contract_locks_size_margin_and_uwb_clearance_chain(self) -> None:
        assertions = key_box.assert_parameter_contract(self.key)
        measured = assertions["measured_and_design_constraints_mm"]
        self.assertEqual(measured["body.outer_x"], 105.0)
        self.assertEqual(measured["body.outer_y"], 58.0)
        self.assertEqual(measured["body.height"], 35.0)
        self.assertEqual(measured["body.assembled_height_with_cover"], 38.0)
        self.assertEqual(measured["body.margin_below_height_limit"], 2.0)
        self.assertEqual(measured["headers.pin_length"], 12.0)
        self.assertEqual(measured["antenna.slot_width_y"], 28.0)
        self.assertEqual(measured["antenna.slot_bottom_z"], 21.0)
        self.assertEqual(measured["antenna.slot_top_z"], 27.0)

        clearances = assertions["clearance_chain_mm"]
        self.assertEqual(clearances["assembled_size"], [105.0, 58.0, 38.0])
        self.assertEqual(clearances["official_limit"], [120.0, 80.0, 40.0])
        self.assertEqual(clearances["margin_below_limit"], [15.0, 22.0, 2.0])
        self.assertEqual(clearances["support_height"], 19.8)
        self.assertGreater(clearances["support_height"], 12.0)
        self.assertEqual(clearances["support_height_over_pin"], 7.8)
        self.assertEqual(clearances["dupont_lowest_z"], 8.0)
        self.assertEqual(clearances["dupont_floor_clearance"], 4.8)
        self.assertEqual(clearances["pin_lowest_z"], 11.0)
        self.assertEqual(clearances["pin_floor_clearance"], 7.8)
        self.assertEqual(clearances["pcb_top_clearance"], 1.0)
        self.assertEqual(clearances["row_channel_side_clearance"], 0.5)

        self.assertEqual(
            assertions["legacy_cover_measurement"]["skirt_outer_mm"], [98.0, 50.0]
        )
        self.assertEqual(
            assertions["legacy_cover_measurement"]["snap_width_mm"], 6.0
        )
        self.assertFalse(
            assertions["legacy_cover_measurement"]["local_retention_pad"]
        )
        self.assertFalse(
            assertions["power_component_mounting"]["battery_dimensions_known"]
        )
        self.assertFalse(
            assertions["power_component_mounting"]["regulator_dimensions_known"]
        )
        self.assertFalse(assertions["power_component_mounting"]["printed_supports"])
        self.assertEqual(
            assertions["power_component_mounting"]["method"], "user_hot_melt_glue"
        )
        self.assertIn("antenna.slot_width_y", assertions["provisional_fields"])
        self.assertEqual(
            assertions["provisional_values_mm"]["wire_management.row_channel_width"],
            6.0,
        )
        self.assertEqual(
            assertions["provisional_values_mm"]["pcb.component_envelope_from_bottom"],
            11.0,
        )
        self.assertEqual(
            assertions["provisional_top_component"]["highest_z_mm"], 34.0
        )
        self.assertFalse(
            assertions["provisional_top_component"]["hardware_verified"]
        )
        self.assertIsNone(assertions["provisional_header_count"]["pins_per_row"])

    def test_body_is_closed_and_has_required_envelope(self) -> None:
        mesh = key_box.build_key_box(self.key)
        validation = edge_count_validation(mesh)
        self.assertEqual(validation["degenerate_triangles"], 0)
        self.assertEqual(validation["open_boundary_edges"], 0)
        self.assertEqual(validation["dimensions_mm"], [105.0, 58.0, 35.0])
        self.assertLessEqual(max(105.0, 58.0, 38.0), 120.0)

    def test_only_uwb_support_is_printed_inside_the_shell(self) -> None:
        components = key_box.build_key_box_components(self.key)
        internal_names = {
            name for name in components if not name.startswith("key_box_")
        }
        self.assertEqual(internal_names, {"uwb_pcb_support_pedestal_40x8"})
        self.assertFalse(
            any(
                token in name
                for name in components
                for token in ("battery", "regulator", "locator", "internal_snap")
            )
        )

        support = components["uwb_pcb_support_pedestal_40x8"]
        np.testing.assert_allclose(support.dimensions, [40.0, 8.0, 19.8])
        np.testing.assert_allclose(support.minimum, [-1.5, -4.0, 3.2])
        np.testing.assert_allclose(support.maximum, [38.5, 4.0, 23.0])
        self.assertGreater(float(support.dimensions[2]), 12.0)

        power = self.key["power_components"]
        self.assertFalse(power["battery_dimensions_known"])
        self.assertFalse(power["regulator_dimensions_known"])
        self.assertFalse(power["printed_supports_enabled"])
        self.assertTrue(power["reserved_cavity_only"])
        self.assertEqual(power["mount_method"], "user_hot_melt_glue")

    def test_header_channels_antenna_slot_and_cover_opening_are_clear(self) -> None:
        components = key_box.build_key_box_components(self.key)
        support = components["uwb_pcb_support_pedestal_40x8"]

        def positive_overlap_volume(
            minimum: tuple[float, float, float],
            maximum: tuple[float, float, float],
            mesh: object,
        ) -> float:
            overlaps = [
                min(float(maximum[index]), float(mesh.maximum[index]))
                - max(float(minimum[index]), float(mesh.minimum[index]))
                for index in range(3)
            ]
            if any(value <= 1e-9 for value in overlaps):
                return 0.0
            return overlaps[0] * overlaps[1] * overlaps[2]

        row_spacing = float(self.key["headers"]["row_center_spacing"])
        row_width = float(self.key["wire_management"]["row_channel_width"])
        for row_center_y in (-row_spacing / 2.0, row_spacing / 2.0):
            row_minimum = (
                float(self.key["headers"]["active_x_min"]),
                row_center_y - row_width / 2.0,
                float(self.key["wire_management"]["dupont_lowest_z"]),
            )
            row_maximum = (
                float(self.key["headers"]["active_x_max"]),
                row_center_y + row_width / 2.0,
                float(self.key["pcb"]["bottom_z"]),
            )
            self.assertEqual(
                positive_overlap_volume(row_minimum, row_maximum, support),
                0.0,
            )

        below = components["key_box_antenna_exit_below"]
        above = components["key_box_antenna_exit_above"]
        self.assertAlmostEqual(float(below.dimensions[1]), 28.0)
        self.assertAlmostEqual(float(below.maximum[2]), 21.0)
        self.assertAlmostEqual(float(above.minimum[2]), 27.0)

        left_fit = components["key_box_cover_fit_wall_6"]
        right_fit = components["key_box_antenna_exit_fit"]
        bottom_fit = components["key_box_cover_fit_wall_0"]
        top_fit = components["key_box_cover_fit_wall_4"]
        self.assertAlmostEqual(
            float(right_fit.minimum[0] - left_fit.maximum[0]),
            101.4,
        )
        self.assertAlmostEqual(
            float(top_fit.minimum[1] - bottom_fit.maximum[1]),
            54.4,
        )

    def test_generate_has_exact_inventory_reload_dimensions_and_locked_cover(self) -> None:
        source_hash_before = hashlib.sha256(V04_COVER.read_bytes()).hexdigest()
        self.assertEqual(source_hash_before, key_box.EXPECTED_COVER_SHA256)
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "钥匙盒二件套"
            output.mkdir(parents=True)
            (output / "stale_part.stl").write_bytes(b"stale")
            result = key_box.generate(self.key, output)

            self.assertEqual(
                {path.name for path in output.glob("*.stl")},
                key_box.EXPECTED_STL_FILENAMES,
            )
            body_path = output / key_box.BODY_FILENAME
            cover_path = output / key_box.COVER_FILENAME
            body = load_binary_stl(body_path)
            validation = edge_count_validation(body)
            self.assertEqual(validation["degenerate_triangles"], 0)
            self.assertEqual(validation["open_boundary_edges"], 0)
            self.assertEqual(validation["dimensions_mm"], [105.0, 58.0, 35.0])
            self.assertEqual(
                hashlib.sha256(cover_path.read_bytes()).hexdigest(),
                key_box.EXPECTED_COVER_SHA256,
            )
            self.assertEqual(cover_path.read_bytes(), V04_COVER.read_bytes())

            report = json.loads(result["report_path"].read_text(encoding="utf-8"))
            self.assertTrue(report["requirements"]["exactly_two_stl_files"])
            self.assertTrue(report["body"]["reload_dimensions_match"])
            self.assertEqual(report["body"]["dimensions_mm"], [105.0, 58.0, 35.0])
            self.assertEqual(report["body"]["top_opening_mm"], [101.4, 54.4])
            self.assertEqual(
                report["body"]["assembled_height_with_v0_4_cover_mm"], 38.0
            )
            self.assertEqual(
                report["body"]["margin_below_official_limit_mm"],
                [15.0, 22.0, 2.0],
            )
            self.assertEqual(
                report["body"]["pcb_support"]["size_mm"], [40.0, 8.0, 19.8]
            )
            self.assertEqual(
                report["body"]["internal_layout"]["printed_features"],
                ["uwb_pcb_support_pedestal_40x8"],
            )
            self.assertFalse(
                report["body"]["internal_layout"][
                    "battery_and_regulator_printed_supports"
                ]
            )
            self.assertEqual(
                report["cover"]["measured_fit"]["ordinary_clearance_per_side_mm"],
                [1.7, 2.2],
            )
            self.assertEqual(
                report["cover"]["measured_fit"]["snap_insertion_clearance_y_mm"],
                0.2,
            )
            self.assertTrue(report["requirements"]["official_key_height_passed"])
            self.assertTrue(report["requirements"]["official_key_size_passed"])
            self.assertTrue(report["requirements"]["at_least_2_mm_size_margin"])
            self.assertTrue(report["requirements"]["only_uwb_internal_support"])
            self.assertTrue(report["requirements"]["battery_regulator_supports_absent"])
            self.assertTrue(report["cover"]["hash_locked"])
            self.assertEqual(
                report["cover"]["sha256"], key_box.EXPECTED_COVER_SHA256
            )
            self.assertEqual(
                report["parameter_assertions"]["provisional_top_component"][
                    "highest_z_mm"
                ],
                34.0,
            )

            validated = key_box.validate_existing(self.key, output)
            self.assertTrue(validated["ok"])
        self.assertEqual(
            hashlib.sha256(V04_COVER.read_bytes()).hexdigest(), source_hash_before
        )


if __name__ == "__main__":
    unittest.main()
