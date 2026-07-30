#ifndef CALIBRATION_MODEL_H
#define CALIBRATION_MODEL_H

#include "lock_types.h"

#include <stdbool.h>
#include <stdint.h>

#define CALIBRATION_MODEL_V1_MAGIC 0x31574255UL
#define CALIBRATION_MODEL_V1_VERSION 0x0100U
#define CALIBRATION_MODEL_V1_SERIALIZED_SIZE 900U
#define CALIBRATION_MODEL_V1_CRC_COVERED_SIZE 896U
#define CALIBRATION_RANGE_KNOT_CAPACITY 12U
#define CALIBRATION_DISTANCE_AXIS_CAPACITY 11U
#define CALIBRATION_ANGLE_AXIS_CAPACITY 7U
#define CALIBRATION_GRID_CAPACITY                                        \
    (CALIBRATION_DISTANCE_AXIS_CAPACITY * CALIBRATION_ANGLE_AXIS_CAPACITY)

#define CALIBRATION_MODEL_FLAG_DISTANCE_GRID 0x00000001UL
#define CALIBRATION_MODEL_FLAG_ANGLE_GRID 0x00000002UL

#define CALIBRATION_MIN_RANGE_MM 0.0f
#define CALIBRATION_MAX_RANGE_MM 3500.0f

typedef enum {
    CALIBRATION_RANGE_LINEAR = 1,
    CALIBRATION_RANGE_QUADRATIC,
    CALIBRATION_RANGE_MONOTONIC_PWL
} CalibrationRangeModelType;

typedef struct {
    uint8_t type;
    uint8_t knot_count;
    uint16_t reserved;
    float coefficients[3];
    float raw_knots_mm[CALIBRATION_RANGE_KNOT_CAPACITY];
    float corrected_knots_mm[CALIBRATION_RANGE_KNOT_CAPACITY];
} CalibrationRangeModelV1;

typedef struct {
    float process_noise_position;
    float process_noise_velocity;
    float measurement_noise_position;
    float initial_position_variance;
    float initial_velocity_variance;
    float max_dt_s;
    float huber_delta_mm;
    float nlos_threshold_mm;
} CalibrationKalmanParametersV1;

typedef struct {
    float distance_p95_mm;
    float distance_max_mm;
    float bearing_p95_deg;
    float bearing_max_deg;
    float boundary_p95_mm;
    float reserved;
} CalibrationValidationMetricsV1;

typedef struct {
    uint32_t magic;
    uint16_t version;
    uint16_t model_size_bytes;
    uint8_t anchor_count;
    uint8_t enabled_anchor_mask;
    uint8_t distance_axis_count;
    uint8_t angle_axis_count;
    uint32_t flags;
    LockAnchor2d anchors[LOCK_UWB_CHANNEL_COUNT];
    CalibrationRangeModelV1 range_models[LOCK_UWB_CHANNEL_COUNT];
    uint16_t distance_axis_mm[CALIBRATION_DISTANCE_AXIS_CAPACITY];
    int16_t angle_axis_cdeg[CALIBRATION_ANGLE_AXIS_CAPACITY];
    int16_t radial_correction_mm[CALIBRATION_GRID_CAPACITY];
    int16_t bearing_correction_cdeg[CALIBRATION_GRID_CAPACITY];
    CalibrationKalmanParametersV1 kalman;
    CalibrationValidationMetricsV1 validation;
    uint32_t crc32;
} CalibrationModelV1;

/*
 * Export/CRC contract:
 * - no pointers; every array has a fixed capacity;
 * - canonical field order is the declaration order above;
 * - uint16/int16/uint32 and IEEE-754 binary32 values are serialized
 *   least-significant byte first;
 * - crc32 is excluded; exactly CALIBRATION_MODEL_V1_CRC_COVERED_SIZE bytes
 *   are covered using CRC-32/ISO-HDLC (polynomial 0xEDB88320).
 */

typedef enum {
    CALIBRATION_MODEL_OK = 0,
    CALIBRATION_MODEL_NULL_ERROR,
    CALIBRATION_MODEL_MAGIC_ERROR,
    CALIBRATION_MODEL_VERSION_ERROR,
    CALIBRATION_MODEL_SIZE_ERROR,
    CALIBRATION_MODEL_ANCHOR_ERROR,
    CALIBRATION_MODEL_RANGE_ERROR,
    CALIBRATION_MODEL_GRID_ERROR,
    CALIBRATION_MODEL_CRC_ERROR
} CalibrationModelStatus;

extern const CalibrationModelV1 g_calibration_model_v1;

uint32_t calibration_model_compute_crc(const CalibrationModelV1 *model);
void calibration_model_refresh_crc(CalibrationModelV1 *model);
CalibrationModelStatus
calibration_model_validate(const CalibrationModelV1 *model);
bool calibration_range_apply(const CalibrationRangeModelV1 *range_model,
                             float raw_distance_mm,
                             float *corrected_distance_mm);
bool calibration_model_correct_range(const CalibrationModelV1 *model,
                                     uint8_t channel, float raw_distance_mm,
                                     float *corrected_distance_mm);
bool calibration_model_lookup_compensation(
    const CalibrationModelV1 *model, float boundary_distance_mm,
    float bearing_deg, float *radial_correction_mm,
    float *bearing_correction_deg);

#endif
