#!/usr/bin/env python3
"""Create a safe first-layer-only trial from a full OrcaSlicer G-code file."""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path


LAYER_MARKER = ";LAYER_CHANGE"


def source_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_first_layer_trial(source: Path) -> str:
    retained: list[str] = []
    layer_markers = 0
    for line in source.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.lstrip().startswith(LAYER_MARKER):
            layer_markers += 1
            if layer_markers == 2:
                break
        retained.append(line)
    if layer_markers < 2:
        raise ValueError(f"source does not contain two layer markers: {source}")

    header = [
        "; FIRST_LAYER_TRIAL_FILE",
        f"; source = {source}",
        f"; source_sha256 = {source_sha256(source)}",
        "; purpose = verify clean bed, Z offset and PETG adhesion before full plate",
        "; stop after the first printed layer; do not treat as a finished part",
        "",
    ]
    shutdown = [
        "",
        "; FIRST_LAYER_TRIAL_END",
        "M400 ; wait for queued moves",
        "G1 E-1 F1800 ; retract",
        "G91",
        "G1 Z5 F600 ; lift clear of the trial layer",
        "G90",
        "M104 S0 ; turn off nozzle",
        "M140 S0 ; turn off bed",
        "M107 ; turn off fan",
        "G1 X0 Y105 F3000 ; park",
        "M84 ; disable motors",
        "",
    ]
    return "\n".join(header + retained + shutdown)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    payload = build_first_layer_trial(args.source)
    args.output.write_text(payload, encoding="utf-8")
    print(
        f'{{"ok": true, "source": "{args.source}", "output": "{args.output}"}}'
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
