#include "id_input.h"
#include "lock_app.h"
#include "lock_app_config.h"
#include "lock_fsm.h"
#include "trilateration.h"
#include "uwb_fusion.h"
#include "uwb_text_protocol.h"

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

static float distance_mm(LockAnchor2d anchor, float x_mm, float y_mm)
{
    float dx = x_mm - anchor.x_mm;
    float dy = y_mm - anchor.y_mm;

    return sqrtf((dx * dx) + (dy * dy));
}

static LockUwbMeasurement measurement(uint8_t key_id, uint32_t distance,
                                      uint32_t timestamp_ms)
{
    LockUwbMeasurement value;

    memset(&value, 0, sizeof(value));
    value.valid = true;
    value.key_addr = key_id;
    value.key_id = key_id;
    value.distance_mm = distance;
    value.timestamp_ms = timestamp_ms;
    return value;
}

static void store_position(LockUwbFusion *fusion, const LockAppConfig *config,
                           uint8_t key_id, float x_mm, float y_mm,
                           uint32_t timestamp_ms, uint8_t channel_mask)
{
    uint8_t channel;

    for (channel = 0U; channel < LOCK_UWB_CHANNEL_COUNT; channel++) {
        if ((channel_mask & (uint8_t)(1U << channel)) != 0U) {
            LockUwbMeasurement item =
                measurement(key_id,
                            (uint32_t)lroundf(distance_mm(
                                config->anchors[channel], x_mm, y_mm)),
                            timestamp_ms);
            uwb_fusion_store_measurement(fusion, channel, &item);
        }
    }
}

static void store_channel_position(LockUwbFusion *fusion,
                                   const LockAppConfig *config,
                                   uint8_t channel, uint8_t key_id,
                                   float x_mm, float y_mm,
                                   uint32_t timestamp_ms)
{
    LockUwbMeasurement item =
        measurement(key_id,
                    (uint32_t)lroundf(distance_mm(config->anchors[channel],
                                                  x_mm, y_mm)),
                    timestamp_ms);

    uwb_fusion_store_measurement(fusion, channel, &item);
}

static void enable_three_anchor_fixture(LockAppConfig *config)
{
    config->anchor_count = 3U;
    config->enabled_anchor_mask = 0x07U;
    config->anchors[2].x_mm = 0.0f;
    config->anchors[2].y_mm = -100.0f;
}

static bool test_toggle_input_debounce_and_release(void)
{
    LockIdInput input;

    id_input_init(&input, LOCK_ID_INPUT_TOGGLE_BUTTONS);
    id_input_process(&input, 0x01U, 0U);
    id_input_process(&input, 0x00U, 10U);
    id_input_process(&input, 0x01U, 20U);
    id_input_process(&input, 0x01U, 49U);
    TEST_ASSERT(id_input_get_value(&input) == 0U);

    id_input_process(&input, 0x01U, 50U);
    TEST_ASSERT(id_input_get_value(&input) == 0x01U);
    id_input_process(&input, 0x01U, 500U);
    TEST_ASSERT(id_input_get_value(&input) == 0x01U);

    id_input_process(&input, 0x00U, 510U);
    id_input_process(&input, 0x00U, 539U);
    TEST_ASSERT(id_input_get_value(&input) == 0x01U);
    id_input_process(&input, 0x00U, 540U);
    TEST_ASSERT(id_input_get_value(&input) == 0x01U);

    id_input_process(&input, 0x00U, 1000U);
    TEST_ASSERT(id_input_get_value(&input) == 0x01U);

    id_input_process(&input, 0x01U, 1010U);
    id_input_process(&input, 0x01U, 1040U);
    TEST_ASSERT(id_input_get_value(&input) == 0U);
    id_input_process(&input, 0x00U, 1050U);
    id_input_process(&input, 0x00U, 1080U);
    TEST_ASSERT(id_input_get_value(&input) == 0U);
    return true;
}

static bool test_toggle_input_all_four_bits(void)
{
    LockIdInput input;
    uint8_t bit;

    id_input_init(&input, LOCK_ID_INPUT_TOGGLE_BUTTONS);
    for (bit = 0U; bit < LOCK_ID_BIT_COUNT; bit++) {
        uint8_t mask = (uint8_t)(1U << bit);
        uint32_t base = (uint32_t)bit * 100U;

        id_input_process(&input, mask, base);
        id_input_process(&input, mask, base + LOCK_ID_INPUT_DEBOUNCE_MS);
        id_input_process(&input, 0U, base + 40U);
        id_input_process(&input, 0U, base + 40U + LOCK_ID_INPUT_DEBOUNCE_MS);
    }
    TEST_ASSERT(id_input_get_value(&input) == 0x0FU);
    return true;
}

static bool test_direct_bits_supports_all_16_ids(void)
{
    LockIdInput input;
    uint8_t expected;

    id_input_init(&input, LOCK_ID_INPUT_DIRECT_BITS);
    for (expected = 0U; expected < 16U; expected++) {
        id_input_process(&input, (uint8_t)(expected | 0xF0U),
                         (uint32_t)expected);
        TEST_ASSERT(id_input_get_value(&input) == expected);
    }
    return true;
}

static bool test_uwb_parser_normal_all_ids_and_noise(void)
{
    uint8_t key_id;
    LockUwbMeasurement parsed;

    for (key_id = 0U; key_id < 16U; key_id++) {
        char line[32];
        int written = snprintf(line, sizeof(line), "id=%X,dist=1234", key_id);

        TEST_ASSERT((written > 0) && ((size_t)written < sizeof(line)));
        TEST_ASSERT(uwb_text_parse_line(line, 77U, &parsed));
        TEST_ASSERT(parsed.valid);
        TEST_ASSERT(parsed.key_addr == key_id);
        TEST_ASSERT(parsed.key_id == key_id);
        TEST_ASSERT(parsed.distance_mm == 1234U);
        TEST_ASSERT(parsed.timestamp_ms == 77U);
    }

    TEST_ASSERT(!uwb_text_parse_line("hello,world", 78U, &parsed));
    TEST_ASSERT(!parsed.valid);
    TEST_ASSERT(!uwb_text_parse_line("ID=0x1G,DIST=1200", 79U, &parsed));
    TEST_ASSERT(!uwb_text_parse_line("ID=2,DIST=-1", 80U, &parsed));
    return true;
}

static bool test_uwb_parser_fragmented_and_sticky_lines(void)
{
    UwbTextParser parser;
    LockUwbMeasurement parsed;
    const char *fragment = "ID=3,DIST=1450";
    const char *sticky = "ID=4,DIST=1200\nID=5,DIST=1300\n";
    size_t index;
    unsigned int parsed_count = 0U;

    uwb_text_parser_init(&parser);
    for (index = 0U; fragment[index] != '\0'; index++) {
        TEST_ASSERT(!uwb_text_parser_push(&parser, (uint8_t)fragment[index],
                                          101U, &parsed));
    }
    TEST_ASSERT(uwb_text_parser_push(&parser, (uint8_t)'\n', 102U, &parsed));
    TEST_ASSERT(parsed.key_id == 3U);
    TEST_ASSERT(parsed.distance_mm == 1450U);
    TEST_ASSERT(parsed.timestamp_ms == 102U);

    uwb_text_parser_init(&parser);
    for (index = 0U; sticky[index] != '\0'; index++) {
        if (uwb_text_parser_push(&parser, (uint8_t)sticky[index], 103U,
                                 &parsed)) {
            if (parsed_count == 0U) {
                TEST_ASSERT(parsed.key_id == 4U);
                TEST_ASSERT(parsed.distance_mm == 1200U);
            } else {
                TEST_ASSERT(parsed.key_id == 5U);
                TEST_ASSERT(parsed.distance_mm == 1300U);
            }
            parsed_count++;
        }
    }
    TEST_ASSERT(parsed_count == 2U);
    return true;
}

static bool test_uwb_parser_units_and_compact_crlf_frame(void)
{
    UwbTextParser parser;
    LockUwbMeasurement parsed;
    const char *frame = "P,1111,10cm\r\n";
    size_t index;

    uwb_text_parser_init(&parser);
    for (index = 0U; frame[index] != '\0'; index++) {
        if (frame[index] == '\n') {
            TEST_ASSERT(uwb_text_parser_push(&parser, (uint8_t)frame[index],
                                              104U, &parsed));
        } else {
            TEST_ASSERT(!uwb_text_parser_push(&parser, (uint8_t)frame[index],
                                               104U, &parsed));
        }
    }
    TEST_ASSERT(parsed.key_addr == 0x1111U);
    TEST_ASSERT(parsed.key_id == 0x01U);
    TEST_ASSERT(parsed.distance_mm == 100U);

    TEST_ASSERT(uwb_text_parse_line("ID=6,DIST=2m", 105U, &parsed));
    TEST_ASSERT(parsed.distance_mm == 2000U);
    TEST_ASSERT(!uwb_text_parse_line("ID=6,DIST=10dm", 106U, &parsed));
    TEST_ASSERT(!uwb_text_parse_line("ID=6,DIST=10ft", 107U, &parsed));
    return true;
}

static bool test_fusion_three_two_one_and_timeout(void)
{
    LockUwbFusion fusion;
    LockPositionSolution solution;
    LockAppConfig config = g_lock_app_default_config;

    enable_three_anchor_fixture(&config);
    config.solution_update_interval_ms = 1U;
    uwb_fusion_init(&fusion);
    store_channel_position(&fusion, &config, 0U, 7U, 0.0f, 1300.0f, 100U);
    store_channel_position(&fusion, &config, 1U, 7U, 0.0f, 1300.0f, 101U);
    store_channel_position(&fusion, &config, 2U, 7U, 0.0f, 1300.0f, 102U);
    uwb_fusion_solve(&fusion, &config, 102U, &solution);
    TEST_ASSERT(solution.valid);
    TEST_ASSERT(solution.mode == LOCK_LOCALIZATION_THREE_ANCHOR);
    TEST_ASSERT(solution.anchor_count == 3U);
    TEST_ASSERT(solution.valid_mask == 0x07U);
    TEST_ASSERT(solution.key_id == 7U);
    TEST_ASSERT_NEAR(solution.x_mm, 0.0f, 8.0f);
    TEST_ASSERT_NEAR(solution.y_mm, 1300.0f, 8.0f);

    uwb_fusion_solve(&fusion, &config, 221U, &solution);
    TEST_ASSERT(solution.valid);
    TEST_ASSERT(solution.mode == LOCK_LOCALIZATION_TWO_ANCHOR);
    TEST_ASSERT(solution.anchor_count == 2U);
    TEST_ASSERT(solution.valid_mask == 0x06U);

    uwb_fusion_solve(&fusion, &config, 222U, &solution);
    TEST_ASSERT(solution.valid);
    TEST_ASSERT(solution.mode == LOCK_LOCALIZATION_HOLD);
    TEST_ASSERT(solution.anchor_count == 1U);
    TEST_ASSERT(solution.valid_mask == 0x04U);

    uwb_fusion_solve(&fusion, &config, 723U, &solution);
    TEST_ASSERT(!solution.valid);
    return true;
}

static bool test_fusion_does_not_mix_ids_or_stale_samples(void)
{
    LockUwbFusion fusion;
    LockPositionSolution solution;
    LockAppConfig config = g_lock_app_default_config;
    LockUwbMeasurement item;

    enable_three_anchor_fixture(&config);
    uwb_fusion_init(&fusion);
    store_position(&fusion, &config, 2U, 0.0f, 1300.0f, 100U, 0x03U);
    item = measurement(9U,
                       (uint32_t)lroundf(
                           distance_mm(config.anchors[2], 0.0f, 1300.0f)),
                       101U);
    uwb_fusion_store_measurement(&fusion, 2U, &item);
    uwb_fusion_solve(&fusion, &config, 101U, &solution);
    TEST_ASSERT(!solution.valid);

    uwb_fusion_init(&fusion);
    store_position(&fusion, &config, 2U, 0.0f, 1300.0f, 100U, 0x07U);
    uwb_fusion_solve(&fusion, &config, 221U, &solution);
    TEST_ASSERT(!solution.valid);

    uwb_fusion_init(&fusion);
    store_position(&fusion, &config, 1U, 0.0f, 1300.0f, 100U, 0x03U);
    fusion.channels[0].measurement.key_addr = 0x1111U;
    fusion.channels[1].measurement.key_addr = 0x1111U;
    item = measurement(1U,
                       (uint32_t)lroundf(
                           distance_mm(config.anchors[2], 0.0f, 1300.0f)),
                       101U);
    item.key_addr = 0x2221U;
    uwb_fusion_store_measurement(&fusion, 2U, &item);
    uwb_fusion_solve(&fusion, &config, 101U, &solution);
    TEST_ASSERT(!solution.valid);
    return true;
}

static bool test_localization_bearings_and_radial_distances(void)
{
    LockUwbFusion fusion;
    LockPositionSolution solution;
    LockAppConfig config = g_lock_app_default_config;

    enable_three_anchor_fixture(&config);
    uwb_fusion_init(&fusion);
    store_position(&fusion, &config, 1U, 0.0f, 1300.0f, 100U, 0x07U);
    uwb_fusion_solve(&fusion, &config, 100U, &solution);
    TEST_ASSERT(solution.angle_valid);
    TEST_ASSERT_NEAR(solution.bearing_deg, 0.0f, 0.5f);
    TEST_ASSERT_NEAR(solution.radial_mm, 1000.0f, 10.0f);

    uwb_fusion_init(&fusion);
    store_position(&fusion, &config, 1U, 1300.0f, 1300.0f, 101U, 0x07U);
    uwb_fusion_solve(&fusion, &config, 101U, &solution);
    TEST_ASSERT_NEAR(solution.bearing_deg, 45.0f, 6.0f);

    uwb_fusion_init(&fusion);
    store_position(&fusion, &config, 1U, -1300.0f, 1300.0f, 102U, 0x07U);
    uwb_fusion_solve(&fusion, &config, 102U, &solution);
    TEST_ASSERT_NEAR(solution.bearing_deg, -45.0f, 6.0f);

    uwb_fusion_init(&fusion);
    store_position(&fusion, &config, 1U, 0.0f, 2300.0f, 103U, 0x07U);
    uwb_fusion_solve(&fusion, &config, 103U, &solution);
    TEST_ASSERT_NEAR(solution.radial_mm, 2000.0f, 10.0f);

    uwb_fusion_init(&fusion);
    store_position(&fusion, &config, 1U, 0.0f, 3300.0f, 104U, 0x07U);
    uwb_fusion_solve(&fusion, &config, 104U, &solution);
    TEST_ASSERT_NEAR(solution.radial_mm, 3000.0f, 10.0f);
    return true;
}

static bool test_two_anchor_angle_is_never_trusted(void)
{
    LockUwbFusion fusion;
    LockPositionSolution solution;
    LockAppConfig config = g_lock_app_default_config;

    uwb_fusion_init(&fusion);
    store_position(&fusion, &config, 1U, 0.0f, 1300.0f, 100U, 0x03U);
    uwb_fusion_solve(&fusion, &config, 100U, &solution);

    TEST_ASSERT(solution.valid);
    TEST_ASSERT(solution.mode == LOCK_LOCALIZATION_TWO_ANCHOR);
    TEST_ASSERT(solution.anchor_count == 2U);
    TEST_ASSERT(!solution.angle_valid);
    return true;
}

static LockPositionSolution position(uint8_t key_id, bool valid,
                                     float radial_mm, float bearing_deg,
                                     LockLocalizationMode mode,
                                     uint8_t anchor_count)
{
    LockPositionSolution value;

    memset(&value, 0, sizeof(value));
    value.valid = valid;
    value.key_id = key_id;
    value.radial_mm = radial_mm;
    value.bearing_deg = bearing_deg;
    value.angle_valid = true;
    value.mode = mode;
    value.anchor_count = anchor_count;
    return value;
}

static bool test_fsm_authorization_and_dropout(void)
{
    LockStateMachine state_machine;
    LockAppConfig config = g_lock_app_default_config;
    LockOutputSnapshot output;
    LockPositionSolution valid_id =
        position(3U, true, 800.0f, 0.0f, LOCK_LOCALIZATION_THREE_ANCHOR, 3U);
    LockPositionSolution invalid_id =
        position(4U, true, 800.0f, 0.0f, LOCK_LOCALIZATION_THREE_ANCHOR, 3U);
    LockPositionSolution two_anchor =
        position(3U, true, 800.0f, 0.0f, LOCK_LOCALIZATION_TWO_ANCHOR, 2U);
    LockPositionSolution one_anchor =
        position(3U, true, 1500.0f, 0.0f, LOCK_LOCALIZATION_HOLD, 1U);
    LockPositionSolution dropped =
        position(0U, false, 0.0f, 0.0f, LOCK_LOCALIZATION_NONE, 0U);

    lock_fsm_init(&state_machine);
    output = lock_fsm_update(&state_machine, &valid_id, 3U, &config, 100U);
    TEST_ASSERT(output.authorized);
    TEST_ASSERT(output.state == LOCK_STATE_LOCKED);
    output = lock_fsm_update(&state_machine, &valid_id, 3U, &config, 101U);
    TEST_ASSERT(output.state == LOCK_STATE_LOCKED);
    output = lock_fsm_update(&state_machine, &valid_id, 3U, &config, 102U);
    TEST_ASSERT(output.state == LOCK_STATE_UNLOCKED);
    TEST_ASSERT(output.unlock_output);

    output = lock_fsm_update(&state_machine, &dropped, 3U, &config, 200U);
    TEST_ASSERT(output.state == LOCK_STATE_LOCKED);
    TEST_ASSERT(!output.unlock_output);

    output = lock_fsm_update(&state_machine, &two_anchor, 3U, &config, 300U);
    TEST_ASSERT(output.state == LOCK_STATE_LOCKED);
    TEST_ASSERT(!output.unlock_output);
    output = lock_fsm_update(&state_machine, &two_anchor, 3U, &config, 301U);
    TEST_ASSERT(output.state == LOCK_STATE_LOCKED);
    output = lock_fsm_update(&state_machine, &two_anchor, 3U, &config, 302U);
    TEST_ASSERT(output.state == LOCK_STATE_UNLOCKED);
    TEST_ASSERT(output.unlock_output);

    lock_fsm_init(&state_machine);
    output = lock_fsm_update(&state_machine, &one_anchor, 3U, &config, 400U);
    TEST_ASSERT(output.state == LOCK_STATE_LOCKED);
    TEST_ASSERT(!output.welcome_output);

    output = lock_fsm_update(&state_machine, &invalid_id, 3U, &config, 500U);
    TEST_ASSERT(!output.authorized);
    TEST_ASSERT(output.state == LOCK_STATE_DENIED);
    TEST_ASSERT(output.red_led);
    TEST_ASSERT(output.buzzer_alarm);

    output = lock_fsm_update(&state_machine, &dropped, 3U, &config, 1100U);
    TEST_ASSERT(output.state == LOCK_STATE_LOCKED);
    output = lock_fsm_update(&state_machine, &dropped, 3U, &config, 1201U);
    TEST_ASSERT(output.state == LOCK_STATE_LOCKED);
    return true;
}

static void app_send_line(LockApp *app, uint8_t channel, const char *line,
                          uint32_t now_ms)
{
    size_t index;

    for (index = 0U; line[index] != '\0'; index++) {
        lock_app_process_uart_byte(app, channel, (uint8_t)line[index], now_ms);
    }
    lock_app_process_uart_byte(app, channel, (uint8_t)'\n', now_ms);
}

static bool test_app_uart_and_direct_id_integration(void)
{
    LockApp app;
    float displayed_angle;
    uint8_t channel;
    float x_mm = 0.0f;
    float y_mm = 1300.0f;

    lock_app_init_with_model(
        &app, LOCK_ID_INPUT_DIRECT_BITS, &g_calibration_model_v1);
    app.config.solution_update_interval_ms = 1U;
    for (channel = 0U; channel < LOCK_UWB_CHANNEL_COUNT; channel++) {
        char line[40];
        uint32_t range = (uint32_t)lroundf(
            distance_mm(app.config.anchors[channel], x_mm, y_mm));
        int written = snprintf(line, sizeof(line), "ID=A,DIST=%u", range);

        TEST_ASSERT((written > 0) && ((size_t)written < sizeof(line)));
        app_send_line(&app, channel, line, 100U);
    }
    lock_app_update(&app, 100U, 10U);
    TEST_ASSERT(lock_app_display(&app)->observed_id_valid);
    TEST_ASSERT(lock_app_display(&app)->observed_id == 10U);
    TEST_ASSERT(lock_app_outputs(&app)->authorized);
    TEST_ASSERT(lock_app_outputs(&app)->state == LOCK_STATE_LOCKED);
    TEST_ASSERT(!lock_app_display(&app)->position.angle_valid);
    TEST_ASSERT(lock_app_display(&app)->position.angle_held);
    displayed_angle = lock_app_display(&app)->position.bearing_deg;
    lock_app_update(&app, 101U, 10U);
    TEST_ASSERT(lock_app_outputs(&app)->state == LOCK_STATE_LOCKED);
    lock_app_update(&app, 102U, 10U);
    TEST_ASSERT(lock_app_outputs(&app)->state == LOCK_STATE_UNLOCKED);
    lock_app_update(&app, 2000U, 10U);
    TEST_ASSERT(!lock_app_display(&app)->position.valid);
    TEST_ASSERT(lock_app_display(&app)->position.angle_held);
    TEST_ASSERT_NEAR(lock_app_display(&app)->position.bearing_deg,
                     displayed_angle, 0.01f);
    return true;
}

static bool test_app_starts_with_held_zero_degree_display(void)
{
    LockApp app;

    lock_app_init_with_model(
        &app, LOCK_ID_INPUT_DIRECT_BITS, &g_calibration_model_v1);
    lock_app_update(&app, 0U, 0U);

    TEST_ASSERT(!lock_app_display(&app)->position.angle_valid);
    TEST_ASSERT(lock_app_display(&app)->position.angle_held);
    TEST_ASSERT_NEAR(lock_app_display(&app)->position.bearing_deg,
                     0.0f, 0.01f);
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
        {"toggle input debounce, long press, and release", test_toggle_input_debounce_and_release},
        {"toggle input all four buttons", test_toggle_input_all_four_bits},
        {"direct input all 16 IDs", test_direct_bits_supports_all_16_ids},
        {"UWB normal frames, all IDs, and noise", test_uwb_parser_normal_all_ids_and_noise},
        {"UWB fragmented and sticky frames", test_uwb_parser_fragmented_and_sticky_lines},
        {"UWB units and compact CRLF frame", test_uwb_parser_units_and_compact_crlf_frame},
        {"fusion three/two/one channels and hold timeout", test_fusion_three_two_one_and_timeout},
        {"fusion key address and sample window", test_fusion_does_not_mix_ids_or_stale_samples},
        {"localization 0/+45/-45 degrees and 1/2/3 m", test_localization_bearings_and_radial_distances},
        {"two-anchor angle is never trusted", test_two_anchor_angle_is_never_trusted},
        {"FSM legal ID, illegal ID, and dropout", test_fsm_authorization_and_dropout},
        {"app UART and direct-ID integration", test_app_uart_and_direct_id_integration},
        {"app starts with held zero-degree display",
         test_app_starts_with_held_zero_degree_display},
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
