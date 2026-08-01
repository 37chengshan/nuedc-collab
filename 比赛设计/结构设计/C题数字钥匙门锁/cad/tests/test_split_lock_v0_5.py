from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from compact_design import compact_part_plan, load_compact_config
from generate_compact_models import (
    build_parts,
    build_lock_body_half_components,
    build_lock_body_halves,
    build_lock_top_cover,
)
from generate_split_lock_models import OUTPUT_FILENAMES, generate, validate_existing
from meshlib import Mesh, edge_count_validation


ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "parameters_v0_5.json"


def by_name(meshes: list[Mesh]) -> dict[str, Mesh]:
    return {mesh.name: mesh for mesh in meshes}


def positive_aabb_overlap(first: Mesh, second: Mesh) -> bool:
    return all(
        min(float(first.maximum[index]), float(second.maximum[index]))
        - max(float(first.minimum[index]), float(second.minimum[index]))
        > 1e-6
        for index in range(3)
    )


class SplitLockV05Tests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = load_compact_config(CONFIG)

    def assert_closed_under_limit(self, mesh: Mesh) -> None:
        validation = edge_count_validation(mesh)
        self.assertEqual(validation["degenerate_triangles"], 0)
        self.assertTrue(validation["watertight_by_edges"])
        self.assertLessEqual(max(validation["dimensions_mm"]), 240.0)

    def test_v0_5_dimensions_and_split_contract(self) -> None:
        lock = self.config["compact_lock"]
        split = self.config["lock_split"]
        self.assertEqual(lock["outer_radius"] * 2.0, 238.0)
        self.assertEqual(lock["top_cover_radius"] * 2.0, 236.0)
        self.assertEqual(split["axis"], "y")
        self.assertEqual(split["front_side"], "positive_y")
        self.assertEqual(split["joint_x"], [-90.0, -30.0, 30.0, 90.0])
        self.assertEqual(split["tongue_widths"], [22.0, 18.0, 18.0, 18.0])
        self.assertEqual(split["clearance_xy"], 0.45)

    def test_v0_5_inventory_replaces_the_one_piece_lower_housing(self) -> None:
        plan_names = {part.name for part in compact_part_plan(self.config)}
        built_names = set(build_parts(self.config))
        self.assertIn("compact_lock_body_front", plan_names)
        self.assertIn("compact_lock_body_rear", plan_names)
        self.assertNotIn("compact_lock_lower_housing", plan_names)
        self.assertEqual(plan_names, built_names)

    def test_front_and_rear_keep_the_intended_features(self) -> None:
        front = by_name(build_lock_body_half_components(self.config, "front"))
        rear = by_name(build_lock_body_half_components(self.config, "rear"))

        self.assertIn("compact_pcb_stops", front)
        self.assertIn("front_cable_rail", front)
        self.assertIn("compact_front_direction_marker", front)
        self.assertIn("A1_receiver", front)
        self.assertIn("A2_receiver", front)
        self.assertNotIn("A3_receiver", front)
        self.assertIn("cover_support_0", front)
        self.assertIn("cover_support_1", front)

        self.assertIn("compact_battery_stops", rear)
        self.assertIn("rear_cable_rail", rear)
        self.assertIn("rear_rail_left", rear)
        self.assertIn("rear_rail_right", rear)
        self.assertIn("A3_receiver", rear)
        self.assertNotIn("A1_receiver", rear)
        self.assertNotIn("A2_receiver", rear)
        self.assertIn("cover_support_2", rear)
        self.assertIn("cover_support_3", rear)

    def test_half_discs_meet_at_y_zero(self) -> None:
        front = by_name(build_lock_body_half_components(self.config, "front"))[
            "compact_lock_front_floor"
        ]
        rear = by_name(build_lock_body_half_components(self.config, "rear"))[
            "compact_lock_rear_floor"
        ]
        self.assertAlmostEqual(float(front.minimum[1]), 0.0, places=6)
        self.assertAlmostEqual(float(rear.maximum[1]), 0.0, places=6)
        self.assertAlmostEqual(float(front.dimensions[0]), 238.0, places=3)
        self.assertAlmostEqual(float(rear.dimensions[0]), 238.0, places=3)

    def test_four_keyed_tongues_fit_receivers_without_overlap(self) -> None:
        front = by_name(build_lock_body_half_components(self.config, "front"))
        rear = by_name(build_lock_body_half_components(self.config, "rear"))
        split = self.config["lock_split"]
        widths = split["tongue_widths"]
        clearance = float(split["clearance_xy"])

        for index, width in enumerate(widths):
            tongue = front[f"split_tongue_{index}"]
            left = rear[f"split_receiver_{index}_left"]
            right = rear[f"split_receiver_{index}_right"]
            back = rear[f"split_receiver_{index}_back"]
            self.assertAlmostEqual(float(tongue.dimensions[0]), float(width), places=6)
            self.assertAlmostEqual(
                float(tongue.minimum[0] - left.maximum[0]),
                clearance,
                places=6,
            )
            self.assertAlmostEqual(
                float(right.minimum[0] - tongue.maximum[0]),
                clearance,
                places=6,
            )
            self.assertAlmostEqual(
                float(tongue.minimum[1] - back.maximum[1]),
                clearance,
                places=6,
            )
            self.assertFalse(positive_aabb_overlap(tongue, left))
            self.assertFalse(positive_aabb_overlap(tongue, right))
            self.assertFalse(positive_aabb_overlap(tongue, back))

        self.assertEqual(widths.count(split["keyed_tongue_width"]), 1)

    def test_three_delivery_meshes_are_closed_and_under_240_mm(self) -> None:
        halves = build_lock_body_halves(self.config)
        for mesh in (*halves.values(), build_lock_top_cover(self.config)):
            self.assert_closed_under_limit(mesh)

    def test_cover_lip_and_snap_features_remain_inside_the_body(self) -> None:
        lock = self.config["compact_lock"]
        self.assertLess(lock["top_lip_outer_radius"], lock["inner_top_radius"])
        self.assertLess(lock["cover_snap_center_radius"], lock["outer_top_radius"])
        self.assertLess(
            lock["top_rib_outer_radius"] + lock["cover_post_radius"],
            lock["cover_post_center_radius"],
        )

    def test_export_contains_exactly_three_reloadable_stl_files(self) -> None:
        with TemporaryDirectory() as directory:
            output = Path(directory)
            generated = generate(self.config, output)
            self.assertEqual(set(generated["files"]), set(OUTPUT_FILENAMES))
            self.assertEqual(
                {path.name for path in output.iterdir()},
                set(OUTPUT_FILENAMES),
            )
            validated = validate_existing(output)
            self.assertEqual(set(validated["files"]), set(OUTPUT_FILENAMES))


if __name__ == "__main__":
    unittest.main()
