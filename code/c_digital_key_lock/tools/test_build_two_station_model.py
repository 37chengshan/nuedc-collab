#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


TOOLS_DIR = Path(__file__).resolve().parent
MODULE_DIR = TOOLS_DIR.parent
SPEC = importlib.util.spec_from_file_location(
    "build_two_station_model",
    TOOLS_DIR / "build_two_station_model.py",
)
assert SPEC is not None and SPEC.loader is not None
MODEL_TOOL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODEL_TOOL)


class TwoStationModelToolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.manifest = MODEL_TOOL.load_json(MODEL_TOOL.DEFAULT_MANIFEST)

    def test_manifest_shape_and_crc(self) -> None:
        self.assertEqual(len(self.manifest["prototypes"]), 43)
        self.assertEqual(MODEL_TOOL.model_crc32(self.manifest), 0x91F6EF14)
        self.assertEqual(len(MODEL_TOOL.model_binary(self.manifest)), 384)

    def test_special_angle_correction(self) -> None:
        metadata = {
            "id": "capture-2026-07-31T17-46-35-057Z",
            "label": "1m 30度",
            "startedAt": "2026-07-31T17:46:35.057Z",
        }
        self.assertEqual(
            MODEL_TOOL.parse_capture_truth(metadata, self.manifest),
            (1000, -15),
        )

    def test_excluded_capture(self) -> None:
        metadata = {
            "id": "capture-2026-07-31T18-16-06-617Z",
            "label": "2m 30度",
            "startedAt": "2026-07-31T18:16:06.617Z",
        }
        self.assertIsNone(
            MODEL_TOOL.parse_capture_truth(metadata, self.manifest)
        )

    def test_generated_files_are_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            MODEL_TOOL.atomic_write(
                output / MODEL_TOOL.MODEL_HEADER_NAME,
                MODEL_TOOL.render_header(),
            )
            MODEL_TOOL.atomic_write(
                output / MODEL_TOOL.MODEL_SOURCE_NAME,
                MODEL_TOOL.render_source(self.manifest),
            )
            self.assertIn(
                "0x91F6EF14UL",
                (output / MODEL_TOOL.MODEL_SOURCE_NAME).read_text(),
            )
            self.assertEqual(
                (output / MODEL_TOOL.MODEL_HEADER_NAME).read_text(),
                MODEL_TOOL.render_header(),
            )

    def test_real_capture_audit_when_available(self) -> None:
        captures = Path(
            "/private/tmp/nuedc-serial-pages.ksb2Ur/"
            "apps/uwb-recorder/data/captures"
        )
        if not captures.is_dir():
            self.skipTest("本机没有现场 captures")
        audit = MODEL_TOOL.audit_captures(captures, self.manifest)
        self.assertEqual(audit["sessionCaptureCount"], 59)
        self.assertEqual(audit["usableCaptureCount"], 56)
        self.assertEqual(audit["physicalPointCount"], 43)
        excluded = {
            row["captureId"] for row in audit["excludedCaptures"]
        }
        self.assertEqual(
            excluded,
            set(self.manifest["selection"]["excludedCaptureIds"]),
        )


if __name__ == "__main__":
    unittest.main()
