from __future__ import annotations

from pathlib import Path
import unittest

from compact_design import compact_part_plan, load_compact_config


ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "parameters_v0_3.json"


class CompactDesignTests(unittest.TestCase):
    def test_screen_and_printer_contract(self) -> None:
        config = load_compact_config(CONFIG)
        self.assertEqual(config["display"]["model"], "1.77英寸 ST7735S SPI 14PIN")
        self.assertEqual(
            [config["display"]["board_x"], config["display"]["board_y"]],
            [56.0, 34.0],
        )
        self.assertEqual(
            [config["display"]["hole_pitch_x"], config["display"]["hole_pitch_y"]],
            [52.0, 30.0],
        )
        self.assertEqual(config["display"]["hole_diameter"], 2.5)
        self.assertEqual(
            [config["printer"]["bed_x"], config["printer"]["bed_y"], config["printer"]["bed_z"]],
            [300.0, 300.0, 400.0],
        )

    def test_plan_has_two_main_shells_and_no_glue(self) -> None:
        config = load_compact_config(CONFIG)
        plan = compact_part_plan(config)
        main_shells = [part for part in plan if part.assembly == "lock_main_shell"]
        self.assertEqual(
            [part.name for part in main_shells],
            ["compact_lock_lower_housing", "compact_lock_top_cover"],
        )
        self.assertTrue(all(not part.requires_glue for part in plan))
        self.assertEqual(len(plan), 10)
        self.assertEqual(sum(part.quantity for part in plan), 13)

    def test_large_parts_fit_with_brim_and_snap_strain(self) -> None:
        config = load_compact_config(CONFIG)
        lock = config["compact_lock"]
        brim = config["print_process"]["brim_width"]
        bed = min(config["printer"]["bed_x"], config["printer"]["bed_y"])
        self.assertLessEqual(2.0 * lock["outer_radius"], 270.0)
        self.assertLessEqual(2.0 * lock["outer_radius"] + 2.0 * brim, bed - 18.0)
        snap = config["snap_fit"]
        strain = (
            1.5
            * snap["arm_thickness"]
            * snap["target_deflection"]
            / snap["arm_length"] ** 2
        )
        self.assertLessEqual(strain, snap["maximum_design_strain"])

    def test_anchors_are_non_collinear_equal_height_and_candidate_only(self) -> None:
        config = load_compact_config(CONFIG)
        self.assertEqual(config["anchor_layout_status"], "design_candidate")
        anchors = config["anchors"]
        self.assertEqual(
            {anchor["z"] for anchor in anchors},
            {config["compact_lock"]["anchor_reference_z"]},
        )
        a1, a2, a3 = anchors
        twice_area = abs(
            (a2["x"] - a1["x"]) * (a3["y"] - a1["y"])
            - (a3["x"] - a1["x"]) * (a2["y"] - a1["y"])
        )
        self.assertGreater(twice_area, 20000.0)
        self.assertEqual(config["display"]["mount_face"], "BACK")


if __name__ == "__main__":
    unittest.main()
