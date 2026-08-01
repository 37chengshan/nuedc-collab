from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile

from meshlib import box, export_binary_stl
import prepare_key_box_v0_6 as job
import validate_orca_gcode as gcode_validator


CAD_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = CAD_ROOT.parents[3]
V04_ROOT = REPOSITORY_ROOT / "生成内容/3D打印/C题/v0.4"
V04_PROFILES = V04_ROOT / "orcaslicer/individual_parts/profiles"
V04_COVER_GCODE = V04_ROOT / "orcaslicer/individual_parts/gcode/02_钥匙上盖.gcode"
V04_COVER_STL = V04_ROOT / "STL模型文件/compact_key_top_cover.stl"
CORE_NAMESPACE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"


class PrepareKeyBoxV06Tests(unittest.TestCase):
    def make_fixture(self, directory: Path) -> tuple[Path, Path]:
        box_stl = directory / "钥匙盒体_v0.6.stl"
        cover_stl = directory / "钥匙盒盖_v0.4.stl"
        export_binary_stl(box("box_body", (110.0, 60.0, 26.0)), box_stl)
        export_binary_stl(box("box_cover", (110.0, 60.0, 6.0)), cover_stl)
        return box_stl, cover_stl

    def test_known_legacy_cover_gcode_hash_is_locked(self) -> None:
        self.assertEqual(
            job.sha256_file(V04_COVER_GCODE),
            job.EXPECTED_COVER_GCODE_SHA256,
        )
        self.assertEqual(
            job.sha256_file(V04_COVER_STL),
            job.EXPECTED_COVER_STL_SHA256,
        )

    def test_gcode_validator_resolves_v06_inherited_printer_fields(self) -> None:
        config = gcode_validator.load_json(CAD_ROOT / "parameters_v0_6.json")
        self.assertEqual(config["printer"]["origin_x"], 0.0)
        self.assertEqual(config["printer"]["origin_y"], 0.0)
        self.assertEqual(config["printer"]["bed_x"], 256.0)
        self.assertEqual(config["printer"]["bed_y"], 256.0)
        self.assertEqual(config["printer"]["bed_z"], 256.0)

    def test_dry_run_derives_256_cube_profiles_and_copies_cover_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            box_stl, cover_stl = self.make_fixture(root / "models")
            output = root / "v0.6/钥匙盒二件套"
            result = job.prepare_job(
                box_stl=box_stl,
                cover_stl=cover_stl,
                cover_gcode=V04_COVER_GCODE,
                source_profiles=V04_PROFILES,
                output=output,
                expected_cover_stl_hash=job.sha256_file(cover_stl),
            )

            manifest = json.loads(result["manifest_path"].read_text(encoding="utf-8"))
            self.assertEqual(manifest["status"], "dry-run：盒体尚未切片")
            self.assertTrue(manifest["body_reslice_required"])
            self.assertIsNone(manifest["artifacts"]["box_gcode"])
            copied_cover = output / "gcode/钥匙盒盖_v0.4.gcode"
            self.assertEqual(copied_cover.read_bytes(), V04_COVER_GCODE.read_bytes())
            self.assertEqual(
                job.sha256_file(copied_cover),
                job.EXPECTED_COVER_GCODE_SHA256,
            )
            copied_cover_stl = output / "钥匙盒盖_v0.4.stl"
            self.assertEqual(copied_cover_stl.read_bytes(), cover_stl.read_bytes())
            self.assertEqual(
                manifest["artifacts"]["cover_stl"]["path"],
                str(copied_cover_stl),
            )

            machine = json.loads(
                (output / "profiles/CR-3040D_0.4_machine.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(
                machine["printable_area"],
                ["0x0", "256x0", "256x256", "0x256"],
            )
            self.assertEqual(machine["printable_height"], "256")
            hash_report = json.loads(
                result["hash_report_path"].read_text(encoding="utf-8")
            )
            records = {record["name"]: record for record in hash_report["profiles"]["records"]}
            self.assertEqual(
                records["CR-3040D_0.4_machine.json"]["changed_keys"],
                ["printable_area", "printable_height"],
            )
            for name in job.PROFILE_NAMES[1:]:
                self.assertEqual(records[name]["changed_keys"], [])
                self.assertEqual(
                    records[name]["source_sha256"], records[name]["derived_sha256"]
                )

    def test_box_plate_contains_exactly_one_printable_object(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            box_stl, cover_stl = self.make_fixture(root / "models")
            output = root / "output"
            job.prepare_job(
                box_stl=box_stl,
                cover_stl=cover_stl,
                cover_gcode=V04_COVER_GCODE,
                source_profiles=V04_PROFILES,
                output=output,
                expected_cover_stl_hash=job.sha256_file(cover_stl),
            )
            with zipfile.ZipFile(output / "projects/钥匙盒体_v0.6.3mf") as archive:
                model = ET.fromstring(archive.read("3D/3dmodel.model"))
            self.assertEqual(len(model.findall(f".//{{{CORE_NAMESPACE}}}object")), 1)
            self.assertEqual(len(model.findall(f".//{{{CORE_NAMESPACE}}}build/{{{CORE_NAMESPACE}}}item")), 1)

    def test_output_inside_v04_is_rejected_without_touching_legacy_files(self) -> None:
        legacy_hash_before = hashlib.sha256(V04_COVER_GCODE.read_bytes()).hexdigest()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            box_stl, cover_stl = self.make_fixture(root / "models")
            with self.assertRaises(ValueError):
                job.prepare_job(
                    box_stl=box_stl,
                    cover_stl=cover_stl,
                    cover_gcode=V04_COVER_GCODE,
                    source_profiles=V04_PROFILES,
                    output=V04_ROOT / "must_not_write_here",
                    expected_cover_stl_hash=job.sha256_file(cover_stl),
                )
        self.assertEqual(
            hashlib.sha256(V04_COVER_GCODE.read_bytes()).hexdigest(),
            legacy_hash_before,
        )
