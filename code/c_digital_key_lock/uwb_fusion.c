#include "uwb_fusion.h"

#include <math.h>
#include <string.h>

static uint32_t elapsed_ms(uint32_t since_ms, uint32_t now_ms)
{
    return now_ms - since_ms;
}

static bool sample_is_fresh(const LockUwbMeasurement *measurement,
                            uint32_t now_ms, uint32_t window_ms)
{
    return measurement->valid &&
           (elapsed_ms(measurement->timestamp_ms, now_ms) <= window_ms);
}

static float clamp_nonnegative(float value)
{
    return (value < 0.0f) ? 0.0f : value;
}

static float wrap_bearing(float bearing_deg)
{
    while (bearing_deg > 180.0f) {
        bearing_deg -= 360.0f;
    }
    while (bearing_deg < -180.0f) {
        bearing_deg += 360.0f;
    }
    return bearing_deg;
}

static void fill_solution_metrics(LockPositionSolution *solution,
                                  const LockAppConfig *config)
{
    solution->radius_from_origin_mm =
        sqrtf((solution->x_mm * solution->x_mm) +
              (solution->y_mm * solution->y_mm));
    solution->boundary_distance_mm = clamp_nonnegative(
        solution->radius_from_origin_mm - config->radial_zero_offset_mm);
    solution->radial_mm = solution->boundary_distance_mm;
    solution->bearing_deg =
        atan2f(solution->x_mm, solution->y_mm) * (180.0f / 3.14159265358979323846f);
}

static void kalman_initialize(LockKalman2d *kalman,
                              const CalibrationKalmanParametersV1 *parameters,
                              float x_mm, float y_mm, uint32_t now_ms)
{
    memset(kalman, 0, sizeof(*kalman));
    kalman->initialized = true;
    kalman->timestamp_ms = now_ms;
    kalman->state[0] = x_mm;
    kalman->state[1] = y_mm;
    kalman->covariance[0][0] = parameters->initial_position_variance;
    kalman->covariance[1][1] = parameters->initial_position_variance;
    kalman->covariance[2][2] = parameters->initial_velocity_variance;
    kalman->covariance[3][3] = parameters->initial_velocity_variance;
}

static void kalman_update(LockKalman2d *kalman,
                          const CalibrationKalmanParametersV1 *parameters,
                          float measured_x_mm, float measured_y_mm,
                          uint32_t now_ms, LockPoint2f *filtered)
{
    float dt_s;
    float fp[4][4];
    float predicted_covariance[4][4];
    float kalman_gain[4][2];
    float updated_covariance[4][4];
    float innovation_x;
    float innovation_y;
    float s00;
    float s01;
    float s10;
    float s11;
    float determinant;
    uint8_t row;
    uint8_t column;

    if (!kalman->initialized) {
        kalman_initialize(kalman, parameters, measured_x_mm, measured_y_mm,
                          now_ms);
        filtered->x_mm = measured_x_mm;
        filtered->y_mm = measured_y_mm;
        return;
    }

    dt_s = (float)elapsed_ms(kalman->timestamp_ms, now_ms) / 1000.0f;
    if (dt_s > parameters->max_dt_s) {
        dt_s = parameters->max_dt_s;
    }
    kalman->timestamp_ms = now_ms;
    kalman->state[0] += kalman->state[2] * dt_s;
    kalman->state[1] += kalman->state[3] * dt_s;

    for (column = 0U; column < 4U; column++) {
        fp[0][column] =
            kalman->covariance[0][column] +
            dt_s * kalman->covariance[2][column];
        fp[1][column] =
            kalman->covariance[1][column] +
            dt_s * kalman->covariance[3][column];
        fp[2][column] = kalman->covariance[2][column];
        fp[3][column] = kalman->covariance[3][column];
    }
    for (row = 0U; row < 4U; row++) {
        predicted_covariance[row][0] =
            fp[row][0] + dt_s * fp[row][2];
        predicted_covariance[row][1] =
            fp[row][1] + dt_s * fp[row][3];
        predicted_covariance[row][2] = fp[row][2];
        predicted_covariance[row][3] = fp[row][3];
    }
    predicted_covariance[0][0] +=
        parameters->process_noise_position * (dt_s + 1.0e-3f);
    predicted_covariance[1][1] +=
        parameters->process_noise_position * (dt_s + 1.0e-3f);
    predicted_covariance[2][2] +=
        parameters->process_noise_velocity * (dt_s + 1.0e-3f);
    predicted_covariance[3][3] +=
        parameters->process_noise_velocity * (dt_s + 1.0e-3f);

    s00 = predicted_covariance[0][0] +
          parameters->measurement_noise_position;
    s01 = predicted_covariance[0][1];
    s10 = predicted_covariance[1][0];
    s11 = predicted_covariance[1][1] +
          parameters->measurement_noise_position;
    determinant = (s00 * s11) - (s01 * s10);
    if (fabsf(determinant) < 1.0e-6f) {
        filtered->x_mm = kalman->state[0];
        filtered->y_mm = kalman->state[1];
        return;
    }

    for (row = 0U; row < 4U; row++) {
        kalman_gain[row][0] =
            ((predicted_covariance[row][0] * s11) -
             (predicted_covariance[row][1] * s10)) /
            determinant;
        kalman_gain[row][1] =
            ((-predicted_covariance[row][0] * s01) +
             (predicted_covariance[row][1] * s00)) /
            determinant;
    }

    innovation_x = measured_x_mm - kalman->state[0];
    innovation_y = measured_y_mm - kalman->state[1];
    for (row = 0U; row < 4U; row++) {
        kalman->state[row] += kalman_gain[row][0] * innovation_x +
                              kalman_gain[row][1] * innovation_y;
    }

    for (row = 0U; row < 4U; row++) {
        for (column = 0U; column < 4U; column++) {
            updated_covariance[row][column] =
                predicted_covariance[row][column] -
                kalman_gain[row][0] * predicted_covariance[0][column] -
                kalman_gain[row][1] * predicted_covariance[1][column];
        }
    }
    memcpy(kalman->covariance, updated_covariance,
           sizeof(kalman->covariance));
    filtered->x_mm = kalman->state[0];
    filtered->y_mm = kalman->state[1];
}

static bool same_key(const LockUwbMeasurement *left,
                     const LockUwbMeasurement *right)
{
    return (left->key_addr == right->key_addr) &&
           (left->key_id == right->key_id);
}

static uint32_t filtered_distance_mm(const LockUwbChannelCache *cache)
{
    uint32_t sorted[LOCK_UWB_DISTANCE_FILTER_DEPTH];
    uint8_t index;
    uint8_t inner;

    if (cache->history_count == 0U) {
        return cache->measurement.distance_mm;
    }
    for (index = 0U; index < cache->history_count; index++) {
        sorted[index] = cache->distance_history_mm[index];
    }
    for (index = 1U; index < cache->history_count; index++) {
        uint32_t value = sorted[index];

        inner = index;
        while ((inner > 0U) && (sorted[inner - 1U] > value)) {
            sorted[inner] = sorted[inner - 1U];
            inner--;
        }
        sorted[inner] = value;
    }
    return sorted[cache->history_count / 2U];
}

void uwb_fusion_init(LockUwbFusion *fusion)
{
    uwb_fusion_init_with_model(fusion, &g_calibration_model_v1);
}

void uwb_fusion_init_with_model(LockUwbFusion *fusion,
                                const CalibrationModelV1 *model)
{
    uwb_fusion_init_with_models(fusion, model, NULL);
}

void uwb_fusion_init_with_models(LockUwbFusion *fusion,
                                 const CalibrationModelV1 *calibration_model,
                                 const EmpiricalModelV1 *empirical_model)
{
    memset(fusion, 0, sizeof(*fusion));
    fusion->calibration_model = calibration_model;
    fusion->empirical_model = empirical_model;
}

void uwb_fusion_store_measurement(LockUwbFusion *fusion, uint8_t channel,
                                  const LockUwbMeasurement *measurement)
{
    LockUwbChannelCache *cache;

    if (channel >= LOCK_UWB_CHANNEL_COUNT) {
        return;
    }

    cache = &fusion->channels[channel];
    if (measurement->valid && cache->occupied &&
        !same_key(&cache->measurement, measurement)) {
        cache->history_count = 0U;
        cache->history_next = 0U;
    }
    cache->occupied = measurement->valid;
    cache->measurement = *measurement;
    if (measurement->valid) {
        cache->distance_history_mm[cache->history_next] =
            measurement->distance_mm;
        cache->history_next =
            (uint8_t)((cache->history_next + 1U) %
                      LOCK_UWB_DISTANCE_FILTER_DEPTH);
        if (cache->history_count < LOCK_UWB_DISTANCE_FILTER_DEPTH) {
            cache->history_count++;
        }
    }
}

void uwb_fusion_solve(LockUwbFusion *fusion, const LockAppConfig *config,
                      uint32_t now_ms, LockPositionSolution *solution)
{
    const LockUwbMeasurement *identity = NULL;
    LockAnchor2d anchors[LOCK_UWB_CHANNEL_COUNT];
    float distances_mm[LOCK_UWB_CHANNEL_COUNT];
    uint32_t raw_distances_mm[LOCK_UWB_CHANNEL_COUNT];
    uint8_t source_channels[LOCK_UWB_CHANNEL_COUNT];
    LockPoint2f hint;
    uint8_t valid_mask = 0U;
    uint8_t count = 0U;
    uint8_t channel;
    TrilaterationResult result;
    uint8_t used_channel_mask = 0U;
    uint8_t rejected_channel_mask = 0U;
    LockPoint2f corrected_point;
    float raw_radius;
    float raw_boundary;
    float raw_bearing;
    float corrected_boundary;
    float corrected_bearing;
    float corrected_radius;
    EmpiricalEstimate empirical_estimate;
    bool can_hold_angle = false;
    float held_bearing = 0.0f;

    memset(solution, 0, sizeof(*solution));
    if ((fusion == NULL) || !lock_app_config_validate(config) ||
        (calibration_model_validate(fusion->calibration_model) !=
         CALIBRATION_MODEL_OK) ||
        ((fusion->empirical_model != NULL) &&
         (empirical_model_validate(fusion->empirical_model) !=
          EMPIRICAL_MODEL_OK))) {
        if (fusion != NULL) {
            fusion->last_solution.valid = false;
            fusion->kalman.initialized = false;
        }
        return;
    }

    for (channel = 0U; channel < LOCK_UWB_CHANNEL_COUNT; channel++) {
        const LockUwbChannelCache *cache = &fusion->channels[channel];

        if ((config->enabled_anchor_mask & (uint8_t)(1U << channel)) == 0U) {
            continue;
        }
        if (!cache->occupied ||
            !sample_is_fresh(&cache->measurement, now_ms,
                             config->sample_window_ms)) {
            continue;
        }
        if (identity == NULL) {
            identity = &cache->measurement;
        } else if (!same_key(identity, &cache->measurement)) {
            fusion->last_solution.valid = false;
            fusion->kalman.initialized = false;
            return;
        }
    }

    if (identity == NULL) {
        if (fusion->last_solution.valid &&
            (elapsed_ms(fusion->last_solution.updated_ms, now_ms) <=
             config->solution_hold_ms)) {
            *solution = fusion->last_solution;
            solution->valid_mask = 0U;
            solution->rejected_mask = 0U;
            solution->anchor_count = 0U;
            solution->mode = LOCK_LOCALIZATION_HOLD;
        } else {
            fusion->last_solution.valid = false;
            fusion->kalman.initialized = false;
        }
        return;
    }

    can_hold_angle =
        fusion->last_solution.valid &&
        (fusion->last_solution.key_addr == identity->key_addr) &&
        (fusion->last_solution.key_id == identity->key_id);
    if (can_hold_angle) {
        held_bearing = fusion->last_solution.bearing_deg;
    }

    for (channel = 0U; channel < LOCK_UWB_CHANNEL_COUNT; channel++) {
        const LockUwbChannelCache *cache = &fusion->channels[channel];

        float corrected_distance;
        uint32_t filtered_raw_distance;

        if ((config->enabled_anchor_mask & (uint8_t)(1U << channel)) == 0U) {
            continue;
        }
        if (!cache->occupied ||
            !sample_is_fresh(&cache->measurement, now_ms,
                             config->sample_window_ms)) {
            continue;
        }
        filtered_raw_distance = filtered_distance_mm(cache);
        if (!same_key(identity, &cache->measurement) ||
            !calibration_model_correct_range(
                fusion->calibration_model, channel,
                (float)filtered_raw_distance,
                &corrected_distance)) {
            fusion->last_solution.valid = false;
            fusion->kalman.initialized = false;
            return;
        }

        anchors[count] = config->anchors[channel];
        raw_distances_mm[count] = filtered_raw_distance;
        distances_mm[count] = corrected_distance;
        source_channels[count] = channel;
        valid_mask |= (uint8_t)(1U << channel);
        count++;
    }

    if (count < 2U) {
        if (fusion->last_solution.valid &&
            (identity->key_addr == fusion->last_solution.key_addr) &&
            (identity->key_id == fusion->last_solution.key_id) &&
            (elapsed_ms(fusion->last_solution.updated_ms, now_ms) <=
             config->solution_hold_ms)) {
            *solution = fusion->last_solution;
            solution->valid_mask = valid_mask;
            solution->rejected_mask = 0U;
            solution->anchor_count = count;
            solution->mode = LOCK_LOCALIZATION_HOLD;
        }
        return;
    }

    if (fusion->last_solution.valid &&
        (fusion->last_solution.key_addr == identity->key_addr) &&
        (fusion->last_solution.key_id == identity->key_id) &&
        fusion->has_solve_time &&
        (elapsed_ms(fusion->last_solve_ms, now_ms) <
         config->solution_update_interval_ms)) {
        *solution = fusion->last_solution;
        solution->valid_mask = valid_mask;
        solution->rejected_mask = 0U;
        solution->anchor_count = count;
        solution->mode = LOCK_LOCALIZATION_HOLD;
        return;
    }
    fusion->has_solve_time = true;
    fusion->last_solve_ms = now_ms;

    if ((count == 2U) && (source_channels[0] == 0U) &&
        (source_channels[1] == 1U) &&
        (fusion->empirical_model != NULL) &&
        (raw_distances_mm[0] <= UINT16_MAX) &&
        (raw_distances_mm[1] <= UINT16_MAX) &&
        empirical_model_predict(
            fusion->empirical_model,
            (uint16_t)raw_distances_mm[0],
            (uint16_t)raw_distances_mm[1],
            &empirical_estimate)) {
        corrected_radius =
            empirical_estimate.distance_mm + config->radial_zero_offset_mm;
        corrected_bearing = empirical_estimate.angle_valid
                                ? wrap_bearing(empirical_estimate.bearing_deg)
                                : can_hold_angle
                                      ? held_bearing
                                      : 0.0f;
        corrected_point.x_mm =
            corrected_radius *
            sinf(corrected_bearing *
                  (3.14159265358979323846f / 180.0f));
        corrected_point.y_mm =
            corrected_radius *
            cosf(corrected_bearing *
                  (3.14159265358979323846f / 180.0f));
        if (empirical_estimate.angle_valid) {
            kalman_update(&fusion->kalman,
                          &fusion->calibration_model->kalman,
                          corrected_point.x_mm, corrected_point.y_mm, now_ms,
                          &corrected_point);
        } else {
            fusion->kalman.initialized = false;
        }

        solution->valid = true;
        /*
         * Two-anchor angle remains display-only until independent validation
         * passes. A newly predicted angle may be shown, and an ambiguous
         * prediction keeps the previous displayed angle, but neither case is
         * accepted by the lock state machine.
         */
        solution->angle_valid = false;
        solution->angle_held =
            !empirical_estimate.angle_valid && can_hold_angle;
        solution->key_addr = identity->key_addr;
        solution->key_id = identity->key_id;
        solution->valid_mask = valid_mask;
        solution->anchor_count = 2U;
        solution->updated_ms = now_ms;
        solution->raw_x_mm =
            corrected_radius *
            sinf(corrected_bearing *
                  (3.14159265358979323846f / 180.0f));
        solution->raw_y_mm =
            corrected_radius *
            cosf(corrected_bearing *
                  (3.14159265358979323846f / 180.0f));
        solution->x_mm = corrected_point.x_mm;
        solution->y_mm = corrected_point.y_mm;
        solution->distance_confidence =
            empirical_estimate.distance_confidence;
        solution->angle_confidence = empirical_estimate.angle_confidence;
        solution->mode = LOCK_LOCALIZATION_TWO_ANCHOR;
        fill_solution_metrics(solution, config);
        fusion->last_solution = *solution;
        return;
    }

    if (fusion->last_solution.valid &&
        (fusion->last_solution.key_addr == identity->key_addr) &&
        (fusion->last_solution.key_id == identity->key_id)) {
        hint.x_mm = fusion->last_solution.raw_x_mm;
        hint.y_mm = fusion->last_solution.raw_y_mm;
    } else {
        hint.x_mm = 0.0f;
        hint.y_mm = config->radial_zero_offset_mm + config->welcome_radius_mm;
    }
    if (!trilateration_solve_robust(
            anchors, distances_mm, count, &hint,
            config->nlos_residual_threshold_mm, &result)) {
        return;
    }

    for (channel = 0U; channel < count; channel++) {
        uint8_t source_bit = (uint8_t)(1U << source_channels[channel]);

        if ((result.used_mask & (uint8_t)(1U << channel)) != 0U) {
            used_channel_mask |= source_bit;
        }
        if ((result.rejected_mask & (uint8_t)(1U << channel)) != 0U) {
            rejected_channel_mask |= source_bit;
        }
    }

    solution->valid = true;
    solution->angle_valid = result.used_count >= 3U;
    solution->angle_held = false;
    solution->key_addr = identity->key_addr;
    solution->key_id = identity->key_id;
    solution->valid_mask = used_channel_mask;
    solution->rejected_mask = rejected_channel_mask;
    solution->anchor_count = result.used_count;
    solution->updated_ms = now_ms;
    solution->raw_x_mm = result.point.x_mm;
    solution->raw_y_mm = result.point.y_mm;
    solution->residual_mm = result.residual_mm;
    solution->solver_iterations = result.iterations;
    solution->distance_confidence =
        1.0f / (1.0f + result.residual_mm /
                           config->nlos_residual_threshold_mm);
    solution->angle_confidence = solution->distance_confidence;

    raw_radius = sqrtf((result.point.x_mm * result.point.x_mm) +
                       (result.point.y_mm * result.point.y_mm));
    raw_boundary =
        clamp_nonnegative(raw_radius - config->radial_zero_offset_mm);
    raw_bearing =
        atan2f(result.point.x_mm, result.point.y_mm) *
        (180.0f / 3.14159265358979323846f);
    if (!calibration_model_lookup_compensation(
            fusion->calibration_model, raw_boundary, raw_bearing,
            &solution->radial_correction_mm,
            &solution->bearing_correction_deg)) {
        memset(solution, 0, sizeof(*solution));
        fusion->last_solution.valid = false;
        fusion->kalman.initialized = false;
        return;
    }
    corrected_boundary =
        clamp_nonnegative(raw_boundary + solution->radial_correction_mm);
    corrected_bearing =
        wrap_bearing(raw_bearing + solution->bearing_correction_deg);
    corrected_radius =
        corrected_boundary + config->radial_zero_offset_mm;
    if (!solution->angle_valid && can_hold_angle) {
        corrected_bearing = held_bearing;
        solution->angle_held = true;
    }
    corrected_point.x_mm =
        corrected_radius *
        sinf(corrected_bearing * (3.14159265358979323846f / 180.0f));
    corrected_point.y_mm =
        corrected_radius *
        cosf(corrected_bearing * (3.14159265358979323846f / 180.0f));
    if (solution->angle_valid) {
        kalman_update(&fusion->kalman, &fusion->calibration_model->kalman,
                      corrected_point.x_mm, corrected_point.y_mm, now_ms,
                      &corrected_point);
    } else {
        fusion->kalman.initialized = false;
    }
    solution->x_mm = corrected_point.x_mm;
    solution->y_mm = corrected_point.y_mm;
    fill_solution_metrics(solution, config);

    if (solution->anchor_count >= 4U) {
        solution->mode = LOCK_LOCALIZATION_FOUR_ANCHOR;
    } else if (solution->anchor_count == 3U) {
        solution->mode = LOCK_LOCALIZATION_THREE_ANCHOR;
    } else {
        solution->mode = LOCK_LOCALIZATION_TWO_ANCHOR;
    }
    fusion->last_solution = *solution;
}
