#!/usr/bin/env python3
"""Audit the 2026-07-31 two-station captures and export the MSPM0 model."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import struct
import tempfile
import zlib
from collections import defaultdict
from pathlib import Path
from typing import Any


MODULE_DIR = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = (
    MODULE_DIR / "calibration" / "two_station_20260731.json"
)
MODEL_HEADER_NAME = "two_station_model_data.h"
MODEL_SOURCE_NAME = "two_station_model_data.c"


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def parse_capture_truth(
    metadata: dict[str, Any], manifest: dict[str, Any]
) -> tuple[int, int] | None:
    selection = manifest["selection"]
    capture_id = str(metadata["id"])
    if capture_id in set(selection["excludedCaptureIds"]):
        return None

    label = str(metadata.get("label", "")).strip().replace("。", ".")
    match = re.match(
        r"(?P<distance>\d+(?:\.\d+)?)\s*m\s*"
        r"(?P<angle>[+-]?\d+(?:\.\d+)?)?\s*(?:度)?",
        label,
    )
    if match is None:
        raise ValueError(f"无法解析标定标签：{capture_id} {label!r}")

    distance_mm = round(float(match.group("distance")) * 1000)
    angle_deg = round(float(match.group("angle") or 0))
    if capture_id == selection["firstMislabeledCaptureId"]:
        angle_deg = int(selection["firstMislabeledOriginalAngleDeg"])
    if str(metadata["startedAt"]) < str(selection["angleSignFlipBefore"]):
        angle_deg = -angle_deg
    return distance_mm, angle_deg


def audit_captures(
    captures_dir: Path, manifest: dict[str, Any]
) -> dict[str, Any]:
    session_id = manifest["sessionId"]
    selection = manifest["selection"]
    session_metadata: list[dict[str, Any]] = []
    selected: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    physical_points: dict[tuple[int, int], list[str]] = defaultdict(list)
    file_hashes: list[dict[str, Any]] = []

    for meta_path in sorted(captures_dir.glob("*.meta.json")):
        metadata = load_json(meta_path)
        if metadata.get("sessionId") != session_id:
            continue
        session_metadata.append(metadata)
        truth = parse_capture_truth(metadata, manifest)
        jsonl_path = captures_dir / f"{metadata['id']}.jsonl"
        if not jsonl_path.is_file():
            raise FileNotFoundError(f"缺少原始帧：{jsonl_path}")
        if truth is None:
            excluded.append(
                {
                    "captureId": metadata["id"],
                    "label": metadata.get("label"),
                }
            )
        else:
            selected.append(metadata)
            physical_points[truth].append(str(metadata["id"]))
        for path in (meta_path, jsonl_path):
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            file_hashes.append(
                {
                    "name": path.name,
                    "bytes": path.stat().st_size,
                    "sha256": digest,
                }
            )

    expected_session = int(selection["expectedSessionCaptureCount"])
    expected_usable = int(selection["expectedUsableCaptureCount"])
    expected_points = int(selection["expectedPhysicalPointCount"])
    if len(session_metadata) != expected_session:
        raise ValueError(
            f"会话采集数错误：{len(session_metadata)}，期望 {expected_session}"
        )
    if len(selected) != expected_usable:
        raise ValueError(
            f"有效采集数错误：{len(selected)}，期望 {expected_usable}"
        )
    if len(physical_points) != expected_points:
        raise ValueError(
            f"物理点数错误：{len(physical_points)}，期望 {expected_points}"
        )

    prototype_keys = {
        (int(row["distanceMm"]), int(row["angleDeg"]))
        for row in manifest["prototypes"]
    }
    point_keys = set(physical_points)
    if point_keys != prototype_keys:
        raise ValueError(
            "原始数据物理点与冻结原型不一致："
            f"缺少={sorted(prototype_keys - point_keys)}，"
            f"多出={sorted(point_keys - prototype_keys)}"
        )

    return {
        "sessionId": session_id,
        "sessionCaptureCount": len(session_metadata),
        "usableCaptureCount": len(selected),
        "excludedCaptureCount": len(excluded),
        "physicalPointCount": len(physical_points),
        "excludedCaptures": excluded,
        "physicalPoints": [
            {
                "distanceMm": distance_mm,
                "angleDeg": angle_deg,
                "captureIds": sorted(capture_ids),
            }
            for (distance_mm, angle_deg), capture_ids in sorted(
                physical_points.items()
            )
        ],
        "files": sorted(file_hashes, key=lambda row: row["name"]),
    }


def q16(value: float) -> int:
    return round(value * (1 << 16))


def q24(value: float) -> int:
    return round(value * (1 << 24))


def model_binary(manifest: dict[str, Any]) -> bytes:
    runtime = manifest["runtime"]
    geometry = manifest["geometry"]
    prototypes = manifest["prototypes"]
    data = bytearray()
    data.extend(
        struct.pack(
            "<IHH",
            int(runtime["modelMagic"], 16),
            int(runtime["modelVersion"], 16),
            len(prototypes),
        )
    )
    data.extend(
        struct.pack(
            "<HHHHHH",
            int(geometry["right"]["address"], 16),
            int(geometry["left"]["address"], 16),
            int(runtime["windowMs"]),
            int(runtime["pairSkewMs"]),
            int(runtime["updatePeriodMs"]),
            int(runtime["holdMs"]),
        )
    )
    data.extend(
        struct.pack(
            "<IIIIHH",
            q16(float(runtime["scaleRightMm"])),
            q16(float(runtime["scaleLeftMm"])),
            q24(float(runtime["qFloor"])),
            q24(float(runtime["highNearestQ"])),
            int(runtime["minimumDistanceMm"]),
            int(runtime["maximumDistanceMm"]),
        )
    )
    for row in prototypes:
        data.extend(
            struct.pack(
                "<HHHbB",
                int(row["rightMm"]),
                int(row["leftMm"]),
                int(row["distanceMm"]),
                int(row["angleDeg"]),
                0,
            )
        )
    return bytes(data)


def model_crc32(manifest: dict[str, Any]) -> int:
    return zlib.crc32(model_binary(manifest)) & 0xFFFFFFFF


def render_header() -> str:
    return (
        "#ifndef TWO_STATION_MODEL_DATA_H\n"
        "#define TWO_STATION_MODEL_DATA_H\n\n"
        '#include "uwb_two_station_estimator.h"\n\n'
        "extern const UwbTwoStationModel g_two_station_model_20260731;\n\n"
        "#endif\n"
    )


def render_source(manifest: dict[str, Any]) -> str:
    runtime = manifest["runtime"]
    geometry = manifest["geometry"]
    prototypes = manifest["prototypes"]
    crc32 = model_crc32(manifest)
    rows = "\n".join(
        "    "
        f"{{{int(row['rightMm'])}U, {int(row['leftMm'])}U, "
        f"{int(row['distanceMm'])}U, {int(row['angleDeg'])}, 0U}},"
        for row in prototypes
    )
    return f"""#include "{MODEL_HEADER_NAME}"

/*
 * Generated from calibration/two_station_20260731.json.
 * Right device/address: {geometry['right']['device']}/{geometry['right']['address']}.
 * Left device/address: {geometry['left']['device']}/{geometry['left']['address']}.
 * Runtime angle remains diagnostic only.
 */
static const UwbTwoStationPrototype g_two_station_prototypes_20260731[] = {{
{rows}
}};

const UwbTwoStationModel g_two_station_model_20260731 = {{
    .magic = UWB_TWO_STATION_MODEL_MAGIC,
    .version = UWB_TWO_STATION_MODEL_VERSION,
    .prototype_count =
        (uint16_t)(sizeof(g_two_station_prototypes_20260731) /
                   sizeof(g_two_station_prototypes_20260731[0])),
    .serialized_bytes = UWB_TWO_STATION_MODEL_SERIALIZED_BYTES,
    .station_address = {{
        0x{int(geometry['right']['address'], 16):04X}U,
        0x{int(geometry['left']['address'], 16):04X}U
    }},
    .window_ms = {int(runtime['windowMs'])}U,
    .pair_skew_ms = {int(runtime['pairSkewMs'])}U,
    .update_period_ms = {int(runtime['updatePeriodMs'])}U,
    .hold_ms = {int(runtime['holdMs'])}U,
    .scale_right_q16 = {q16(float(runtime['scaleRightMm']))}UL,
    .scale_left_q16 = {q16(float(runtime['scaleLeftMm']))}UL,
    .q_floor_q24 = {q24(float(runtime['qFloor']))}UL,
    .high_nearest_q24 = {q24(float(runtime['highNearestQ']))}UL,
    .minimum_distance_mm = {int(runtime['minimumDistanceMm'])}U,
    .maximum_distance_mm = {int(runtime['maximumDistanceMm'])}U,
    .crc32 = 0x{crc32:08X}UL,
    .prototypes = g_two_station_prototypes_20260731,
}};
"""


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", dir=path.parent
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--captures", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--audit-json", type=Path)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Compare generated C files with the current firmware files.",
    )
    args = parser.parse_args()

    manifest = load_json(args.manifest)
    summary: dict[str, Any] = {
        "manifest": str(args.manifest),
        "prototypeCount": len(manifest["prototypes"]),
        "serializedBytes": len(model_binary(manifest)),
        "crc32": f"{model_crc32(manifest):08X}",
    }
    if args.captures is not None:
        summary["captureAudit"] = audit_captures(args.captures, manifest)
    if args.output_dir is not None:
        atomic_write(args.output_dir / MODEL_HEADER_NAME, render_header())
        atomic_write(
            args.output_dir / MODEL_SOURCE_NAME, render_source(manifest)
        )
        summary["outputDirectory"] = str(args.output_dir)
    if args.check:
        expected = {
            MODEL_HEADER_NAME: render_header(),
            MODEL_SOURCE_NAME: render_source(manifest),
        }
        mismatches = [
            name
            for name, content in expected.items()
            if not (MODULE_DIR / name).is_file()
            or (MODULE_DIR / name).read_text(encoding="utf-8") != content
        ]
        summary["firmwareFilesMatch"] = len(mismatches) == 0
        summary["mismatchedFiles"] = mismatches
        if mismatches:
            print(json.dumps(summary, ensure_ascii=False, indent=2))
            raise SystemExit(1)
    if args.audit_json is not None:
        atomic_write(
            args.audit_json,
            json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        )
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
