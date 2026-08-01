#!/usr/bin/env python3
"""生成 v0.6 两件式钥匙盒的确定性 OrcaSlicer 输入和交付物。

盒体必须由 OrcaSlicer 单件重新切片；已验证的 v0.4 盒盖 G-code 只做
字节复制，绝不重新切片。默认不调用 OrcaSlicer，因而不会伪造盒体 G-code。
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
from typing import Any

from meshlib import load_binary_stl
from prepare_orca_job import DEFAULT_ORCA, run_orca, write_plate_3mf


CAD_ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = CAD_ROOT.parents[3]
V04_ROOT = REPOSITORY_ROOT / "生成内容/3D打印/C题/v0.4"
V06_ROOT = REPOSITORY_ROOT / "生成内容/3D打印/C题/v0.6"
DEFAULT_OUTPUT = V06_ROOT / "钥匙盒二件套"
DEFAULT_SOURCE_PROFILES = V04_ROOT / "orcaslicer/individual_parts/profiles"
DEFAULT_COVER_GCODE = (
    V04_ROOT / "orcaslicer/individual_parts/gcode/02_钥匙上盖.gcode"
)
DEFAULT_BOX_STL = DEFAULT_OUTPUT / "钥匙盒体_v0.6.stl"
DEFAULT_COVER_STL = V04_ROOT / "STL模型文件/compact_key_top_cover.stl"

EXPECTED_COVER_GCODE_SHA256 = (
    "34d6c473ce8087b821ac73211a122a96828ab8b2fbee15a71ea525b93d7cf41c"
)
EXPECTED_COVER_STL_SHA256 = (
    "05317c264a8327e5853fb774c1f9568e3b9d3e38bddd5eb73f3069ae7fb398ef"
)
PROFILE_NAMES = (
    "CR-3040D_0.4_machine.json",
    "C_problem_PETG_0.20_process.json",
    "Caige_PETG_1.75_filament.json",
)
PRINTABLE_SIZE_MM = 256.0


def sha256_file(path: Path) -> str:
    """Return the SHA-256 digest of a complete file."""

    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def require_hash(path: Path, expected: str, label: str) -> str:
    """Fail closed when a fixed legacy artifact is not the approved revision."""

    if not path.is_file():
        raise FileNotFoundError(f"{label} not found: {path}")
    actual = sha256_file(path)
    if actual != expected:
        raise ValueError(
            f"{label} SHA-256 mismatch: expected {expected}, found {actual}"
        )
    return actual


def ensure_not_legacy_output(output: Path, legacy_root: Path = V04_ROOT) -> None:
    """Disallow writes beneath v0.4, which remains a read-only release."""

    try:
        output.resolve().relative_to(legacy_root.resolve())
    except ValueError:
        return
    raise ValueError(f"output must not be inside the read-only v0.4 tree: {output}")


def derive_profiles(source_dir: Path, output_dir: Path) -> dict[str, Any]:
    """Copy v0.4 profiles, changing only the machine printable volume."""

    output_dir.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, Any]] = []
    for name in PROFILE_NAMES:
        source = source_dir / name
        destination = output_dir / name
        if not source.is_file():
            raise FileNotFoundError(f"v0.4 profile not found: {source}")
        source_hash = sha256_file(source)
        if name != PROFILE_NAMES[0]:
            shutil.copyfile(source, destination)
            changed_keys: list[str] = []
        else:
            source_payload = json.loads(source.read_text(encoding="utf-8"))
            derived_payload = dict(source_payload)
            derived_payload["printable_area"] = [
                "0x0",
                "256x0",
                "256x256",
                "0x256",
            ]
            derived_payload["printable_height"] = "256"
            changed_keys = sorted(
                key
                for key in set(source_payload) | set(derived_payload)
                if source_payload.get(key) != derived_payload.get(key)
            )
            if changed_keys != ["printable_area", "printable_height"]:
                raise RuntimeError(
                    "derived machine profile changed fields beyond printable volume: "
                    f"{changed_keys}"
                )
            write_json(destination, derived_payload)
        records.append(
            {
                "name": name,
                "source": str(source),
                "source_sha256": source_hash,
                "derived": str(destination),
                "derived_sha256": sha256_file(destination),
                "changed_keys": changed_keys,
            }
        )
    return {
        "source_directory": str(source_dir),
        "derived_directory": str(output_dir),
        "records": records,
    }


def stl_dimensions(path: Path) -> list[float]:
    """Read a binary STL and return its XYZ extents without CAD-script coupling."""

    if not path.is_file():
        raise FileNotFoundError(f"STL not found: {path}")
    mesh = load_binary_stl(path, path.stem)
    dimensions = [float(value) for value in mesh.dimensions]
    if any(value <= 0.0 for value in dimensions):
        raise ValueError(f"STL has non-positive dimensions: {path}: {dimensions}")
    if any(value > PRINTABLE_SIZE_MM for value in dimensions):
        raise ValueError(
            f"STL exceeds {PRINTABLE_SIZE_MM:g} mm printable volume: "
            f"{path}: {dimensions}"
        )
    return [round(value, 6) for value in dimensions]


def read_validation_report(box_stl: Path, explicit_report: Path | None) -> dict[str, Any] | None:
    """Record an optional CAD validation report without assuming its schema."""

    report = explicit_report or box_stl.parent / "validation_report.json"
    if not report.is_file():
        return None
    # Parse it so a malformed report cannot be presented as a valid source.
    json.loads(report.read_text(encoding="utf-8"))
    return {"path": str(report), "sha256": sha256_file(report)}


def build_box_plate(box_stl: Path) -> dict[str, Any]:
    """Create a one-object, centered 256 mm deterministic plate."""

    dimensions = stl_dimensions(box_stl)
    center = PRINTABLE_SIZE_MM / 2.0
    half_x, half_y = dimensions[0] / 2.0, dimensions[1] / 2.0
    bounds = [
        round(center - half_x, 6),
        round(center - half_y, 6),
        round(center + half_x, 6),
        round(center + half_y, 6),
    ]
    return {
        "plate": 1,
        "file_tag": "plate_01_钥匙盒体_v0.6_x1",
        "revision": "0.6",
        "bed_mm": [PRINTABLE_SIZE_MM, PRINTABLE_SIZE_MM],
        "layout_verified_non_overlapping": True,
        "model_bounds_mm": bounds,
        "items": [
            {
                "id": "钥匙盒体_v0.6",
                "part": "钥匙盒体_v0.6",
                "source": str(box_stl.resolve()),
                "dimensions_mm": dimensions,
                "rotation_deg": 0,
                "bounds_mm": bounds,
                "center_mm": [center, center],
            }
        ],
    }


def copy_legacy_cover_gcode(
    source: Path, destination: Path, expected_hash: str = EXPECTED_COVER_GCODE_SHA256
) -> dict[str, Any]:
    """Byte-copy the approved v0.4 cover G-code after hash verification."""

    source_hash = require_hash(source, expected_hash, "v0.4 cover G-code")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    copied_hash = sha256_file(destination)
    if copied_hash != source_hash:
        raise RuntimeError("v0.4 cover G-code copy SHA-256 mismatch")
    return {
        "mode": "byte_copy_from_v0.4",
        "source": str(source),
        "source_sha256": source_hash,
        "path": str(destination),
        "sha256": copied_hash,
    }


def copy_legacy_cover_stl(
    source: Path,
    destination: Path,
    expected_hash: str = EXPECTED_COVER_STL_SHA256,
) -> dict[str, Any]:
    """Byte-copy the approved v0.4 cover STL into the v0.6 delivery."""

    source_hash = require_hash(source, expected_hash, "v0.4 cover STL")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.resolve() != destination.resolve():
        shutil.copyfile(source, destination)
    copied_hash = sha256_file(destination)
    if copied_hash != source_hash:
        raise RuntimeError("v0.4 cover STL copy SHA-256 mismatch")
    return {
        "mode": "byte_copy_from_v0.4",
        "source": str(source),
        "source_sha256": source_hash,
        "path": str(destination),
        "sha256": copied_hash,
        "dimensions_mm": stl_dimensions(destination),
    }


def prepare_job(
    *,
    box_stl: Path,
    cover_stl: Path,
    cover_gcode: Path,
    source_profiles: Path,
    output: Path,
    validation_report: Path | None = None,
    slice_box: bool = False,
    orca: Path = DEFAULT_ORCA,
    expected_cover_gcode_hash: str = EXPECTED_COVER_GCODE_SHA256,
    expected_cover_stl_hash: str = EXPECTED_COVER_STL_SHA256,
) -> dict[str, Any]:
    """Prepare the v0.6 release; only ``slice_box`` invokes OrcaSlicer."""

    ensure_not_legacy_output(output)
    output.mkdir(parents=True, exist_ok=True)
    delivered_cover_stl = output / "钥匙盒盖_v0.4.stl"
    cover_stl_record = copy_legacy_cover_stl(
        cover_stl,
        delivered_cover_stl,
        expected_cover_stl_hash,
    )
    box_dimensions = stl_dimensions(box_stl)
    report = read_validation_report(box_stl, validation_report)
    profile_report = derive_profiles(source_profiles, output / "profiles")
    plate = build_box_plate(box_stl)
    projects_dir = output / "projects"
    gcode_dir = output / "gcode"
    box_3mf = projects_dir / "钥匙盒体_v0.6.3mf"
    box_gcode = gcode_dir / "钥匙盒体_v0.6.gcode"
    orca_result: dict[str, Any] | None = None

    if slice_box:
        profile_paths = tuple(
            output / "profiles" / name for name in PROFILE_NAMES
        )
        orca_result = run_orca(
            orca=orca,
            profiles=profile_paths,
            plates=[plate],
            output=output,
            config={"job_name": "钥匙盒体_v0.6"},
        )
        generated_project = Path(orca_result["layout_projects_3mf"][0]["path"])
        generated_gcode = Path(orca_result["gcodes"][0]["path"])
        projects_dir.mkdir(parents=True, exist_ok=True)
        generated_project.replace(box_3mf)
        gcode_dir.mkdir(parents=True, exist_ok=True)
        generated_gcode.replace(box_gcode)
        orca_result["layout_projects_3mf"][0]["path"] = str(box_3mf)
        orca_result["layout_projects_3mf"][0]["sha256"] = sha256_file(box_3mf)
        orca_result["gcodes"][0]["path"] = str(box_gcode)
        orca_result["gcodes"][0]["sha256"] = sha256_file(box_gcode)
    else:
        # A dry run has a valid 3MF input but deliberately no fabricated body G-code.
        write_plate_3mf(plate, box_3mf)
        box_gcode.unlink(missing_ok=True)

    cover_gcode_record = copy_legacy_cover_gcode(
        cover_gcode,
        gcode_dir / "钥匙盒盖_v0.4.gcode",
        expected_cover_gcode_hash,
    )
    artifacts = {
        "box_stl": {
            "path": str(box_stl),
            "sha256": sha256_file(box_stl),
            "dimensions_mm": box_dimensions,
        },
        "cover_stl": {
            **cover_stl_record,
        },
        "box_project_3mf": {
            "path": str(box_3mf),
            "sha256": sha256_file(box_3mf),
        },
        "box_gcode": (
            {"path": str(box_gcode), "sha256": sha256_file(box_gcode)}
            if slice_box
            else None
        ),
        "cover_gcode": cover_gcode_record,
    }
    hash_report = {
        "legacy_v0_4_read_only": True,
        "profiles": profile_report,
        "artifacts": artifacts,
    }
    hash_report_path = output / "hash_report.json"
    write_json(hash_report_path, hash_report)
    manifest = {
        "release": "v0.6",
        "assembly": "钥匙盒二件套",
        "status": "盒体已由 OrcaSlicer 切片" if slice_box else "dry-run：盒体尚未切片",
        "printable_volume_mm": [256, 256, 256],
        "body_reslice_required": not slice_box,
        "body_slice_policy": "v0.6 盒体必须由当前 STL 切片，禁止复制旧版盒体 G-code",
        "legacy_cover_gcode": "v0.4 approved byte copy; never resliced",
        "validation_report": report,
        "deterministic_plates": [plate],
        "orca": orca_result,
        "hash_report": str(hash_report_path),
        "artifacts": artifacts,
    }
    manifest_path = output / "print_manifest.json"
    write_json(manifest_path, manifest)
    return {
        "manifest": manifest,
        "manifest_path": manifest_path,
        "hash_report_path": hash_report_path,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--box-stl", type=Path, default=DEFAULT_BOX_STL)
    parser.add_argument("--cover-stl", type=Path, default=DEFAULT_COVER_STL)
    parser.add_argument("--cover-gcode", type=Path, default=DEFAULT_COVER_GCODE)
    parser.add_argument("--source-profiles", type=Path, default=DEFAULT_SOURCE_PROFILES)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--validation-report", type=Path)
    parser.add_argument("--slice-box", action="store_true")
    parser.add_argument("--orca", type=Path, default=DEFAULT_ORCA)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    result = prepare_job(
        box_stl=args.box_stl,
        cover_stl=args.cover_stl,
        cover_gcode=args.cover_gcode,
        source_profiles=args.source_profiles,
        output=args.output,
        validation_report=args.validation_report,
        slice_box=args.slice_box,
        orca=args.orca,
    )
    print(
        json.dumps(
            {
                "ok": True,
                "sliced": args.slice_box,
                "manifest": str(result["manifest_path"]),
                "hash_report": str(result["hash_report_path"]),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
