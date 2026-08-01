from __future__ import annotations

from pathlib import Path
import unittest

from compact_design import compact_part_plan, load_compact_config
from generate_compact_models import (
    build_key_parts,
    build_lock_lower_housing,
    build_lock_top_cover,
    build_parts,
)
from meshlib import edge_count_validation


ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "parameters_v0_3.json"


class CompactGeometryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = load_compact_config(CONFIG)

    def assert_closed(self, mesh) -> None:
        validation = edge_count_validation(mesh)
        self.assertEqual(validation["degenerate_triangles"], 0)
        self.assertTrue(validation["watertight_by_edges"])

    def test_key_is_four_closed_parts_inside_official_envelope(self) -> None:
        parts = build_key_parts(self.config)
        self.assertEqual(
            set(parts),
            {
                "compact_key_lower_shell",
                "compact_key_top_cover",
                "compact_key_button_cap",
                "compact_key_battery_clip",
            },
        )
        for mesh in parts.values():
            self.assert_closed(mesh)
        key = self.config["key_shell"]
        self.assertLessEqual(key["outer_x"], 120.0)
        self.assertLessEqual(key["outer_y"], 80.0)
        self.assertLessEqual(key["assembled_z"], 40.0)

    def test_two_main_shells_fit_one_bed_each(self) -> None:
        lower = build_lock_lower_housing(self.config)
        top = build_lock_top_cover(self.config)
        for mesh in (lower, top):
            validation = edge_count_validation(mesh)
            self.assertEqual(validation["degenerate_triangles"], 0)
            self.assertTrue(validation["watertight_by_edges"])
            self.assertLessEqual(max(validation["dimensions_mm"][:2]), 270.0)
        self.assertLessEqual(self.config["compact_lock"]["assembled_diameter"], 276.0)
        self.assertLessEqual(self.config["compact_lock"]["assembled_height"], 110.0)

    def test_generated_part_inventory_matches_design_plan(self) -> None:
        parts = build_parts(self.config)
        plan = {part.name: part.quantity for part in compact_part_plan(self.config)}
        actual = {name: details["quantity"] for name, details in parts.items()}
        self.assertEqual(actual, plan)
        self.assertEqual(len(parts), 10)
        self.assertEqual(sum(actual.values()), 13)
        for details in parts.values():
            self.assert_closed(details["mesh"])


if __name__ == "__main__":
    unittest.main()
