from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
import zipfile
import xml.etree.ElementTree as ET

from prepare_orca_job import build_plates, build_profiles, write_plate_3mf
from validate_orca_gcode import validate_file


ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / "parameters_v0_3.json"
REPOSITORY = ROOT.parents[3]
MODELS = REPOSITORY / "生成内容/3D打印/C题/v0.3"
REPORT = MODELS / "validation_report.json"


class OrcaProfileTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = json.loads(CONFIG.read_text(encoding="utf-8"))

    def test_safe_start_heats_bed_before_final_nozzle_and_limits_purge(self) -> None:
        machine, process, filament = build_profiles(self.config, {}, {}, {})
        start = machine["machine_start_gcode"].splitlines()

        def line_index(fragment: str) -> int:
            return next(index for index, line in enumerate(start) if fragment in line)

        self.assertLess(line_index("M140 S[first_layer_bed_temperature]"), line_index("M190"))
        self.assertLess(line_index("M104 S170"), line_index("M190"))
        self.assertLess(line_index("G1 Z10"), line_index("M190"))
        self.assertLess(line_index("M190"), line_index("M109 S[first_layer_temperature]"))
        self.assertNotIn("E19", machine["machine_start_gcode"])
        self.assertNotIn("E12.5", machine["machine_start_gcode"])
        self.assertEqual(machine["machine_start_gcode"].count("E10"), 2)

        self.assertEqual(process["initial_layer_speed"], "15")
        self.assertEqual(process["initial_layer_infill_speed"], "15")
        self.assertEqual(process["initial_layer_travel_speed"], "60%")
        self.assertEqual(process["initial_layer_line_width"], "0.48")
        self.assertEqual(process["brim_type"], "outer_only")
        self.assertEqual(process["brim_width"], "7")
        self.assertEqual(process["brim_object_gap"], "0")
        self.assertEqual(process["bridge_speed"], "30")
        self.assertEqual(process["small_perimeter_speed"], "40")
        for key in (
            "outer_wall_speed",
            "inner_wall_speed",
            "small_perimeter_speed",
            "sparse_infill_speed",
            "internal_solid_infill_speed",
            "top_surface_speed",
            "gap_infill_speed",
        ):
            self.assertGreaterEqual(
                float(process[key]),
                float(self.config["printer"]["material_recommended_speed_min"]),
            )
            self.assertLessEqual(
                float(process[key]),
                float(self.config["printer"]["material_recommended_speed_max"]),
            )
        self.assertEqual(process["reduce_crossing_wall"], "1")
        self.assertEqual(process["slowdown_for_curled_perimeters"], "1")
        self.assertEqual(filament["close_fan_the_first_x_layers"], ["5"])
        self.assertEqual(
            [
                float(self.config["printer"]["material_bed_temperature_min"]),
                float(self.config["printer"]["material_bed_temperature_max"]),
            ],
            [80.0, 90.0],
        )

    def test_validator_rejects_hot_nozzle_waiting_near_bed_and_overpurge(self) -> None:
        unsafe = """\
G90
M83
M104 S240
M140 S80
G28
G1 Z0.3
M190 S80
M109 S240
G1 X100 E19 F1000
G1 X0 E19 F1000
;LAYER_CHANGE
G1 Z0.24
M104 S235
M104 S0
M140 S0
"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "unsafe.gcode"
            path.write_text(unsafe, encoding="utf-8")
            result = validate_file(path, self.config)

        self.assertFalse(result["passed"])
        joined = "\n".join(result["errors"])
        self.assertIn("standby nozzle target", joined)
        self.assertIn("full nozzle temperature", joined)
        self.assertIn("nozzle Z at bed wait", joined)
        self.assertIn("startup extrusion", joined)

    def test_deterministic_layout_is_brim_aware_and_non_overlapping(self) -> None:
        report = json.loads(REPORT.read_text(encoding="utf-8"))
        first = build_plates(report, self.config, MODELS)
        second = build_plates(report, self.config, MODELS)

        self.assertEqual(first, second)
        self.assertEqual(len(first), 3)
        self.assertEqual(sum(len(plate["items"]) for plate in first), 13)
        self.assertTrue(
            all(plate["layout_verified_non_overlapping"] for plate in first)
        )
        for plate in first:
            self.assertGreaterEqual(plate["brim_bounds_mm"][0], 5.0)
            self.assertGreaterEqual(plate["brim_bounds_mm"][1], 5.0)
            self.assertLessEqual(plate["brim_bounds_mm"][2], 295.0)
            self.assertLessEqual(plate["brim_bounds_mm"][3], 295.0)

    def test_plate_3mf_preserves_unique_instance_names(self) -> None:
        report = json.loads(REPORT.read_text(encoding="utf-8"))
        plates = build_plates(report, self.config, MODELS)
        plate = plates[2]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "plate_03.3mf"
            record = write_plate_3mf(plate, path)
            with zipfile.ZipFile(path) as archive:
                root = ET.fromstring(archive.read("3D/3dmodel.model"))

        namespace = {"m": "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"}
        names = [
            element.attrib["name"]
            for element in root.findall(".//m:object", namespace)
        ]
        expected = [item["id"] for item in plate["items"]]
        self.assertEqual(names, expected)
        self.assertEqual(len(record["objects"]), len(expected))
        self.assertEqual(len(names), len(set(names)))

    def test_validator_rejects_first_layer_object_overlap(self) -> None:
        overlapping = """\
G90
M83
M140 S80
M104 S170
G28
G1 Z10 F1200
M190 S80
M109 S240
G1 X5 Y2 Z0.28 F1200
G1 X105 E10 F900
G1 Y2.4 F3000
G1 X5 E10 F900
;LAYER_CHANGE
;Z:0.24
; printing object part_a id:1 copy 0
G1 X10 Y10 F1000
G1 X30 Y10 E1 F900
G1 X30 Y30 E1
; stop printing object part_a id:1 copy 0
; printing object part_b id:2 copy 0
G1 X20 Y20 F1000
G1 X40 Y20 E1 F900
G1 X40 Y40 E1
; stop printing object part_b id:2 copy 0
;LAYER_CHANGE
;Z:0.44
M104 S235
M104 S0
M140 S0
"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "overlap.gcode"
            path.write_text(overlapping, encoding="utf-8")
            result = validate_file(path, self.config, ["part_a", "part_b"])

        self.assertFalse(result["passed"])
        self.assertEqual(result["first_layer"]["object_count"], 2)
        self.assertFalse(result["first_layer"]["non_overlapping"])
        self.assertEqual(len(result["first_layer"]["overlaps"]), 1)
        self.assertIn(
            "first-layer object extrusion bounds overlap",
            "\n".join(result["errors"]),
        )

    def test_validator_rejects_brim_overlap_outside_object_markers(self) -> None:
        brim_overlap = """\
G90
M83
M140 S80
M104 S170
G28
G1 Z10 F1200
M190 S80
M109 S240
G1 X5 Y2 Z0.28 F1200
G1 X105 E10 F900
G1 Y2.4 F3000
G1 X5 E10 F900
;LAYER_CHANGE
;Z:0.24
;TYPE:Brim
G1 X9 Y9 F1000
G1 X26 Y9 E1 F900
G1 X26 Y21 E1
G1 X24 Y9 F1000
G1 X41 Y9 E1 F900
G1 X41 Y21 E1
; printing object part_a id:1 copy 0
G1 X10 Y10 F1000
G1 X20 Y10 E1 F900
G1 X20 Y20 E1
; stop printing object part_a id:1 copy 0
; printing object part_b id:2 copy 0
G1 X30 Y10 F1000
G1 X40 Y10 E1 F900
G1 X40 Y20 E1
; stop printing object part_b id:2 copy 0
;LAYER_CHANGE
;Z:0.44
M104 S235
M104 S0
M140 S0
"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "brim_overlap.gcode"
            path.write_text(brim_overlap, encoding="utf-8")
            result = validate_file(
                path,
                self.config,
                ["part_a", "part_b"],
                {
                    "part_a": [10.0, 10.0, 20.0, 20.0],
                    "part_b": [30.0, 10.0, 40.0, 20.0],
                },
            )

        self.assertFalse(result["passed"])
        self.assertFalse(
            result["first_layer"]["footprints_non_overlapping_including_brim"]
        )
        self.assertIn(
            "first-layer footprints including brim overlap",
            "\n".join(result["errors"]),
        )


if __name__ == "__main__":
    unittest.main()
