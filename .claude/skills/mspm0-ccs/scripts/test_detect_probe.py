#!/usr/bin/env python3
"""Darwin fixture tests for detect_probe.py (no hardware access required)."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("detect_probe.py")
SPEC = importlib.util.spec_from_file_location("detect_probe", MODULE_PATH)
assert SPEC and SPEC.loader
detect_probe = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = detect_probe
SPEC.loader.exec_module(detect_probe)


XDS110 = r'''
+-o XDS110@14100000  <class IOUSBHostDevice, id 0x1>
  |   "USB Product Name" = "XDS110 Class Application/User UART"
  |   "USB Vendor Name" = "Texas Instruments"
  |   "USB Serial Number" = "00002156"
  |   "idVendor" = 0x0451
  |   "idProduct" = 48883
'''

UNKNOWN = r'''
+-o Mystery Device@14200000  <class IOUSBHostDevice, id 0x2>
  |   "USB Product Name" = "Mystery USB Device"
  |   "USB Vendor Name" = "Unknown"
  |   "idVendor" = 4660
  |   "idProduct" = 22136
'''


class DarwinProbeTests(unittest.TestCase):
    def test_xds110_decimal_and_hex_ids_and_serial(self) -> None:
        with patch.object(detect_probe, "run_command", return_value=XDS110):
            probes = detect_probe.detect_darwin()
        self.assertEqual(len(probes), 1)
        probe = probes[0]
        self.assertEqual(probe.kind, "xds110")
        self.assertEqual(probe.usb_id, "0451:BEF3")
        self.assertEqual(probe.serial_number, "00002156")
        self.assertEqual(probe.recommended_backend, "dslite_or_ccs_dss")

    def test_no_supported_device(self) -> None:
        with patch.object(detect_probe, "run_command", return_value=UNKNOWN):
            self.assertEqual(detect_probe.detect_darwin(), [])

    def test_multiple_supported_devices_are_reported(self) -> None:
        jlink = XDS110.replace("XDS110 Class Application/User UART", "J-Link").replace(
            "0x0451", "0x1366"
        ).replace("48879", "1")
        with patch.object(detect_probe, "run_command", return_value=XDS110 + jlink):
            probes = detect_probe.detect_darwin()
        self.assertEqual({probe.kind for probe in probes}, {"xds110", "jlink"})

    def test_ioreg_failure_is_propagated(self) -> None:
        with patch.object(detect_probe, "run_command", side_effect=RuntimeError("ioreg denied")):
            with self.assertRaises(RuntimeError):
                detect_probe.detect_darwin()


if __name__ == "__main__":
    unittest.main()
