# Source Provenance

- Upstream: https://github.com/37chengshan/k230-steel-ball-detector
- Pinned commit: `0490ea50928bcb2e6a46610397d868d2e32d51c7` (short `0490ea5`)
- Commit subject: stabilize quantized K230 steel ball detection
- Commit date: 2026-07-28 12:13:00 +0800
- License: MIT (original code/docs). Third-party weights/datasets/deps keep their own licenses.
- Copied on: 2026-07-29
- Selection policy: copy reference code/docs/tests/scripts and conversion metadata only; **do not** vendor large `.kmodel` / `.pt` / `.onnx` weights into this contest repo.
- Recommended upstream path (not copied as binary here):
  - `models/steel_ball_yolo26n_epoch19_416_i16w8.kmodel`
  - `canmv/steel_ball_yolo26_uart_epoch19.py`
- Status note from upstream README: full K230 on-device acceptance is not finished; treat as reference baseline only, not contest final solution.
