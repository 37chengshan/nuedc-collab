"""K230 CanMV v1.6 steel-ball detector for the YOLO26 epoch-19 KModel.

TF-card layout:
  /sdcard/models/steel_ball_yolo26n_epoch19_416_i16w8.kmodel
  /sdcard/steel_ball_yolo26_uart_epoch19.py

The model has an end-to-end output shaped [1, 300, 6]. Each row is
[x1, y1, x2, y2, confidence, class_id]. It must not be decoded with the
YOLOv8/YOLO11 [1, 5, N] wrappers.
"""

from libs.PipeLine import PipeLine
from libs.AIBase import AIBase
from libs.AI2D import Ai2d
from machine import FPIOA, UART
import gc
import os
import sys
import nncase_runtime as nn
import ulab.numpy as np


SCRIPT_VERSION = "STEEL-BALL-YOLO26-EPOCH19-416-I16W8-V4"
KMODEL_PATH = "/sdcard/models/steel_ball_yolo26n_epoch19_416_i16w8.kmodel"
MODEL_INPUT_SIZE = [416, 416]
AI_CAPTURE_SIZE = [512, 288]
DISPLAY_MODE = "virt"
DISPLAY_SIZE = [800, 480]
CONFIDENCE_THRESHOLD = 0.15
DISPLAY_CONFIDENCE_THRESHOLD = 0.30
FAST_CONFIRM_THRESHOLD = 0.70
MAX_BOXES = 100
ENABLE_TRACKING = True

CONFIRM_HITS = 3
COAST_MAX = 2
MATCH_DISTANCE = 36
EMA_ALPHA = 0.50
SCORE_EMA_ALPHA = 0.35

MIN_BOX_SIDE = 5
MIN_ASPECT_RATIO = 0.60
MAX_ASPECT_RATIO = 1.65
MAX_BOX_WIDTH_RATIO = 0.22
MAX_BOX_HEIGHT_RATIO = 0.35
MAX_BOX_AREA_RATIO = 0.08

ENABLE_UART = True
UART_ID = UART.UART2
UART_BAUD = 115200
UART2_TX_GPIO = 11
UART2_RX_GPIO = 12
UART_SEND_EVERY_N_FRAMES = 10


def file_exists(path):
    try:
        with open(path, "rb"):
            return True
    except OSError:
        return False


def clamp(value, lower, upper):
    return max(lower, min(upper, value))


def model_input(frame):
    if hasattr(frame, "to_numpy_ref"):
        return frame.to_numpy_ref()
    return frame


def init_uart():
    if not ENABLE_UART:
        return None
    fpioa = FPIOA()
    fpioa.set_function(UART2_TX_GPIO, FPIOA.UART2_TXD)
    fpioa.set_function(UART2_RX_GPIO, FPIOA.UART2_RXD)
    return UART(UART_ID, baudrate=UART_BAUD, bits=8, parity=0, stop=1)


class Yolo26Detector(AIBase):
    """Decode the YOLO26 end-to-end tensor without applying NMS again."""

    def __init__(self, kmodel_path, model_input_size, rgb888p_size, debug_mode=0):
        super().__init__(kmodel_path, model_input_size, rgb888p_size, debug_mode)
        self.model_input_size = model_input_size
        self.rgb888p_size = rgb888p_size
        self.output_logged = False
        self.last_max_score = 0.0
        self.last_count_005 = 0
        self.last_count_010 = 0
        self.last_count_020 = 0
        self.last_count_030 = 0
        self.ai2d = Ai2d(debug_mode)
        self.ai2d.set_ai2d_dtype(
            nn.ai2d_format.NCHW_FMT,
            nn.ai2d_format.NCHW_FMT,
            np.uint8,
            np.uint8,
        )

    def config_preprocess(self, input_image_size=None):
        source_size = input_image_size if input_image_size else self.rgb888p_size
        self.ai2d.resize(
            interp_method=nn.interp_method.tf_bilinear,
            interp_mode=nn.interp_mode.half_pixel,
        )
        self.ai2d.build(
            [1, 3, source_size[1], source_size[0]],
            [1, 3, self.model_input_size[1], self.model_input_size[0]],
        )

    def postprocess(self, results):
        if not results or len(results) != 1:
            raise RuntimeError("expected one YOLO26 output tensor")
        output = results[0]
        shape = getattr(output, "shape", None)
        if not self.output_logged:
            print("stage=KPU_OUTPUT shape=%s dtype=%s" % (
                shape, getattr(output, "dtype", None),
            ))
            self.output_logged = True
        if shape is None or len(shape) != 3 or shape[0] != 1 or shape[2] != 6:
            raise RuntimeError("expected KPU output [1,300,6], got %s" % (shape,))

        rows = output[0]
        source_w, source_h = self.rgb888p_size
        model_w, model_h = self.model_input_size
        scale_x = source_w / model_w
        scale_y = source_h / model_h
        detections = []
        max_score = 0.0
        count_005 = 0
        count_010 = 0
        count_020 = 0
        count_030 = 0
        for index in range(shape[1]):
            row = rows[index]
            score = float(row[4])
            class_id = int(round(float(row[5])))
            if class_id == 0:
                max_score = max(max_score, score)
                if score >= 0.05:
                    count_005 += 1
                if score >= 0.10:
                    count_010 += 1
                if score >= 0.20:
                    count_020 += 1
                if score >= 0.30:
                    count_030 += 1
            if score < CONFIDENCE_THRESHOLD or class_id != 0:
                continue
            x1 = clamp(int(round(float(row[0]) * scale_x)), 0, source_w - 1)
            y1 = clamp(int(round(float(row[1]) * scale_y)), 0, source_h - 1)
            x2 = clamp(int(round(float(row[2]) * scale_x)), 0, source_w - 1)
            y2 = clamp(int(round(float(row[3]) * scale_y)), 0, source_h - 1)
            if x2 <= x1 or y2 <= y1:
                continue
            detections.append((x1, y1, x2 - x1, y2 - y1, score))
        self.last_max_score = max_score
        self.last_count_005 = count_005
        self.last_count_010 = count_010
        self.last_count_020 = count_020
        self.last_count_030 = count_030
        detections.sort(key=lambda item: item[4], reverse=True)
        return detections[:MAX_BOXES]


class Track:
    def __init__(self, detection):
        self.x, self.y, self.width, self.height, self.confidence = detection
        self.hits = 1
        self.misses = 0
        self.confirmed = False

    def centre(self):
        return self.x + self.width // 2, self.y + self.height // 2


def detection_passes_geometry(detection):
    """Reject large or elongated regions that cannot be a competition ball."""
    _, _, width, height, _ = detection
    if width < MIN_BOX_SIDE or height < MIN_BOX_SIDE:
        return False
    aspect_ratio = width / height
    if aspect_ratio < MIN_ASPECT_RATIO or aspect_ratio > MAX_ASPECT_RATIO:
        return False
    frame_width, frame_height = AI_CAPTURE_SIZE
    if width > frame_width * MAX_BOX_WIDTH_RATIO:
        return False
    if height > frame_height * MAX_BOX_HEIGHT_RATIO:
        return False
    if width * height > frame_width * frame_height * MAX_BOX_AREA_RATIO:
        return False
    return True


class Tracker:
    def __init__(self):
        self.tracks = []

    def update(self, detections):
        used = [False] * len(detections)
        limit = MATCH_DISTANCE * MATCH_DISTANCE
        for track in self.tracks:
            tx, ty = track.centre()
            best_index = -1
            best_distance = limit
            for index, detection in enumerate(detections):
                if used[index]:
                    continue
                x, y, width, height, _ = detection
                cx, cy = x + width // 2, y + height // 2
                distance = (cx - tx) * (cx - tx) + (cy - ty) * (cy - ty)
                if distance < best_distance:
                    best_distance = distance
                    best_index = index
            if best_index < 0:
                track.misses += 1
                if not track.confirmed:
                    track.hits = 0
                continue
            x, y, width, height, confidence = detections[best_index]
            used[best_index] = True
            alpha = EMA_ALPHA
            track.x = int(round(alpha * x + (1 - alpha) * track.x))
            track.y = int(round(alpha * y + (1 - alpha) * track.y))
            track.width = max(1, int(round(alpha * width + (1 - alpha) * track.width)))
            track.height = max(1, int(round(alpha * height + (1 - alpha) * track.height)))
            score_alpha = SCORE_EMA_ALPHA
            track.confidence = score_alpha * confidence + (1 - score_alpha) * track.confidence
            track.hits += 1
            track.misses = 0
            if (
                track.hits >= CONFIRM_HITS
                and track.confidence >= DISPLAY_CONFIDENCE_THRESHOLD
            ) or (
                track.hits >= 2
                and track.confidence >= FAST_CONFIRM_THRESHOLD
            ):
                track.confirmed = True
        for index, detection in enumerate(detections):
            if not used[index]:
                self.tracks.append(Track(detection))
        self.tracks = [track for track in self.tracks if track.misses <= COAST_MAX]
        return [
            (track.x, track.y, track.width, track.height, track.confidence)
            for track in self.tracks if track.confirmed
        ]


def draw_detections(pipeline, detections, display_size, max_score):
    osd = pipeline.osd_img
    osd.clear()
    scale_x = display_size[0] / AI_CAPTURE_SIZE[0]
    scale_y = display_size[1] / AI_CAPTURE_SIZE[1]
    for index, (x, y, width, height, score) in enumerate(detections):
        dx = int(round(x * scale_x))
        dy = int(round(y * scale_y))
        dw = max(1, int(round(width * scale_x)))
        dh = max(1, int(round(height * scale_y)))
        osd.draw_rectangle(dx, dy, dw, dh, color=(0, 255, 0), thickness=2)
        osd.draw_string_advanced(
            dx, max(0, dy - 18), 18,
            "%d %d%%" % (index, int(score * 100)), color=(0, 255, 0),
        )
    osd.draw_string_advanced(
        4, 4, 20,
        "balls=%d max=%d%%" % (len(detections), int(max_score * 100)),
        color=(255, 255, 0),
    )


def send_centres(uart, detections):
    if uart is None:
        return
    points = []
    for x, y, width, height, _ in detections:
        points.append("%d,%d" % (x + width // 2, y + height // 2))
    uart.write("BALL,N=%d;%s\r\n" % (len(points), ";".join(points)))


def print_exception(exc):
    print("STEEL-BALL ERROR:", exc)
    try:
        sys.print_exception(exc)
    except Exception:
        pass


def main(frame_limit=None):
    pipeline = None
    detector = None
    uart = None
    if not file_exists(KMODEL_PATH):
        print("ERROR: missing model", KMODEL_PATH)
        return
    try:
        print(SCRIPT_VERSION)
        print("model=%s ai=%s display=%s" % (KMODEL_PATH, AI_CAPTURE_SIZE, DISPLAY_MODE))
        pipeline = PipeLine(
            rgb888p_size=AI_CAPTURE_SIZE,
            display_mode=DISPLAY_MODE,
            display_size=DISPLAY_SIZE,
            debug_mode=0,
        )
        pipeline.create()
        display_size = pipeline.get_display_size()
        print("stage=PIPELINE_READY display=%s" % display_size)

        detector = Yolo26Detector(KMODEL_PATH, MODEL_INPUT_SIZE, AI_CAPTURE_SIZE, 0)
        detector.config_preprocess()
        print("stage=MODEL_READY contract=[1,300,6]")

        try:
            uart = init_uart()
            uart.write("BALL,BOOT=1,FRAME=%dx%d\r\n" % (AI_CAPTURE_SIZE[0], AI_CAPTURE_SIZE[1]))
            print("stage=UART_READY gpio11=tx gpio12=rx baud=115200")
        except Exception as exc:
            print("UART disabled:", exc)
            uart = None

        tracker = Tracker()
        frame_id = 0
        while True:
            os.exitpoint()
            frame = pipeline.get_frame()
            if frame is None:
                raise RuntimeError("camera returned no frame")
            if frame_id == 0:
                print("stage=KPU_RUN_BEGIN")
            raw = detector.run(model_input(frame))
            if frame_id == 0:
                print("stage=KPU_RUN_END")
            shaped = [detection for detection in raw if detection_passes_geometry(detection)]
            stable = tracker.update(shaped) if ENABLE_TRACKING else shaped
            if frame_id == 0:
                print("stage=FIRST_FRAME_READY raw=%d stable=%d" % (len(raw), len(stable)))
            if frame_id % 30 == 0:
                print("stage=DETECTION_DIAGNOSTIC max=%.4f raw=%d shaped=%d stable=%d n005=%d n010=%d n020=%d n030=%d" % (
                    detector.last_max_score,
                    len(raw),
                    len(shaped),
                    len(stable),
                    detector.last_count_005,
                    detector.last_count_010,
                    detector.last_count_020,
                    detector.last_count_030,
                ))
            stable_max = max([detection[4] for detection in stable]) if stable else 0.0
            draw_detections(pipeline, stable, display_size, stable_max)
            pipeline.show_image()
            if frame_id % UART_SEND_EVERY_N_FRAMES == 0:
                send_centres(uart, stable)
            frame_id += 1
            if frame_id % 60 == 0:
                gc.collect()
            if frame_limit is not None and frame_id >= frame_limit:
                print("SMOKE_TEST_PASS frames=%d" % frame_id)
                break
    except KeyboardInterrupt:
        print("user stop")
    except BaseException as exc:
        print_exception(exc)
    finally:
        if detector is not None:
            try:
                detector.deinit()
            except Exception:
                pass
        if pipeline is not None:
            try:
                pipeline.destroy()
            except Exception:
                pass
        if uart is not None:
            try:
                uart.deinit()
            except Exception:
                pass


if __name__ == "__main__":
    main()
