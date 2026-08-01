#include "four_station_model_data.h"
#include "id_input.h"
#include "lock_app_config.h"
#include "lock_display_format.h"
#include "lock_fsm.h"
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
                    __LINE__, #condition);                                      \
            return false;                                                       \
        }                                                                       \
    } while (0)

#define TEST_ASSERT_NEAR(actual, expected, tolerance)                           \
    do {                                                                        \
        float actual_ = (actual);                                               \
        float expected_ = (expected);                                           \
        g_assertions++;                                                         \
        if (fabsf(actual_ - expected_) > (tolerance)) {                         \
            fprintf(stderr, "%s:%d: expected %.2f, got %.2f\n", __FILE__,     \
                    __LINE__, expected_, actual_);                              \
            return false;                                                       \
        }                                                                       \
    } while (0)

static LockUwbMeasurement measurement(uint16_t station_address,
                                      uint32_t distance_mm,
                                      uint32_t timestamp_ms)
{
    LockUwbMeasurement value;

    memset(&value, 0, sizeof(value));
    value.valid = true;
    value.key_addr = station_address;
    value.key_id = (uint8_t)(station_address & 0x0FU);
    value.distance_mm = distance_mm;
    value.timestamp_ms = timestamp_ms;
    return value;
}

static void push_prototype(LockUwbFusion *fusion,
                           const UwbFourStationPrototype *prototype,
                           uint32_t timestamp_ms)
{
    uint8_t station;

    for (station = 0U; station < UWB_FOUR_STATION_COUNT; station++) {
        LockUwbMeasurement value =
            measurement(
                g_four_station_model_20260801.station_address[station],
                prototype->range_mm[station], timestamp_ms);

        uwb_fusion_store_measurement(fusion, station, &value);
    }
}

static bool test_geometry_and_model_crc(void)
{
    UwbFourStationModel copy = g_four_station_model_20260801;

    TEST_ASSERT(g_lock_app_default_config.anchor_count == 4U);
    TEST_ASSERT(g_lock_app_default_config.enabled_anchor_mask == 0x0FU);
    TEST_ASSERT_NEAR(g_lock_app_default_config.anchors[0].x_mm, 95.0f, 0.01f);
    TEST_ASSERT_NEAR(g_lock_app_default_config.anchors[1].x_mm, -95.0f, 0.01f);
    TEST_ASSERT_NEAR(g_lock_app_default_config.anchors[2].y_mm, 70.0f, 0.01f);
    TEST_ASSERT_NEAR(g_lock_app_default_config.anchors[3].y_mm, -75.0f, 0.01f);
    TEST_ASSERT(g_lock_app_default_config.configured_tag_address == 0x000AU);
    TEST_ASSERT(g_four_station_model_20260801.prototype_count == 27U);
    TEST_ASSERT(g_four_station_model_20260801.serialized_bytes == 408U);
    TEST_ASSERT(uwb_four_station_model_is_valid(
        &g_four_station_model_20260801));
    copy.crc32 ^= 0x00000001UL;
    TEST_ASSERT(!uwb_four_station_model_is_valid(&copy));
    return true;
}

static bool test_address_000a_maps_to_numeric_id_0001(void)
{
    LockUwbFusion fusion;
    LockPositionSolution solution;
    const UwbFourStationPrototype *prototype =
        &g_four_station_model_20260801.prototypes[5];
    uint8_t repeat;

    uwb_fusion_init(&fusion);
    for (repeat = 0U; repeat < 8U; repeat++) {
        push_prototype(&fusion, prototype, (uint32_t)repeat * 100U);
    }
    uwb_fusion_solve(&fusion, &g_lock_app_default_config, 800U, &solution);
    uwb_fusion_solve(&fusion, &g_lock_app_default_config, 900U, &solution);
    uwb_fusion_solve(&fusion, &g_lock_app_default_config, 1000U, &solution);

    TEST_ASSERT(solution.valid);
    TEST_ASSERT(solution.key_addr == 0x000AU);
    TEST_ASSERT(solution.key_id == 1U);
    TEST_ASSERT(solution.anchor_count == 4U);
    TEST_ASSERT(solution.mode == LOCK_LOCALIZATION_FOUR_ANCHOR);
    TEST_ASSERT_NEAR(solution.radius_from_origin_mm, 1300.0f, 3.0f);
    TEST_ASSERT_NEAR(solution.boundary_distance_mm, 1000.0f, 3.0f);
    TEST_ASSERT(fabsf(solution.bearing_deg) <= 10.0f);
    return true;
}

static bool test_installed_angle_sign_is_reversed_at_output(void)
{
    LockUwbFusion fusion;
    LockPositionSolution solution;
    const UwbFourStationResult *raw_result;
    const UwbFourStationPrototype *prototype =
        &g_four_station_model_20260801.prototypes[8];
    uint8_t repeat;

    uwb_fusion_init(&fusion);
    for (repeat = 0U; repeat < 8U; repeat++) {
        push_prototype(&fusion, prototype, (uint32_t)repeat * 100U);
    }
    uwb_fusion_solve(&fusion, &g_lock_app_default_config, 800U, &solution);
    uwb_fusion_solve(&fusion, &g_lock_app_default_config, 900U, &solution);
    uwb_fusion_solve(&fusion, &g_lock_app_default_config, 1000U, &solution);
    raw_result = uwb_four_station_estimator_result(&fusion.estimator);

    TEST_ASSERT(raw_result != NULL);
    TEST_ASSERT(solution.valid);
    TEST_ASSERT(raw_result->angle_deg_x10 != 0);
    TEST_ASSERT_NEAR(solution.bearing_deg,
                     -(float)raw_result->angle_deg_x10 / 10.0f, 0.01f);
    return true;
}

static bool test_dip_0001_and_unlock_logic(void)
{
    LockIdInput input;
    LockStateMachine state_machine;
    LockPositionSolution position;
    LockOutputSnapshot output;
    char id_text[LOCK_DISPLAY_ID_TEXT_CAPACITY];
    uint8_t frame;

    id_input_init(&input, LOCK_ID_INPUT_DIRECT_BITS);
    id_input_process(&input, 0x01U, 0U);
    id_input_process(&input, 0x01U, LOCK_ID_INPUT_DEBOUNCE_MS);
    TEST_ASSERT(id_input_get_value(&input) == 1U);
    lock_display_format_id4(id_input_get_value(&input), id_text);
    TEST_ASSERT(strcmp(id_text, "0001") == 0);

    memset(&position, 0, sizeof(position));
    position.valid = true;
    position.auth_distance_valid = true;
    position.angle_valid = true;
    position.key_addr = 0x000AU;
    position.key_id = 1U;
    position.anchor_count = 4U;
    position.valid_mask = 0x0FU;
    position.distance_quality = LOCK_DISTANCE_HIGH;
    position.boundary_distance_mm = 900.0f;
    position.bearing_deg = 0.0f;
    position.mode = LOCK_LOCALIZATION_FOUR_ANCHOR;
    lock_fsm_init(&state_machine);
    for (frame = 0U; frame < 3U; frame++) {
        output = lock_fsm_update(
            &state_machine, &position, id_input_get_value(&input),
            &g_lock_app_default_config, (uint32_t)frame * 500U);
    }
    TEST_ASSERT(output.authorized);
    TEST_ASSERT(output.state == LOCK_STATE_UNLOCKED);
    TEST_ASSERT(output.unlock_output);

    memset(&position, 0, sizeof(position));
    output = lock_fsm_update(
        &state_machine, &position, 1U, &g_lock_app_default_config, 1800U);
    TEST_ASSERT(output.state == LOCK_STATE_UNLOCKED);
    TEST_ASSERT(output.unlock_output);
    TEST_ASSERT(output.green_led);
    TEST_ASSERT(!output.red_led);

    position.valid = true;
    position.key_id = LOCK_DESIGN_KEY_ID;
    position.anchor_count = 4U;
    position.valid_mask = 0x0FU;
    position.boundary_distance_mm = 900.0f;
    position.mode = LOCK_LOCALIZATION_FOUR_ANCHOR;
    output = lock_fsm_update(
        &state_machine, &position, 2U, &g_lock_app_default_config, 2000U);
    TEST_ASSERT(!output.authorized);
    TEST_ASSERT(output.state == LOCK_STATE_DENIED);
    TEST_ASSERT(output.red_led);
    TEST_ASSERT(output.buzzer_alarm);
    TEST_ASSERT(!output.unlock_output);
    return true;
}

static bool test_rejected_estimate_still_displays_but_never_authorizes(void)
{
    LockUwbFusion fusion;
    LockPositionSolution solution;
    uint8_t repeat;
    uint8_t station;

    uwb_fusion_init(&fusion);
    for (repeat = 0U; repeat < 8U; repeat++) {
        for (station = 0U; station < UWB_FOUR_STATION_COUNT; station++) {
            LockUwbMeasurement value = measurement(
                g_four_station_model_20260801.station_address[station],
                4500U, (uint32_t)repeat * 100U);

            uwb_fusion_store_measurement(&fusion, station, &value);
        }
    }
    uwb_fusion_solve(&fusion, &g_lock_app_default_config, 800U, &solution);
    TEST_ASSERT(solution.valid);
    TEST_ASSERT(!solution.auth_distance_valid);
    TEST_ASSERT(solution.distance_quality == LOCK_DISTANCE_REJECT);
    TEST_ASSERT(solution.angle_held);
    return true;
}

int main(void)
{
    unsigned int failures = 0U;

    if (!test_geometry_and_model_crc()) {
        failures++;
    }
    if (!test_address_000a_maps_to_numeric_id_0001()) {
        failures++;
    }
    if (!test_installed_angle_sign_is_reversed_at_output()) {
        failures++;
    }
    if (!test_dip_0001_and_unlock_logic()) {
        failures++;
    }
    if (!test_rejected_estimate_still_displays_but_never_authorizes()) {
        failures++;
    }
    printf("%u assertions, %u failures\n", g_assertions, failures);
    return failures == 0U ? 0 : 1;
}
