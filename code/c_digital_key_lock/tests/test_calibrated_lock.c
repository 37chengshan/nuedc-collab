#include "calibration_model.h"
#include "empirical_model.h"
#include "empirical_model_data.h"
#include "lock_app.h"
#include "lock_app_config.h"
#include "lock_fsm.h"
#include "trilateration.h"
#include "uwb_fusion.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static unsigned int g_assertions;

#define TEST_ASSERT(condition)                                                  \
    do {                                                                        \
        g_assertions++;                                                         \
        if (!(condition)) {                                                     \
            fprintf(stderr, "%s:%d: assertion failed: %s\n", __FILE__,        \
                    __LINE__, #condition);                                     \
            return false;                                                       \
        }                                                                       \
    } while (0)

#define TEST_ASSERT_NEAR(actual, expected, tolerance)                           \
    do {                                                                        \
        float test_actual_ = (actual);                                          \
        float test_expected_ = (expected);                                      \
        float test_tolerance_ = (tolerance);                                    \
        g_assertions++;                                                         \
        if (fabsf(test_actual_ - test_expected_) > test_tolerance_) {          \
            fprintf(stderr,                                                     \
                    "%s:%d: expected %.3f +/- %.3f, got %.3f\n", __FILE__,    \
                    __LINE__, test_expected_, test_tolerance_, test_actual_); \
            return false;                                                       \
        }                                                                       \
    } while (0)

static float point_distance(LockAnchor2d anchor, float x_mm, float y_mm)
{
    float dx = x_mm - anchor.x_mm;
    float dy = y_mm - anchor.y_mm;

    return sqrtf((dx * dx) + (dy * dy));
}

static LockUwbMeasurement measurement(uint8_t key_id, uint32_t distance_mm,
                                      uint32_t timestamp_ms)
{
    LockUwbMeasurement value;

    memset(&value, 0, sizeof(value));
    value.valid = true;
    value.key_addr = key_id;
    value.key_id = key_id;
    value.distance_mm = distance_mm;
    value.timestamp_ms = timestamp_ms;
    return value;
}

static void store_position(LockUwbFusion *fusion, const LockAppConfig *config,
                           uint8_t key_id, float x_mm, float y_mm,
                           uint32_t timestamp_ms)
{
    uint8_t channel;

    for (channel = 0U; channel < config->anchor_count; channel++) {
        LockUwbMeasurement item =
            measurement(key_id,
                        (uint32_t)lroundf(point_distance(
                            config->anchors[channel], x_mm, y_mm)),
                        timestamp_ms);
        uwb_fusion_store_measurement(fusion, channel, &item);
    }
}

static bool test_default_two_anchor_configuration(void)
{
    TEST_ASSERT(LOCK_UWB_CHANNEL_COUNT == 4U);
    TEST_ASSERT(g_lock_app_default_config.anchor_count == 2U);
    TEST_ASSERT(g_lock_app_default_config.enabled_anchor_mask == 0x03U);
    TEST_ASSERT_NEAR(g_lock_app_default_config.anchors[0].x_mm, -125.0f, 0.01f);
    TEST_ASSERT_NEAR(g_lock_app_default_config.anchors[0].y_mm, 40.0f, 0.01f);
    TEST_ASSERT_NEAR(g_lock_app_default_config.anchors[1].x_mm, 125.0f, 0.01f);
    TEST_ASSERT_NEAR(g_lock_app_default_config.anchors[1].y_mm, 40.0f, 0.01f);
    TEST_ASSERT_NEAR(g_lock_app_default_config.radial_zero_offset_mm, 300.0f,
                     0.01f);
    TEST_ASSERT(g_lock_app_default_config.solution_update_interval_ms == 500U);
    return true;
}

static bool test_model_crc_and_range_models(void)
{
    CalibrationModelV1 copy = g_calibration_model_v1;
    CalibrationRangeModelV1 range;
    float corrected;

    TEST_ASSERT(calibration_model_validate(&g_calibration_model_v1) ==
                CALIBRATION_MODEL_OK);
    copy.crc32 ^= 0x01020304UL;
    TEST_ASSERT(calibration_model_validate(&copy) ==
                CALIBRATION_MODEL_CRC_ERROR);

    memset(&range, 0, sizeof(range));
    range.type = CALIBRATION_RANGE_LINEAR;
    range.coefficients[0] = 10.0f;
    range.coefficients[1] = 1.10f;
    TEST_ASSERT(calibration_range_apply(&range, 1000.0f, &corrected));
    TEST_ASSERT_NEAR(corrected, 1110.0f, 0.01f);

    range.type = CALIBRATION_RANGE_QUADRATIC;
    range.coefficients[0] = 0.0f;
    range.coefficients[1] = 1.0f;
    range.coefficients[2] = 0.0001f;
    TEST_ASSERT(calibration_range_apply(&range, 1000.0f, &corrected));
    TEST_ASSERT_NEAR(corrected, 1100.0f, 0.01f);

    memset(&range, 0, sizeof(range));
    range.type = CALIBRATION_RANGE_MONOTONIC_PWL;
    range.knot_count = 3U;
    range.raw_knots_mm[0] = 500.0f;
    range.raw_knots_mm[1] = 1000.0f;
    range.raw_knots_mm[2] = 1500.0f;
    range.corrected_knots_mm[0] = 550.0f;
    range.corrected_knots_mm[1] = 1050.0f;
    range.corrected_knots_mm[2] = 1600.0f;
    TEST_ASSERT(calibration_range_apply(&range, 1250.0f, &corrected));
    TEST_ASSERT_NEAR(corrected, 1325.0f, 0.01f);
    return true;
}

static bool test_empirical_model_distance_angle_and_crc(void)
{
    static const EmpiricalPrototypeV1 prototypes[] = {
        {700U, 620U, 1000U, -1000, EMPIRICAL_PROTOTYPE_ANGLE_VALID, 0U},
        {720U, 600U, 1000U, 0, EMPIRICAL_PROTOTYPE_ANGLE_VALID, 0U},
        {740U, 580U, 1000U, 1000, EMPIRICAL_PROTOTYPE_ANGLE_VALID, 0U},
        {1680U, 1600U, 2000U, -1000, EMPIRICAL_PROTOTYPE_ANGLE_VALID, 0U},
        {1700U, 1580U, 2000U, 0, EMPIRICAL_PROTOTYPE_ANGLE_VALID, 0U},
        {1720U, 1560U, 2000U, 1000, EMPIRICAL_PROTOTYPE_ANGLE_VALID, 0U},
    };
    EmpiricalModelV1 model = {
        .magic = EMPIRICAL_MODEL_V1_MAGIC,
        .version = EMPIRICAL_MODEL_V1_VERSION,
        .prototype_count =
            (uint16_t)(sizeof(prototypes) / sizeof(prototypes[0])),
        .distance_neighbor_count = 4U,
        .angle_neighbor_count = 2U,
        .distance1_scale_mm = 600.0f,
        .distance2_scale_mm = 600.0f,
        .angle_max_neighbor_distance = 0.5f,
        .angle_max_spread_deg = 20.0f,
        .prototypes = prototypes,
    };
    EmpiricalEstimate estimate;

    empirical_model_refresh_crc(&model);
    TEST_ASSERT(empirical_model_validate(&model) == EMPIRICAL_MODEL_OK);
    TEST_ASSERT(empirical_model_predict(&model, 740U, 580U, &estimate));
    TEST_ASSERT(estimate.valid);
    TEST_ASSERT_NEAR(estimate.distance_mm, 1000.0f, 0.1f);
    TEST_ASSERT(estimate.angle_valid);
    TEST_ASSERT_NEAR(estimate.bearing_deg, 10.0f, 0.1f);

    TEST_ASSERT(empirical_model_predict(&model, 1710U, 1570U, &estimate));
    TEST_ASSERT_NEAR(estimate.distance_mm, 2000.0f, 30.0f);
    TEST_ASSERT(estimate.angle_valid);

    model.crc32 ^= 0x00000001UL;
    TEST_ASSERT(empirical_model_validate(&model) == EMPIRICAL_MODEL_CRC_ERROR);
    TEST_ASSERT(!empirical_model_predict(&model, 740U, 580U, &estimate));
    return true;
}

static bool test_empirical_model_rejects_ambiguous_angle(void)
{
    static const EmpiricalPrototypeV1 prototypes[] = {
        {1000U, 900U, 1500U, -4500, EMPIRICAL_PROTOTYPE_ANGLE_VALID, 0U},
        {1002U, 902U, 1500U, 4500, EMPIRICAL_PROTOTYPE_ANGLE_VALID, 0U},
        {900U, 800U, 1400U, 0, EMPIRICAL_PROTOTYPE_ANGLE_VALID, 0U},
        {1100U, 1000U, 1600U, 0, EMPIRICAL_PROTOTYPE_ANGLE_VALID, 0U},
    };
    EmpiricalModelV1 model = {
        .magic = EMPIRICAL_MODEL_V1_MAGIC,
        .version = EMPIRICAL_MODEL_V1_VERSION,
        .prototype_count =
            (uint16_t)(sizeof(prototypes) / sizeof(prototypes[0])),
        .distance_neighbor_count = 4U,
        .angle_neighbor_count = 2U,
        .distance1_scale_mm = 500.0f,
        .distance2_scale_mm = 500.0f,
        .angle_max_neighbor_distance = 0.5f,
        .angle_max_spread_deg = 20.0f,
        .prototypes = prototypes,
    };
    EmpiricalEstimate estimate;

    empirical_model_refresh_crc(&model);
    TEST_ASSERT(empirical_model_predict(&model, 1001U, 901U, &estimate));
    TEST_ASSERT(estimate.valid);
    TEST_ASSERT_NEAR(estimate.distance_mm, 1500.0f, 0.1f);
    TEST_ASSERT(!estimate.angle_valid);
    return true;
}

static bool test_exported_empirical_model_contains_all_training_points(void)
{
    TEST_ASSERT(g_empirical_model_v1.prototype_count == 68U);
    TEST_ASSERT(g_empirical_model_v1.distance_neighbor_count == 6U);
    TEST_ASSERT(g_empirical_model_v1.angle_neighbor_count == 4U);
    TEST_ASSERT(empirical_model_validate(&g_empirical_model_v1) ==
                EMPIRICAL_MODEL_OK);
    return true;
}

static bool test_two_anchor_fusion_uses_empirical_distance_only(void)
{
    LockAppConfig config = g_lock_app_default_config;
    LockUwbFusion fusion;
    LockPositionSolution solution;
    LockUwbMeasurement first = measurement(3U, 740U, 100U);
    LockUwbMeasurement second = measurement(3U, 580U, 100U);

    first.key_addr = 0x0100U;
    second.key_addr = 0x0100U;
    uwb_fusion_init_with_models(
        &fusion, &g_calibration_model_v1, &g_empirical_model_v1);
    uwb_fusion_store_measurement(&fusion, 0U, &first);
    uwb_fusion_store_measurement(&fusion, 1U, &second);
    uwb_fusion_solve(&fusion, &config, 100U, &solution);

    TEST_ASSERT(solution.valid);
    TEST_ASSERT(!solution.angle_valid);
    TEST_ASSERT(!solution.angle_held);
    TEST_ASSERT(solution.mode == LOCK_LOCALIZATION_TWO_ANCHOR);
    TEST_ASSERT(solution.valid_mask == 0x03U);
    TEST_ASSERT_NEAR(solution.boundary_distance_mm, 1000.0f, 1.0f);
    TEST_ASSERT_NEAR(solution.bearing_deg, 30.0f, 1.0f);
    return true;
}

static bool test_two_anchor_fusion_marks_ambiguous_angle_invalid(void)
{
    static const EmpiricalPrototypeV1 prototypes[] = {
        {1000U, 900U, 900U, -4500, EMPIRICAL_PROTOTYPE_ANGLE_VALID, 0U},
        {1002U, 902U, 900U, 4500, EMPIRICAL_PROTOTYPE_ANGLE_VALID, 0U},
        {900U, 800U, 800U, 1200, EMPIRICAL_PROTOTYPE_ANGLE_VALID, 0U},
        {1100U, 1000U, 1000U, 0, EMPIRICAL_PROTOTYPE_ANGLE_VALID, 0U},
    };
    EmpiricalModelV1 model = {
        .magic = EMPIRICAL_MODEL_V1_MAGIC,
        .version = EMPIRICAL_MODEL_V1_VERSION,
        .prototype_count =
            (uint16_t)(sizeof(prototypes) / sizeof(prototypes[0])),
        .distance_neighbor_count = 4U,
        .angle_neighbor_count = 2U,
        .distance1_scale_mm = 500.0f,
        .distance2_scale_mm = 500.0f,
        .angle_max_neighbor_distance = 0.5f,
        .angle_max_spread_deg = 20.0f,
        .prototypes = prototypes,
    };
    LockAppConfig config = g_lock_app_default_config;
    LockUwbFusion fusion;
    LockPositionSolution solution;
    LockUwbMeasurement first = measurement(3U, 1001U, 500U);
    LockUwbMeasurement second = measurement(3U, 901U, 500U);
    LockUwbMeasurement trusted_first = measurement(3U, 900U, 0U);
    LockUwbMeasurement trusted_second = measurement(3U, 800U, 0U);

    first.key_addr = 0x0100U;
    second.key_addr = 0x0100U;
    trusted_first.key_addr = 0x0100U;
    trusted_second.key_addr = 0x0100U;
    empirical_model_refresh_crc(&model);
    uwb_fusion_init_with_models(&fusion, &g_calibration_model_v1, &model);
    uwb_fusion_store_measurement(&fusion, 0U, &trusted_first);
    uwb_fusion_store_measurement(&fusion, 1U, &trusted_second);
    uwb_fusion_solve(&fusion, &config, 0U, &solution);
    TEST_ASSERT(!solution.angle_valid);
    TEST_ASSERT(!solution.angle_held);
    TEST_ASSERT_NEAR(solution.bearing_deg, 12.0f, 0.1f);

    uwb_fusion_store_measurement(&fusion, 0U, &first);
    uwb_fusion_store_measurement(&fusion, 1U, &second);
    uwb_fusion_solve(&fusion, &config,
                     config.solution_update_interval_ms, &solution);

    TEST_ASSERT(solution.valid);
    TEST_ASSERT(!solution.angle_valid);
    TEST_ASSERT(solution.angle_held);
    TEST_ASSERT_NEAR(solution.bearing_deg, 12.0f, 0.1f);
    TEST_ASSERT_NEAR(solution.boundary_distance_mm, 825.0f, 1.0f);
    return true;
}

static bool test_fusion_holds_output_between_stable_update_ticks(void)
{
    LockAppConfig config = g_lock_app_default_config;
    LockUwbFusion fusion;
    LockPositionSolution first_solution;
    LockPositionSolution held_solution;
    LockUwbMeasurement first = measurement(3U, 740U, 100U);
    LockUwbMeasurement second = measurement(3U, 580U, 100U);
    LockUwbMeasurement changed_first = measurement(3U, 780U, 200U);
    LockUwbMeasurement changed_second = measurement(3U, 550U, 200U);

    first.key_addr = 0x0100U;
    second.key_addr = 0x0100U;
    changed_first.key_addr = 0x0100U;
    changed_second.key_addr = 0x0100U;
    uwb_fusion_init_with_models(
        &fusion, &g_calibration_model_v1, &g_empirical_model_v1);
    uwb_fusion_store_measurement(&fusion, 0U, &first);
    uwb_fusion_store_measurement(&fusion, 1U, &second);
    uwb_fusion_solve(&fusion, &config, 100U, &first_solution);
    uwb_fusion_store_measurement(&fusion, 0U, &changed_first);
    uwb_fusion_store_measurement(&fusion, 1U, &changed_second);
    uwb_fusion_solve(&fusion, &config, 200U, &held_solution);

    TEST_ASSERT(held_solution.valid);
    TEST_ASSERT(held_solution.mode == LOCK_LOCALIZATION_HOLD);
    TEST_ASSERT_NEAR(held_solution.boundary_distance_mm,
                     first_solution.boundary_distance_mm, 0.01f);
    TEST_ASSERT_NEAR(held_solution.bearing_deg, first_solution.bearing_deg,
                     0.01f);
    return true;
}

static bool test_bilinear_distance_and_angle_compensation(void)
{
    CalibrationModelV1 model = g_calibration_model_v1;
    float radial_correction_mm;
    float bearing_correction_deg;

    model.flags = CALIBRATION_MODEL_FLAG_DISTANCE_GRID |
                  CALIBRATION_MODEL_FLAG_ANGLE_GRID;
    model.distance_axis_count = 2U;
    model.angle_axis_count = 2U;
    model.distance_axis_mm[0] = 500.0f;
    model.distance_axis_mm[1] = 1500.0f;
    model.angle_axis_cdeg[0] = -4500;
    model.angle_axis_cdeg[1] = 4500;
    model.radial_correction_mm[0] = 0;
    model.radial_correction_mm[1] = 100;
    model.radial_correction_mm[2] = 200;
    model.radial_correction_mm[3] = 300;
    model.bearing_correction_cdeg[0] = 0;
    model.bearing_correction_cdeg[1] = 1000;
    model.bearing_correction_cdeg[2] = 2000;
    model.bearing_correction_cdeg[3] = 3000;
    calibration_model_refresh_crc(&model);

    TEST_ASSERT(calibration_model_validate(&model) == CALIBRATION_MODEL_OK);
    TEST_ASSERT(calibration_model_lookup_compensation(
        &model, 1000.0f, 0.0f, &radial_correction_mm,
        &bearing_correction_deg));
    TEST_ASSERT_NEAR(radial_correction_mm, 150.0f, 0.01f);
    TEST_ASSERT_NEAR(bearing_correction_deg, 15.0f, 0.01f);
    return true;
}

static bool test_two_anchor_front_mirror_resolution(void)
{
    LockAnchor2d anchors[2] = {
        {-125.0f, 40.0f},
        {125.0f, 40.0f},
    };
    float distances_mm[2];
    LockPoint2f back_hint = {0.0f, -1200.0f};
    TrilaterationResult result;

    distances_mm[0] = point_distance(anchors[0], 180.0f, 1300.0f);
    distances_mm[1] = point_distance(anchors[1], 180.0f, 1300.0f);
    TEST_ASSERT(trilateration_solve_robust(
        anchors, distances_mm, 2U, &back_hint, 180.0f, &result));
    TEST_ASSERT(result.valid);
    TEST_ASSERT(result.used_count == 2U);
    TEST_ASSERT(result.point.y_mm > 0.0f);
    TEST_ASSERT_NEAR(result.point.x_mm, 180.0f, 2.0f);
    TEST_ASSERT_NEAR(result.point.y_mm, 1300.0f, 2.0f);
    return true;
}

static bool test_three_anchor_nlos_degrades_to_reliable_pair(void)
{
    LockAnchor2d anchors[3] = {
        {-500.0f, 0.0f},
        {500.0f, 0.0f},
        {0.0f, 2100.0f},
    };
    float distances_mm[3];
    LockPoint2f hint = {120.0f, 1100.0f};
    TrilaterationResult result;
    uint8_t i;

    for (i = 0U; i < 3U; i++) {
        distances_mm[i] = point_distance(anchors[i], hint.x_mm, hint.y_mm);
    }
    distances_mm[2] += 700.0f;

    TEST_ASSERT(trilateration_solve_robust(
        anchors, distances_mm, 3U, &hint, 180.0f, &result));
    TEST_ASSERT(result.used_count == 2U);
    TEST_ASSERT(result.rejected_mask == 0x04U);
    TEST_ASSERT_NEAR(result.point.x_mm, hint.x_mm, 20.0f);
    TEST_ASSERT_NEAR(result.point.y_mm, hint.y_mm, 20.0f);
    return true;
}

static bool test_four_anchor_single_nlos_rejection(void)
{
    LockAnchor2d anchors[4] = {
        {-600.0f, 0.0f},
        {600.0f, 0.0f},
        {-600.0f, 2100.0f},
        {600.0f, 2100.0f},
    };
    float distances_mm[4];
    LockPoint2f point = {100.0f, 1000.0f};
    TrilaterationResult result;
    uint8_t i;

    for (i = 0U; i < 4U; i++) {
        distances_mm[i] =
            point_distance(anchors[i], point.x_mm, point.y_mm);
    }
    distances_mm[3] += 650.0f;

    TEST_ASSERT(trilateration_solve_robust(
        anchors, distances_mm, 4U, &point, 180.0f, &result));
    TEST_ASSERT(result.used_count == 3U);
    TEST_ASSERT(result.rejected_mask == 0x08U);
    TEST_ASSERT_NEAR(result.point.x_mm, point.x_mm, 25.0f);
    TEST_ASSERT_NEAR(result.point.y_mm, point.y_mm, 25.0f);
    TEST_ASSERT(result.iterations <= 5U);
    return true;
}

static bool test_boundary_distance_bearing_and_dropout(void)
{
    LockAppConfig config = g_lock_app_default_config;
    LockUwbFusion fusion;
    LockPositionSolution solution;

    config.anchor_count = 3U;
    config.enabled_anchor_mask = 0x07U;
    config.anchors[2].x_mm = 0.0f;
    config.anchors[2].y_mm = -100.0f;

    uwb_fusion_init(&fusion);
    store_position(&fusion, &config, 3U, 0.0f, 1300.0f, 100U);
    uwb_fusion_solve(&fusion, &config, 100U, &solution);
    TEST_ASSERT(solution.valid);
    TEST_ASSERT_NEAR(solution.radius_from_origin_mm, 1300.0f, 2.0f);
    TEST_ASSERT_NEAR(solution.boundary_distance_mm, 1000.0f, 2.0f);
    TEST_ASSERT_NEAR(solution.bearing_deg, 0.0f, 0.2f);

    uwb_fusion_init(&fusion);
    store_position(&fusion, &config, 3U, 1300.0f, 1300.0f, 200U);
    uwb_fusion_solve(&fusion, &config, 200U, &solution);
    TEST_ASSERT_NEAR(solution.bearing_deg, 45.0f, 6.0f);

    uwb_fusion_init(&fusion);
    store_position(&fusion, &config, 3U, -1300.0f, 1300.0f, 300U);
    uwb_fusion_solve(&fusion, &config, 300U, &solution);
    TEST_ASSERT_NEAR(solution.bearing_deg, -45.0f, 6.0f);

    uwb_fusion_init(&fusion);
    store_position(&fusion, &config, 3U, 0.0f, 200.0f, 400U);
    uwb_fusion_solve(&fusion, &config, 400U, &solution);
    TEST_ASSERT_NEAR(solution.boundary_distance_mm, 0.0f, 0.01f);

    uwb_fusion_init(&fusion);
    store_position(&fusion, &config, 3U, 0.0f, 1300.0f, 500U);
    uwb_fusion_solve(&fusion, &config, 500U, &solution);
    TEST_ASSERT(solution.valid);
    uwb_fusion_solve(&fusion, &config,
                     500U + config.sample_window_ms + 1U, &solution);
    TEST_ASSERT(solution.valid);
    TEST_ASSERT(solution.mode == LOCK_LOCALIZATION_HOLD);
    uwb_fusion_solve(&fusion, &config,
                     500U + config.solution_hold_ms + 1U, &solution);
    TEST_ASSERT(!solution.valid);
    return true;
}

static bool test_fusion_rejects_mixed_key_addresses(void)
{
    LockAppConfig config = g_lock_app_default_config;
    LockUwbFusion fusion;
    LockPositionSolution solution;
    LockUwbMeasurement first;
    LockUwbMeasurement second;

    uwb_fusion_init(&fusion);
    first = measurement(
        0U, (uint32_t)lroundf(point_distance(config.anchors[0], 0.0f, 1300.0f)),
        100U);
    second = measurement(
        0U, (uint32_t)lroundf(point_distance(config.anchors[1], 0.0f, 1300.0f)),
        100U);
    first.key_addr = 0x0100U;
    second.key_addr = 0x0200U;
    uwb_fusion_store_measurement(&fusion, 0U, &first);
    uwb_fusion_store_measurement(&fusion, 1U, &second);
    uwb_fusion_solve(&fusion, &config, 100U, &solution);
    TEST_ASSERT(!solution.valid);
    return true;
}

static LockPositionSolution position(uint8_t key_id, bool valid,
                                     float boundary_distance_mm,
                                     float bearing_deg,
                                     LockLocalizationMode mode,
                                     uint8_t anchor_count)
{
    LockPositionSolution value;

    memset(&value, 0, sizeof(value));
    value.valid = valid;
    value.key_id = key_id;
    value.boundary_distance_mm = boundary_distance_mm;
    value.radial_mm = boundary_distance_mm;
    value.bearing_deg = bearing_deg;
    value.angle_valid = true;
    value.mode = mode;
    value.anchor_count = anchor_count;
    return value;
}

static bool test_two_anchor_distance_unlocks_without_using_angle(void)
{
    LockAppConfig config = g_lock_app_default_config;
    LockStateMachine fsm;
    LockOutputSnapshot output;
    LockPositionSolution two_anchor =
        position(3U, true, 900.0f, 0.0f, LOCK_LOCALIZATION_TWO_ANCHOR, 2U);

    two_anchor.angle_valid = false;
    lock_fsm_init(&fsm);
    output = lock_fsm_update(&fsm, &two_anchor, 3U, &config, 10U);
    output = lock_fsm_update(&fsm, &two_anchor, 3U, &config, 20U);
    output = lock_fsm_update(&fsm, &two_anchor, 3U, &config, 30U);

    TEST_ASSERT(output.zone == LOCK_ZONE_UNLOCK);
    TEST_ASSERT(output.state == LOCK_STATE_UNLOCKED);
    TEST_ASSERT(output.unlock_output);

    two_anchor.mode = LOCK_LOCALIZATION_THREE_ANCHOR;
    two_anchor.anchor_count = 3U;
    lock_fsm_init(&fsm);
    output = lock_fsm_update(&fsm, &two_anchor, 3U, &config, 40U);
    output = lock_fsm_update(&fsm, &two_anchor, 3U, &config, 50U);
    output = lock_fsm_update(&fsm, &two_anchor, 3U, &config, 60U);
    TEST_ASSERT(output.zone == LOCK_ZONE_INVALID);
    TEST_ASSERT(output.state == LOCK_STATE_LOCKED);
    TEST_ASSERT(!output.unlock_output);
    return true;
}

static bool test_three_frame_hysteresis_and_immediate_safety(void)
{
    LockAppConfig config = g_lock_app_default_config;
    LockStateMachine fsm;
    LockOutputSnapshot output;
    LockPositionSolution unlock =
        position(3U, true, 990.0f, 0.0f, LOCK_LOCALIZATION_THREE_ANCHOR, 3U);
    LockPositionSolution unlock_hysteresis =
        position(3U, true, 1020.0f, 0.0f, LOCK_LOCALIZATION_THREE_ANCHOR, 3U);
    LockPositionSolution welcome =
        position(3U, true, 1060.0f, 0.0f, LOCK_LOCALIZATION_THREE_ANCHOR, 3U);
    LockPositionSolution outside =
        position(3U, true, 2060.0f, 0.0f, LOCK_LOCALIZATION_THREE_ANCHOR, 3U);
    LockPositionSolution held =
        position(3U, true, 990.0f, 0.0f, LOCK_LOCALIZATION_HOLD, 0U);
    LockPositionSolution invalid =
        position(3U, false, 0.0f, 0.0f, LOCK_LOCALIZATION_NONE, 0U);
    LockPositionSolution wrong_id =
        position(4U, true, 990.0f, 0.0f, LOCK_LOCALIZATION_THREE_ANCHOR, 3U);

    lock_fsm_init(&fsm);
    output = lock_fsm_update(&fsm, &unlock, 3U, &config, 10U);
    TEST_ASSERT(output.state == LOCK_STATE_LOCKED);
    output = lock_fsm_update(&fsm, &unlock, 3U, &config, 20U);
    TEST_ASSERT(output.state == LOCK_STATE_LOCKED);
    output = lock_fsm_update(&fsm, &unlock, 3U, &config, 30U);
    TEST_ASSERT(output.state == LOCK_STATE_UNLOCKED);
    TEST_ASSERT(output.unlock_output);

    output =
        lock_fsm_update(&fsm, &unlock_hysteresis, 3U, &config, 40U);
    TEST_ASSERT(output.state == LOCK_STATE_UNLOCKED);
    output = lock_fsm_update(&fsm, &held, 3U, &config, 50U);
    TEST_ASSERT(output.state == LOCK_STATE_UNLOCKED);

    output = lock_fsm_update(&fsm, &welcome, 3U, &config, 60U);
    TEST_ASSERT(output.state == LOCK_STATE_UNLOCKED);
    output = lock_fsm_update(&fsm, &welcome, 3U, &config, 70U);
    TEST_ASSERT(output.state == LOCK_STATE_UNLOCKED);
    output = lock_fsm_update(&fsm, &welcome, 3U, &config, 80U);
    TEST_ASSERT(output.state == LOCK_STATE_WELCOME);

    output = lock_fsm_update(&fsm, &outside, 3U, &config, 90U);
    TEST_ASSERT(output.state == LOCK_STATE_WELCOME);
    output = lock_fsm_update(&fsm, &outside, 3U, &config, 100U);
    TEST_ASSERT(output.state == LOCK_STATE_WELCOME);
    output = lock_fsm_update(&fsm, &outside, 3U, &config, 110U);
    TEST_ASSERT(output.state == LOCK_STATE_LOCKED);

    lock_fsm_update(&fsm, &unlock, 3U, &config, 120U);
    lock_fsm_update(&fsm, &unlock, 3U, &config, 130U);
    output = lock_fsm_update(&fsm, &unlock, 3U, &config, 140U);
    TEST_ASSERT(output.state == LOCK_STATE_UNLOCKED);
    output = lock_fsm_update(&fsm, &invalid, 3U, &config, 150U);
    TEST_ASSERT(output.state == LOCK_STATE_LOCKED);
    TEST_ASSERT(!output.unlock_output);

    output = lock_fsm_update(&fsm, &wrong_id, 3U, &config, 160U);
    TEST_ASSERT(output.state == LOCK_STATE_DENIED);
    TEST_ASSERT(!output.unlock_output);
    return true;
}

static bool test_invalid_model_forces_calibration_error_lock(void)
{
    CalibrationModelV1 invalid_model = g_calibration_model_v1;
    LockApp app;

    invalid_model.crc32 ^= 0x00000001UL;
    lock_app_init_with_model(&app, LOCK_ID_INPUT_DIRECT_BITS, &invalid_model);
    lock_app_update(&app, 100U, 3U);

    TEST_ASSERT(lock_app_outputs(&app)->calibration_error);
    TEST_ASSERT(lock_app_outputs(&app)->state ==
                LOCK_STATE_CALIBRATION_ERROR);
    TEST_ASSERT(!lock_app_outputs(&app)->unlock_output);
    TEST_ASSERT(lock_app_display(&app)->calibration_status ==
                CALIBRATION_MODEL_CRC_ERROR);
    return true;
}

typedef bool (*TestFunction)(void);

typedef struct {
    const char *name;
    TestFunction function;
} TestCase;

int main(void)
{
    static const TestCase tests[] = {
        {"default 2-anchor configuration", test_default_two_anchor_configuration},
        {"model CRC and three range model types", test_model_crc_and_range_models},
        {"empirical model distance, angle, and CRC",
         test_empirical_model_distance_angle_and_crc},
        {"empirical model rejects ambiguous angle",
         test_empirical_model_rejects_ambiguous_angle},
        {"exported empirical model contains all 68 final points",
         test_exported_empirical_model_contains_all_training_points},
        {"2-anchor fusion uses empirical distance only",
         test_two_anchor_fusion_uses_empirical_distance_only},
        {"2-anchor fusion rejects ambiguous empirical angle",
         test_two_anchor_fusion_marks_ambiguous_angle_invalid},
        {"fusion holds output between stable update ticks",
         test_fusion_holds_output_between_stable_update_ticks},
        {"bilinear distance/angle compensation",
         test_bilinear_distance_and_angle_compensation},
        {"2-anchor front mirror resolution",
         test_two_anchor_front_mirror_resolution},
        {"3-anchor NLOS pair degradation",
         test_three_anchor_nlos_degrades_to_reliable_pair},
        {"4-anchor single NLOS rejection",
         test_four_anchor_single_nlos_rejection},
        {"boundary distance, bearing, and dropout",
         test_boundary_distance_bearing_and_dropout},
        {"mixed key addresses are rejected",
         test_fusion_rejects_mixed_key_addresses},
        {"3-frame hysteresis and immediate safety",
         test_three_frame_hysteresis_and_immediate_safety},
        {"2-anchor distance unlocks without using angle",
         test_two_anchor_distance_unlocks_without_using_angle},
        {"invalid calibration model closes lock",
         test_invalid_model_forces_calibration_error_lock},
    };
    size_t index;
    unsigned int failures = 0U;

    for (index = 0U; index < (sizeof(tests) / sizeof(tests[0])); index++) {
        if (tests[index].function()) {
            printf("PASS %s\n", tests[index].name);
        } else {
            printf("FAIL %s\n", tests[index].name);
            failures++;
        }
    }

    printf("%u assertions, %u failures\n", g_assertions, failures);
    return (failures == 0U) ? 0 : 1;
}
