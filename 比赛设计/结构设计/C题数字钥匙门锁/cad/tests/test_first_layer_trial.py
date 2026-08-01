from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

from make_first_layer_trial import build_first_layer_trial


class FirstLayerTrialTests(unittest.TestCase):
    def test_keeps_start_and_first_layer_then_adds_safe_shutdown(self) -> None:
        source_text = """\
G90
M140 S80
M104 S170
G28
G1 Z10
M190 S80
M109 S240
G1 X10 E10
;LAYER_CHANGE
;Z:0.24
G1 X20 Y20 Z0.24 E1
;LAYER_CHANGE
;Z:0.44
G1 X30 Y30 Z0.44 E1
"""
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "full.gcode"
            source.write_text(source_text, encoding="utf-8")
            trial = build_first_layer_trial(source)

        self.assertIn("G1 X20 Y20 Z0.24 E1", trial)
        self.assertNotIn("G1 X30 Y30 Z0.44 E1", trial)
        self.assertIn("; FIRST_LAYER_TRIAL_END", trial)
        self.assertIn("M104 S0", trial)
        self.assertIn("M140 S0", trial)
        self.assertIn("G1 Z5 F600", trial)


if __name__ == "__main__":
    unittest.main()
