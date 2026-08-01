#include "calibration_model.h"

#include <math.h>
#include <stddef.h>
#include <string.h>

_Static_assert(sizeof(CalibrationRangeModelV1) == 112U,
               "CalibrationRangeModelV1 layout changed");
_Static_assert(sizeof(float) == 4U, "CalibrationModelV1 requires float32");
_Static_assert(sizeof(CalibrationModelV1) ==
                   CALIBRATION_MODEL_V1_SERIALIZED_SIZE,
               "CalibrationModelV1 layout changed");
_Static_assert(offsetof(CalibrationModelV1, crc32) + sizeof(uint32_t) ==
                   sizeof(CalibrationModelV1),
               "CalibrationModelV1 CRC must be the final field");

static bool finite_in_range(float value, float minimum, float maximum)
{
    return isfinite(value) && (value >= minimum) && (value <= maximum);
}

static uint8_t population_count(uint8_t value)
{
    uint8_t count = 0U;

    while (value != 0U) {
        count = (uint8_t)(count + (value & 1U));
        value >>= 1U;
    }
    return count;
}

static void crc_update_byte(uint32_t *crc, uint8_t value)
{
    uint8_t bit;

    *crc ^= value;
    for (bit = 0U; bit < 8U; bit++) {
        uint32_t mask = (uint32_t)(0U - (*crc & 1U));
        *crc = (*crc >> 1U) ^ (0xEDB88320UL & mask);
    }
}

static void crc_update_u16(uint32_t *crc, uint16_t value)
{
    crc_update_byte(crc, (uint8_t)(value & 0xFFU));
    crc_update_byte(crc, (uint8_t)((value >> 8U) & 0xFFU));
}

static void crc_update_u32(uint32_t *crc, uint32_t value)
{
    crc_update_byte(crc, (uint8_t)(value & 0xFFU));
    crc_update_byte(crc, (uint8_t)((value >> 8U) & 0xFFU));
    crc_update_byte(crc, (uint8_t)((value >> 16U) & 0xFFU));
    crc_update_byte(crc, (uint8_t)((value >> 24U) & 0xFFU));
}

static void crc_update_float(uint32_t *crc, float value)
{
    uint32_t bits;

    memcpy(&bits, &value, sizeof(bits));
    crc_update_u32(crc, bits);
}

uint32_t calibration_model_compute_crc(const CalibrationModelV1 *model)
{
    uint32_t crc = 0xFFFFFFFFUL;
    uint16_t serialized_count = 0U;
    uint8_t anchor;
    uint8_t index;

    if (model == NULL) {
        return 0U;
    }

#define CRC_BYTE(value)                                                        \
    do {                                                                        \
        crc_update_byte(&crc, (uint8_t)(value));                                \
        serialized_count += 1U;                                                 \
    } while (0)
#define CRC_U16(value)                                                         \
    do {                                                                        \
        crc_update_u16(&crc, (uint16_t)(value));                                \
        serialized_count += 2U;                                                 \
    } while (0)
#define CRC_U32(value)                                                         \
    do {                                                                        \
        crc_update_u32(&crc, (uint32_t)(value));                                \
        serialized_count += 4U;                                                 \
    } while (0)
#define CRC_FLOAT(value)                                                       \
    do {                                                                        \
        crc_update_float(&crc, (value));                                        \
        serialized_count += 4U;                                                 \
    } while (0)

    CRC_U32(model->magic);
    CRC_U16(model->version);
    CRC_U16(model->model_size_bytes);
    CRC_BYTE(model->anchor_count);
    CRC_BYTE(model->enabled_anchor_mask);
    CRC_BYTE(model->distance_axis_count);
    CRC_BYTE(model->angle_axis_count);
    CRC_U32(model->flags);

    for (anchor = 0U; anchor < LOCK_UWB_CHANNEL_COUNT; anchor++) {
        CRC_FLOAT(model->anchors[anchor].x_mm);
        CRC_FLOAT(model->anchors[anchor].y_mm);
    }
    for (anchor = 0U; anchor < LOCK_UWB_CHANNEL_COUNT; anchor++) {
        const CalibrationRangeModelV1 *range =
            &model->range_models[anchor];

        CRC_BYTE(range->type);
        CRC_BYTE(range->knot_count);
        CRC_U16(range->reserved);
        for (index = 0U; index < 3U; index++) {
            CRC_FLOAT(range->coefficients[index]);
        }
        for (index = 0U; index < CALIBRATION_RANGE_KNOT_CAPACITY; index++) {
            CRC_FLOAT(range->raw_knots_mm[index]);
        }
        for (index = 0U; index < CALIBRATION_RANGE_KNOT_CAPACITY; index++) {
            CRC_FLOAT(range->corrected_knots_mm[index]);
        }
    }
    for (index = 0U; index < CALIBRATION_DISTANCE_AXIS_CAPACITY; index++) {
        CRC_U16(model->distance_axis_mm[index]);
    }
    for (index = 0U; index < CALIBRATION_ANGLE_AXIS_CAPACITY; index++) {
        CRC_U16((uint16_t)model->angle_axis_cdeg[index]);
    }
    for (index = 0U; index < CALIBRATION_GRID_CAPACITY; index++) {
        CRC_U16((uint16_t)model->radial_correction_mm[index]);
    }
    for (index = 0U; index < CALIBRATION_GRID_CAPACITY; index++) {
        CRC_U16((uint16_t)model->bearing_correction_cdeg[index]);
    }

    CRC_FLOAT(model->kalman.process_noise_position);
    CRC_FLOAT(model->kalman.process_noise_velocity);
    CRC_FLOAT(model->kalman.measurement_noise_position);
    CRC_FLOAT(model->kalman.initial_position_variance);
    CRC_FLOAT(model->kalman.initial_velocity_variance);
    CRC_FLOAT(model->kalman.max_dt_s);
    CRC_FLOAT(model->kalman.huber_delta_mm);
    CRC_FLOAT(model->kalman.nlos_threshold_mm);
    CRC_FLOAT(model->validation.distance_p95_mm);
    CRC_FLOAT(model->validation.distance_max_mm);
    CRC_FLOAT(model->validation.bearing_p95_deg);
    CRC_FLOAT(model->validation.bearing_max_deg);
    CRC_FLOAT(model->validation.boundary_p95_mm);
    CRC_FLOAT(model->validation.reserved);

#undef CRC_BYTE
#undef CRC_U16
#undef CRC_U32
#undef CRC_FLOAT

    if (serialized_count != CALIBRATION_MODEL_V1_CRC_COVERED_SIZE) {
        return 0U;
    }
    return crc ^ 0xFFFFFFFFUL;
}

void calibration_model_refresh_crc(CalibrationModelV1 *model)
{
    if (model != NULL) {
        model->crc32 = calibration_model_compute_crc(model);
    }
}

static bool range_model_is_valid(const CalibrationRangeModelV1 *range_model)
{
    uint8_t index;

    if (range_model->type == CALIBRATION_RANGE_LINEAR) {
        return isfinite(range_model->coefficients[0]) &&
               finite_in_range(range_model->coefficients[1], 0.0f, 10.0f);
    }
    if (range_model->type == CALIBRATION_RANGE_QUADRATIC) {
        return isfinite(range_model->coefficients[0]) &&
               isfinite(range_model->coefficients[1]) &&
               isfinite(range_model->coefficients[2]);
    }
    if (range_model->type != CALIBRATION_RANGE_MONOTONIC_PWL) {
        return false;
    }
    if ((range_model->knot_count < 2U) ||
        (range_model->knot_count > CALIBRATION_RANGE_KNOT_CAPACITY)) {
        return false;
    }

    for (index = 0U; index < range_model->knot_count; index++) {
        if (!isfinite(range_model->raw_knots_mm[index]) ||
            !isfinite(range_model->corrected_knots_mm[index]) ||
            (range_model->corrected_knots_mm[index] < 0.0f)) {
            return false;
        }
        if ((index > 0U) &&
            ((range_model->raw_knots_mm[index] <=
              range_model->raw_knots_mm[index - 1U]) ||
             (range_model->corrected_knots_mm[index] <
              range_model->corrected_knots_mm[index - 1U]))) {
            return false;
        }
    }
    return true;
}

static bool axes_are_valid(const CalibrationModelV1 *model)
{
    uint8_t index;

    if ((model->flags & (CALIBRATION_MODEL_FLAG_DISTANCE_GRID |
                         CALIBRATION_MODEL_FLAG_ANGLE_GRID)) == 0U) {
        return (model->distance_axis_count == 0U) &&
               (model->angle_axis_count == 0U);
    }
    if ((model->distance_axis_count < 2U) ||
        (model->distance_axis_count > CALIBRATION_DISTANCE_AXIS_CAPACITY) ||
        (model->angle_axis_count < 2U) ||
        (model->angle_axis_count > CALIBRATION_ANGLE_AXIS_CAPACITY)) {
        return false;
    }
    for (index = 1U; index < model->distance_axis_count; index++) {
        if (model->distance_axis_mm[index] <=
            model->distance_axis_mm[index - 1U]) {
            return false;
        }
    }
    for (index = 1U; index < model->angle_axis_count; index++) {
        if (model->angle_axis_cdeg[index] <=
            model->angle_axis_cdeg[index - 1U]) {
            return false;
        }
    }
    return true;
}

CalibrationModelStatus
calibration_model_validate(const CalibrationModelV1 *model)
{
    uint8_t channel;

    if (model == NULL) {
        return CALIBRATION_MODEL_NULL_ERROR;
    }
    if (model->magic != CALIBRATION_MODEL_V1_MAGIC) {
        return CALIBRATION_MODEL_MAGIC_ERROR;
    }
    if (model->version != CALIBRATION_MODEL_V1_VERSION) {
        return CALIBRATION_MODEL_VERSION_ERROR;
    }
    if (model->model_size_bytes != CALIBRATION_MODEL_V1_SERIALIZED_SIZE) {
        return CALIBRATION_MODEL_SIZE_ERROR;
    }
    if ((model->anchor_count < LOCK_UWB_MIN_CHANNEL_COUNT) ||
        (model->anchor_count > LOCK_UWB_CHANNEL_COUNT) ||
        (population_count(model->enabled_anchor_mask) != model->anchor_count)) {
        return CALIBRATION_MODEL_ANCHOR_ERROR;
    }
    for (channel = 0U; channel < LOCK_UWB_CHANNEL_COUNT; channel++) {
        if ((model->enabled_anchor_mask & (uint8_t)(1U << channel)) != 0U) {
            if (!isfinite(model->anchors[channel].x_mm) ||
                !isfinite(model->anchors[channel].y_mm)) {
                return CALIBRATION_MODEL_ANCHOR_ERROR;
            }
        }
        if (!range_model_is_valid(&model->range_models[channel])) {
            return CALIBRATION_MODEL_RANGE_ERROR;
        }
    }
    if (!axes_are_valid(model) ||
        !finite_in_range(model->kalman.process_noise_position, 0.0f,
                         1.0e9f) ||
        !finite_in_range(model->kalman.process_noise_velocity, 0.0f,
                         1.0e9f) ||
        !finite_in_range(model->kalman.measurement_noise_position, 1.0e-3f,
                         1.0e9f) ||
        !finite_in_range(model->kalman.initial_position_variance, 1.0e-3f,
                         1.0e9f) ||
        !finite_in_range(model->kalman.initial_velocity_variance, 1.0e-3f,
                         1.0e9f) ||
        !finite_in_range(model->kalman.max_dt_s, 0.001f, 10.0f) ||
        !finite_in_range(model->kalman.huber_delta_mm, 1.0f, 5000.0f) ||
        !finite_in_range(model->kalman.nlos_threshold_mm, 1.0f, 5000.0f)) {
        return CALIBRATION_MODEL_GRID_ERROR;
    }
    if (model->crc32 != calibration_model_compute_crc(model)) {
        return CALIBRATION_MODEL_CRC_ERROR;
    }
    return CALIBRATION_MODEL_OK;
}

bool calibration_range_apply(const CalibrationRangeModelV1 *range_model,
                             float raw_distance_mm,
                             float *corrected_distance_mm)
{
    float corrected;

    if ((range_model == NULL) || (corrected_distance_mm == NULL) ||
        !isfinite(raw_distance_mm) || (raw_distance_mm < 0.0f)) {
        return false;
    }

    if (range_model->type == CALIBRATION_RANGE_LINEAR) {
        corrected = range_model->coefficients[0] +
                    (range_model->coefficients[1] * raw_distance_mm);
    } else if (range_model->type == CALIBRATION_RANGE_QUADRATIC) {
        corrected =
            range_model->coefficients[0] +
            (range_model->coefficients[1] * raw_distance_mm) +
            (range_model->coefficients[2] * raw_distance_mm * raw_distance_mm);
    } else if (range_model->type == CALIBRATION_RANGE_MONOTONIC_PWL) {
        uint8_t upper = 1U;
        float fraction;

        if ((range_model->knot_count < 2U) ||
            (range_model->knot_count > CALIBRATION_RANGE_KNOT_CAPACITY)) {
            return false;
        }
        if (raw_distance_mm <= range_model->raw_knots_mm[0]) {
            corrected = range_model->corrected_knots_mm[0];
        } else if (raw_distance_mm >=
                   range_model
                       ->raw_knots_mm[range_model->knot_count - 1U]) {
            corrected =
                range_model
                    ->corrected_knots_mm[range_model->knot_count - 1U];
        } else {
            while ((upper < range_model->knot_count) &&
                   (raw_distance_mm >
                    range_model->raw_knots_mm[upper])) {
                upper++;
            }
            fraction =
                (raw_distance_mm -
                 range_model->raw_knots_mm[upper - 1U]) /
                (range_model->raw_knots_mm[upper] -
                 range_model->raw_knots_mm[upper - 1U]);
            corrected =
                range_model->corrected_knots_mm[upper - 1U] +
                fraction *
                    (range_model->corrected_knots_mm[upper] -
                     range_model->corrected_knots_mm[upper - 1U]);
        }
    } else {
        return false;
    }

    if (!isfinite(corrected)) {
        return false;
    }
    if (corrected < CALIBRATION_MIN_RANGE_MM) {
        corrected = CALIBRATION_MIN_RANGE_MM;
    } else if (corrected > CALIBRATION_MAX_RANGE_MM) {
        corrected = CALIBRATION_MAX_RANGE_MM;
    }
    *corrected_distance_mm = corrected;
    return true;
}

bool calibration_model_correct_range(const CalibrationModelV1 *model,
                                     uint8_t channel, float raw_distance_mm,
                                     float *corrected_distance_mm)
{
    if ((model == NULL) || (channel >= LOCK_UWB_CHANNEL_COUNT)) {
        return false;
    }
    return calibration_range_apply(&model->range_models[channel],
                                   raw_distance_mm, corrected_distance_mm);
}

static void axis_interval_u16(const uint16_t *axis, uint8_t count, float value,
                              uint8_t *lower, uint8_t *upper, float *fraction)
{
    uint8_t index;

    if (value <= (float)axis[0]) {
        *lower = 0U;
        *upper = 0U;
        *fraction = 0.0f;
        return;
    }
    if (value >= (float)axis[count - 1U]) {
        *lower = (uint8_t)(count - 1U);
        *upper = *lower;
        *fraction = 0.0f;
        return;
    }
    for (index = 1U; index < count; index++) {
        if (value <= (float)axis[index]) {
            *lower = (uint8_t)(index - 1U);
            *upper = index;
            *fraction =
                (value - (float)axis[*lower]) /
                ((float)axis[*upper] - (float)axis[*lower]);
            return;
        }
    }
}

static void axis_interval_i16(const int16_t *axis, uint8_t count, float value,
                              uint8_t *lower, uint8_t *upper, float *fraction)
{
    uint8_t index;

    if (value <= (float)axis[0]) {
        *lower = 0U;
        *upper = 0U;
        *fraction = 0.0f;
        return;
    }
    if (value >= (float)axis[count - 1U]) {
        *lower = (uint8_t)(count - 1U);
        *upper = *lower;
        *fraction = 0.0f;
        return;
    }
    for (index = 1U; index < count; index++) {
        if (value <= (float)axis[index]) {
            *lower = (uint8_t)(index - 1U);
            *upper = index;
            *fraction =
                (value - (float)axis[*lower]) /
                ((float)axis[*upper] - (float)axis[*lower]);
            return;
        }
    }
}

static float bilinear_i16(const int16_t *grid, uint8_t column_count,
                          uint8_t row0, uint8_t row1, uint8_t column0,
                          uint8_t column1, float row_fraction,
                          float column_fraction)
{
    uint16_t index00 = (uint16_t)row0 * column_count + column0;
    uint16_t index01 = (uint16_t)row0 * column_count + column1;
    uint16_t index10 = (uint16_t)row1 * column_count + column0;
    uint16_t index11 = (uint16_t)row1 * column_count + column1;
    float top = (float)grid[index00] +
                column_fraction *
                    ((float)grid[index01] - (float)grid[index00]);
    float bottom = (float)grid[index10] +
                   column_fraction *
                       ((float)grid[index11] - (float)grid[index10]);

    return top + row_fraction * (bottom - top);
}

bool calibration_model_lookup_compensation(
    const CalibrationModelV1 *model, float boundary_distance_mm,
    float bearing_deg, float *radial_correction_mm,
    float *bearing_correction_deg)
{
    uint8_t distance0;
    uint8_t distance1;
    uint8_t angle0;
    uint8_t angle1;
    float distance_fraction;
    float angle_fraction;

    if ((model == NULL) || (radial_correction_mm == NULL) ||
        (bearing_correction_deg == NULL) ||
        !isfinite(boundary_distance_mm) || !isfinite(bearing_deg)) {
        return false;
    }
    *radial_correction_mm = 0.0f;
    *bearing_correction_deg = 0.0f;

    if ((model->flags & (CALIBRATION_MODEL_FLAG_DISTANCE_GRID |
                         CALIBRATION_MODEL_FLAG_ANGLE_GRID)) == 0U) {
        return true;
    }
    if ((model->distance_axis_count < 2U) ||
        (model->angle_axis_count < 2U)) {
        return false;
    }

    axis_interval_u16(model->distance_axis_mm, model->distance_axis_count,
                      boundary_distance_mm, &distance0, &distance1,
                      &distance_fraction);
    axis_interval_i16(model->angle_axis_cdeg, model->angle_axis_count,
                      bearing_deg * 100.0f, &angle0, &angle1,
                      &angle_fraction);

    if ((model->flags & CALIBRATION_MODEL_FLAG_DISTANCE_GRID) != 0U) {
        *radial_correction_mm =
            bilinear_i16(model->radial_correction_mm,
                         model->angle_axis_count, distance0, distance1,
                         angle0, angle1, distance_fraction, angle_fraction);
    }
    if ((model->flags & CALIBRATION_MODEL_FLAG_ANGLE_GRID) != 0U) {
        *bearing_correction_deg =
            bilinear_i16(model->bearing_correction_cdeg,
                         model->angle_axis_count, distance0, distance1,
                         angle0, angle1, distance_fraction, angle_fraction) /
            100.0f;
    }
    return true;
}
