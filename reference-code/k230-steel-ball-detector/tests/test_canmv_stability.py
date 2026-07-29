from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "canmv" / "steel_ball_yolo26_uart_epoch19.py"


def load_canmv_script():
    libs = types.ModuleType("libs")
    pipeline_module = types.ModuleType("libs.PipeLine")
    pipeline_module.PipeLine = object
    ai_base_module = types.ModuleType("libs.AIBase")
    ai_base_module.AIBase = object
    ai2d_module = types.ModuleType("libs.AI2D")
    ai2d_module.Ai2d = object
    machine = types.ModuleType("machine")
    machine.FPIOA = object
    machine.UART = types.SimpleNamespace(UART2=2)
    nncase_runtime = types.ModuleType("nncase_runtime")
    ulab = types.ModuleType("ulab")
    ulab_numpy = types.ModuleType("ulab.numpy")

    stubs = {
        "libs": libs,
        "libs.PipeLine": pipeline_module,
        "libs.AIBase": ai_base_module,
        "libs.AI2D": ai2d_module,
        "machine": machine,
        "nncase_runtime": nncase_runtime,
        "ulab": ulab,
        "ulab.numpy": ulab_numpy,
    }
    previous = {name: sys.modules.get(name) for name in stubs}
    sys.modules.update(stubs)
    try:
        spec = importlib.util.spec_from_file_location("steel_ball_canmv_test", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        return module
    finally:
        for name, value in previous.items():
            if value is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value


def test_geometry_rejects_large_and_wide_false_boxes():
    module = load_canmv_script()
    predicate = getattr(module, "detection_passes_geometry", lambda detection: True)

    assert predicate((120, 80, 24, 22, 0.75))
    assert not predicate((20, 160, 190, 92, 0.80))
    assert not predicate((300, 250, 70, 12, 0.70))


def test_tracker_requires_three_consistent_hits_for_medium_score():
    module = load_canmv_script()
    tracker = module.Tracker()
    detection = (120, 80, 24, 22, 0.55)

    assert tracker.update([detection]) == []
    assert tracker.update([detection]) == []
    stable = tracker.update([detection])

    assert len(stable) == 1


def test_tracker_smooths_displayed_confidence():
    module = load_canmv_script()
    tracker = module.Tracker()

    tracker.update([(120, 80, 24, 22, 0.80)])
    tracker.update([(121, 81, 24, 22, 0.50)])
    stable = tracker.update([(120, 80, 24, 22, 0.70)])

    assert len(stable) == 1
    assert 0.60 < stable[0][4] < 0.75
