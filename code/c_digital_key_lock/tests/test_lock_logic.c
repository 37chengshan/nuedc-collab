#include "id_input.h"
#include "lock_app.h"
#include "lock_app_config.h"
#include "lock_fsm.h"
#include "lock_ui.h"
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

static LockUwbMeasurement measurement(uint16_t station_addr,
                                      bool station_addr_valid,
                                      uint16_t key_addr,
                                      bool key_addr_valid,
                                      uint32_t distance, int16_t snr_db,
                                      uint32_t timestamp_ms)
{
    LockUwbMeasurement value;

    memset(&value, 0, sizeof(value));
    value.valid = true;
    value.station_addr_valid = station_addr_valid;
    value.station_addr = station_addr;
    value.key_addr_valid = key_addr_valid;
    value.key_addr = key_addr;
    value.key_id =
        key_addr_valid ? (uint8_t)(key_addr & 0x0FU) : 0U;
    value.snr_valid = true;
    value.snr_db = snr_db;
    value.distance_mm = distance;
    value.timestamp_ms = timestamp_ms;
    return value;
}

static void store_two_station_samples(LockUwbFusion *fusion,
                                      uint8_t sample_count,
                                      uint32_t first_timestamp_ms,
                                      uint32_t right_mm,
                                      uint32_t left_mm,
                                      int16_t right_snr_db,
                                      int16_t left_snr_db,
                                      bool key_addr_valid,
                                      uint16_t key_addr)
{
    uint8_t sample_index;

    for (sample_index = 0U; sample_index < sample_count; sample_index++) {
        uint32_t timestamp_ms =
            first_timestamp_ms + ((uint32_t)sample_index * 10U);
        LockUwbMeasurement right =
            measurement(0x0100U, true, key_addr, key_addr_valid,
                        right_mm, right_snr_db, timestamp_ms);
        LockUwbMeasurement left =
            measurement(0x0200U, true, key_addr, key_addr_valid,
                        left_mm, left_snr_db, timestamp_ms);

        uwb_fusion_store_measurement(
            fusion, UWB_TWO_STATION_RIGHT, &right);
        uwb_fusion_store_measurement(
            fusion, UWB_TWO_STATION_LEFT, &left);
    }
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
    uint8_t expected;

    for (expected = 0U; expected < 16U; expected++) {
        LockIdInput input;

        id_input_init(&input, LOCK_ID_INPUT_DIRECT_BITS);
        id_input_process(&input, (uint8_t)(expected | 0xF0U),
                         (uint32_t)expected);
        TEST_ASSERT(id_input_get_value(&input) == expected);
    }
    return true;
}

static bool test_direct_bits_debounces_runtime_changes(void)
{
    LockIdInput input;

    id_input_init(&input, LOCK_ID_INPUT_DIRECT_BITS);
    id_input_process(&input, 0x00U, 0U);
    TEST_ASSERT(id_input_get_value(&input) == 0x00U);

    id_input_process(&input, 0x0AU, 10U);
    id_input_process(
        &input, 0x0AU, 10U + LOCK_ID_INPUT_DEBOUNCE_MS - 1U);
    TEST_ASSERT(id_input_get_value(&input) == 0x00U);
    id_input_process(
        &input, 0x0AU, 10U + LOCK_ID_INPUT_DEBOUNCE_MS);
    TEST_ASSERT(id_input_get_value(&input) == 0x0AU);

    id_input_process(&input, 0x02U, 100U);
    id_input_process(
        &input, 0x02U, 100U + LOCK_ID_INPUT_DEBOUNCE_MS);
    TEST_ASSERT(id_input_get_value(&input) == 0x02U);
    return true;
}

static bool test_lock_ui_password_pairing_and_status(void)
{
    LockDisplayModel display;
    LockUiText text;

    memset(&display, 0, sizeof(display));
    display.expected_id = 0x0AU;
    display.state = LOCK_STATE_LOCKED;
    lock_ui_format(&display, &text);
    TEST_ASSERT(strcmp(text.lines[0], "KEY LOCK") == 0);
    TEST_ASSERT(strcmp(text.lines[1], "SET 0XA") == 0);
    TEST_ASSERT(strcmp(text.lines[2], "SET 1010") == 0);
    TEST_ASSERT(strcmp(text.lines[3], "RX  ----") == 0);
    TEST_ASSERT(strcmp(text.lines[4], "RX  ----") == 0);
    TEST_ASSERT(strcmp(text.lines[5], "PAIR NONE") == 0);
    TEST_ASSERT(strcmp(text.lines[6], "D ---- R") == 0);
    TEST_ASSERT(strcmp(text.lines[7], "LOCK SAFE") == 0);
    TEST_ASSERT(strcmp(text.lines[8], "U R00 L00") == 0);
    TEST_ASSERT(strcmp(text.lines[9], "A ---/---") == 0);
    TEST_ASSERT(lock_ui_pair_status(&display) == LOCK_UI_PAIR_NONE);

    display.observed_id_valid = true;
    display.observed_id = 0x0AU;
    display.state = LOCK_STATE_UNLOCKED;
    display.position.valid = true;
    display.position.radial_mm = 1234.4f;
    display.position.distance_quality = LOCK_DISTANCE_HIGH;
    display.position.sample_count[0] = 6U;
    display.position.sample_count[1] = 5U;
    display.position.angle_confidence = 20U;
    display.position.angle_candidate_1_deg = -15;
    display.position.angle_candidate_2_deg = 40;
    lock_ui_format(&display, &text);
    TEST_ASSERT(strcmp(text.lines[3], "RX  0XA") == 0);
    TEST_ASSERT(strcmp(text.lines[4], "RX  1010") == 0);
    TEST_ASSERT(strcmp(text.lines[5], "PAIR MATCH") == 0);
    TEST_ASSERT(strcmp(text.lines[6], "D 1234 H") == 0);
    TEST_ASSERT(strcmp(text.lines[7], "LOCK OPEN") == 0);
    TEST_ASSERT(strcmp(text.lines[8], "U R06 L05") == 0);
    TEST_ASSERT(strcmp(text.lines[9], "A -15/+40") == 0);
    TEST_ASSERT(lock_ui_pair_status(&display) == LOCK_UI_PAIR_MATCH);

    display.observed_id = 0x05U;
    display.state = LOCK_STATE_DENIED;
    display.position.held = true;
    lock_ui_format(&display, &text);
    TEST_ASSERT(strcmp(text.lines[5], "PAIR FAIL") == 0);
    TEST_ASSERT(strcmp(text.lines[6], "D 1234 *") == 0);
    TEST_ASSERT(strcmp(text.lines[7], "LOCK DENY") == 0);
    TEST_ASSERT(lock_ui_pair_status(&display) == LOCK_UI_PAIR_FAIL);
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
        TEST_ASSERT(!parsed.station_addr_valid);
        TEST_ASSERT(parsed.key_addr_valid);
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
    TEST_ASSERT(parsed.key_addr_valid);
    TEST_ASSERT(!parsed.station_addr_valid);
    TEST_ASSERT(parsed.key_id == 0x01U);
    TEST_ASSERT(parsed.distance_mm == 100U);
    TEST_ASSERT(!parsed.snr_valid);

    TEST_ASSERT(uwb_text_parse_line("P0,0100,84cm,19dB", 105U, &parsed));
    TEST_ASSERT(parsed.station_addr_valid);
    TEST_ASSERT(parsed.station_addr == 0x0100U);
    TEST_ASSERT(!parsed.key_addr_valid);
    TEST_ASSERT(parsed.key_addr == 0U);
    TEST_ASSERT(parsed.key_id == 0U);
    TEST_ASSERT(parsed.distance_mm == 840U);
    TEST_ASSERT(parsed.snr_valid);
    TEST_ASSERT(parsed.snr_db == 19);

    TEST_ASSERT(uwb_text_parse_line("P1,0200,107cm,-1dB", 106U, &parsed));
    TEST_ASSERT(parsed.station_addr_valid);
    TEST_ASSERT(parsed.station_addr == 0x0200U);
    TEST_ASSERT(!parsed.key_addr_valid);
    TEST_ASSERT(parsed.key_id == 0U);
    TEST_ASSERT(parsed.distance_mm == 1070U);
    TEST_ASSERT(parsed.snr_valid);
    TEST_ASSERT(parsed.snr_db == -1);

    TEST_ASSERT(uwb_text_parse_line(
        "re:P0,0100,84cm,19dB", 107U, &parsed));
    TEST_ASSERT(parsed.station_addr_valid);
    TEST_ASSERT(parsed.station_addr == 0x0100U);
    TEST_ASSERT(!parsed.key_addr_valid);
    TEST_ASSERT(parsed.distance_mm == 840U);
    TEST_ASSERT(parsed.snr_valid);
    TEST_ASSERT(parsed.snr_db == 19);

    TEST_ASSERT(uwb_text_parse_line(
        "RE:P,0A0F,84cm", 108U, &parsed));
    TEST_ASSERT(!parsed.station_addr_valid);
    TEST_ASSERT(parsed.key_addr_valid);
    TEST_ASSERT(parsed.key_addr == 0x0A0FU);
    TEST_ASSERT(parsed.key_id == 0x0FU);
    TEST_ASSERT(parsed.distance_mm == 840U);
    TEST_ASSERT(!parsed.snr_valid);

    TEST_ASSERT(uwb_text_parse_line("ID=6,DIST=2m", 109U, &parsed));
    TEST_ASSERT(parsed.distance_mm == 2000U);
    TEST_ASSERT(uwb_text_parse_line(
        "STATION=0100,KEY=0A03,DIST=840mm,SNR=-1dB",
        110U, &parsed));
    TEST_ASSERT(parsed.station_addr_valid);
    TEST_ASSERT(parsed.station_addr == 0x0100U);
    TEST_ASSERT(parsed.key_addr_valid);
    TEST_ASSERT(parsed.key_addr == 0x0A03U);
    TEST_ASSERT(parsed.key_id == 3U);
    TEST_ASSERT(parsed.snr_db == -1);
    TEST_ASSERT(!uwb_text_parse_line("ID=6,DIST=10dm", 111U, &parsed));
    TEST_ASSERT(!uwb_text_parse_line("ID=6,DIST=10ft", 112U, &parsed));
    return true;
}

static bool test_fusion_two_station_quality_and_timeout(void)
{
    LockUwbFusion fusion;
    LockPositionSolution solution;
    LockAppConfig config = g_lock_app_default_config;

    uwb_fusion_init(&fusion);
    store_two_station_samples(
        &fusion, 6U, 10U, 750U, 743U, 12, -4, false, 0U);
    TEST_ASSERT(fusion.latest_valid[UWB_TWO_STATION_RIGHT]);
    TEST_ASSERT(fusion.latest_valid[UWB_TWO_STATION_LEFT]);
    TEST_ASSERT(
        fusion.latest_measurement[UWB_TWO_STATION_RIGHT].station_addr ==
        0x0100U);
    TEST_ASSERT(
        fusion.latest_measurement[UWB_TWO_STATION_LEFT].station_addr ==
        0x0200U);

    uwb_fusion_solve(&fusion, &config, 100U, &solution);
    TEST_ASSERT(solution.valid);
    TEST_ASSERT(!solution.auth_distance_valid);
    TEST_ASSERT(!solution.held);
    TEST_ASSERT(!solution.angle_valid);
    TEST_ASSERT(!solution.angle_auth_valid);
    TEST_ASSERT(!solution.key_id_valid);
    TEST_ASSERT(solution.distance_quality == LOCK_DISTANCE_MEDIUM);
    TEST_ASSERT(
        solution.mode == LOCK_LOCALIZATION_TWO_STATION_EMPIRICAL);
    TEST_ASSERT(solution.anchor_count == LOCK_UWB_CHANNEL_COUNT);
    TEST_ASSERT(solution.valid_mask == 0x03U);
    TEST_ASSERT(solution.key_id == 0U);
    TEST_ASSERT(
        solution.sample_count[UWB_TWO_STATION_RIGHT] == 6U);
    TEST_ASSERT(
        solution.sample_count[UWB_TWO_STATION_LEFT] == 6U);
    TEST_ASSERT(solution.snr_db[UWB_TWO_STATION_RIGHT] == 12);
    TEST_ASSERT(solution.snr_db[UWB_TWO_STATION_LEFT] == -4);

    uwb_fusion_solve(&fusion, &config, 200U, &solution);
    TEST_ASSERT(solution.valid);
    TEST_ASSERT(!solution.auth_distance_valid);
    TEST_ASSERT(!solution.angle_valid);
    TEST_ASSERT(!solution.key_id_valid);
    TEST_ASSERT(solution.distance_quality == LOCK_DISTANCE_MEDIUM);

    uwb_fusion_solve(&fusion, &config, 300U, &solution);
    TEST_ASSERT(solution.valid);
    TEST_ASSERT(solution.auth_distance_valid);
    TEST_ASSERT(!solution.held);
    TEST_ASSERT(!solution.angle_valid);
    TEST_ASSERT(!solution.angle_auth_valid);
    TEST_ASSERT(!solution.key_id_valid);
    TEST_ASSERT(solution.distance_quality == LOCK_DISTANCE_HIGH);
    TEST_ASSERT_NEAR(solution.radial_mm, 800.0f, 50.0f);
    TEST_ASSERT(solution.radial_mm <= config.unlock_radius_mm);

    uwb_fusion_solve(&fusion, &config, 901U, &solution);
    TEST_ASSERT(!solution.valid);
    TEST_ASSERT(!solution.auth_distance_valid);
    TEST_ASSERT(!solution.held);
    TEST_ASSERT(!solution.angle_valid);
    TEST_ASSERT(solution.distance_quality == LOCK_DISTANCE_REJECT);
    TEST_ASSERT(
        (solution.failure_flags &
         UWB_TWO_STATION_FAILURE_STALE) != 0U);
    return true;
}

static LockPositionSolution position(uint8_t key_id, bool valid,
                                     bool auth_distance_valid,
                                     bool key_id_valid,
                                     LockDistanceQuality distance_quality,
                                     float radial_mm,
                                     LockLocalizationMode mode,
                                     uint8_t anchor_count)
{
    LockPositionSolution value;

    memset(&value, 0, sizeof(value));
    value.valid = valid;
    value.auth_distance_valid = auth_distance_valid;
    value.key_id_valid = key_id_valid;
    value.key_id = key_id;
    value.valid_mask =
        (anchor_count == LOCK_UWB_CHANNEL_COUNT) ? 0x03U : 0U;
    value.distance_quality = distance_quality;
    value.radial_mm = radial_mm;
    value.mode = mode;
    value.anchor_count = anchor_count;
    return value;
}

static bool test_fsm_high_only_authorization_and_dropout(void)
{
    LockStateMachine state_machine;
    LockAppConfig config = g_lock_app_default_config;
    LockOutputSnapshot output;
    LockPositionSolution valid_id =
        position(0U, true, true, true, LOCK_DISTANCE_HIGH, 800.0f,
                 LOCK_LOCALIZATION_TWO_STATION_EMPIRICAL, 2U);
    LockPositionSolution invalid_id =
        position(1U, true, true, true, LOCK_DISTANCE_HIGH, 800.0f,
                 LOCK_LOCALIZATION_TWO_STATION_EMPIRICAL, 2U);
    LockPositionSolution missing_id =
        position(0U, true, true, false, LOCK_DISTANCE_HIGH, 800.0f,
                 LOCK_LOCALIZATION_TWO_STATION_EMPIRICAL, 2U);
    LockPositionSolution medium =
        position(0U, true, true, true, LOCK_DISTANCE_MEDIUM, 800.0f,
                 LOCK_LOCALIZATION_TWO_STATION_EMPIRICAL, 2U);
    LockPositionSolution reject =
        position(0U, true, true, true, LOCK_DISTANCE_REJECT, 800.0f,
                 LOCK_LOCALIZATION_TWO_STATION_EMPIRICAL, 2U);
    LockPositionSolution held =
        position(0U, true, true, true, LOCK_DISTANCE_HIGH, 800.0f,
                 LOCK_LOCALIZATION_HOLD, 2U);
    LockPositionSolution dropped =
        position(0U, false, false, false, LOCK_DISTANCE_REJECT, 0.0f,
                 LOCK_LOCALIZATION_NONE, 0U);

    lock_fsm_init(&state_machine);
    output = lock_fsm_update(&state_machine, &medium, 0U, &config, 100U);
    TEST_ASSERT(!output.authorized);
    TEST_ASSERT(output.state == LOCK_STATE_LOCKED);
    TEST_ASSERT(!output.unlock_output);
    TEST_ASSERT(!output.red_led);
    TEST_ASSERT(!output.buzzer_alarm);

    output = lock_fsm_update(&state_machine, &reject, 0U, &config, 200U);
    TEST_ASSERT(!output.authorized);
    TEST_ASSERT(output.state == LOCK_STATE_LOCKED);
    TEST_ASSERT(!output.unlock_output);

    output = lock_fsm_update(
        &state_machine, &missing_id, 0U, &config, 250U);
    TEST_ASSERT(!output.authorized);
    TEST_ASSERT(output.state == LOCK_STATE_LOCKED);
    TEST_ASSERT(!output.buzzer_alarm);

    output = lock_fsm_update(&state_machine, &valid_id, 0U, &config, 300U);
    TEST_ASSERT(output.authorized);
    TEST_ASSERT(output.state == LOCK_STATE_UNLOCKED);
    TEST_ASSERT(output.unlock_output);

    output = lock_fsm_update(&state_machine, &held, 0U, &config, 400U);
    TEST_ASSERT(!output.authorized);
    TEST_ASSERT(output.state == LOCK_STATE_LOCKED);
    TEST_ASSERT(!output.unlock_output);

    output = lock_fsm_update(&state_machine, &invalid_id, 0U, &config, 500U);
    TEST_ASSERT(!output.authorized);
    TEST_ASSERT(output.state == LOCK_STATE_DENIED);
    TEST_ASSERT(output.red_led);
    TEST_ASSERT(!output.buzzer_alarm);

    output = lock_fsm_update(&state_machine, &dropped, 0U, &config, 1100U);
    TEST_ASSERT(output.state == LOCK_STATE_DENIED);
    output = lock_fsm_update(&state_machine, &dropped, 0U, &config, 1201U);
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

static void app_send_station_only_samples(LockApp *app,
                                          uint8_t sample_count,
                                          uint32_t first_timestamp_ms)
{
    uint8_t sample_index;

    for (sample_index = 0U; sample_index < sample_count; sample_index++) {
        uint32_t timestamp_ms =
            first_timestamp_ms + ((uint32_t)sample_index * 10U);

        app_send_line(app, UWB_TWO_STATION_RIGHT,
                      "P0,0100,750mm,12dB", timestamp_ms);
        app_send_line(app, UWB_TWO_STATION_LEFT,
                      "P1,0200,743mm,-4dB", timestamp_ms);
    }
}

static void app_send_keyed_samples(LockApp *app, uint8_t sample_count,
                                   uint32_t first_timestamp_ms,
                                   uint16_t key_addr)
{
    uint8_t sample_index;

    for (sample_index = 0U; sample_index < sample_count; sample_index++) {
        char right[48];
        char left[48];
        uint32_t timestamp_ms =
            first_timestamp_ms + ((uint32_t)sample_index * 10U);
        int right_written = snprintf(
            right, sizeof(right), "P,%04X,750mm,12dB", key_addr);
        int left_written = snprintf(
            left, sizeof(left), "P,%04X,743mm,-4dB", key_addr);

        if ((right_written <= 0) || (left_written <= 0) ||
            ((size_t)right_written >= sizeof(right)) ||
            ((size_t)left_written >= sizeof(left))) {
            return;
        }
        app_send_line(
            app, UWB_TWO_STATION_RIGHT, right, timestamp_ms);
        app_send_line(
            app, UWB_TWO_STATION_LEFT, left, timestamp_ms);
    }
}

static void app_send_keyed_samples_without_snr(
    LockApp *app, uint8_t sample_count,
    uint32_t first_timestamp_ms, uint16_t key_addr)
{
    uint8_t sample_index;

    for (sample_index = 0U; sample_index < sample_count; sample_index++) {
        char right[40];
        char left[40];
        uint32_t timestamp_ms =
            first_timestamp_ms + ((uint32_t)sample_index * 10U);
        int right_written = snprintf(
            right, sizeof(right), "P,%04X,750mm", key_addr);
        int left_written = snprintf(
            left, sizeof(left), "P,%04X,743mm", key_addr);

        if ((right_written <= 0) || (left_written <= 0) ||
            ((size_t)right_written >= sizeof(right)) ||
            ((size_t)left_written >= sizeof(left))) {
            return;
        }
        app_send_line(
            app, UWB_TWO_STATION_RIGHT, right, timestamp_ms);
        app_send_line(
            app, UWB_TWO_STATION_LEFT, left, timestamp_ms);
    }
}

static bool test_app_station_frames_high_never_unlock(void)
{
    LockApp app;

    lock_app_init(&app, LOCK_ID_INPUT_DIRECT_BITS);
    app_send_station_only_samples(&app, 6U, 10U);

    lock_app_update(&app, 100U, 0U);
    TEST_ASSERT(app.position.valid);
    TEST_ASSERT(!app.position.auth_distance_valid);
    TEST_ASSERT(!app.position.angle_valid);
    TEST_ASSERT(app.position.distance_quality == LOCK_DISTANCE_MEDIUM);
    TEST_ASSERT(!lock_app_outputs(&app)->authorized);
    TEST_ASSERT(lock_app_outputs(&app)->state == LOCK_STATE_LOCKED);
    TEST_ASSERT(!lock_app_display(&app)->observed_id_valid);
    TEST_ASSERT(lock_app_display(&app)->expected_id == 0U);
    TEST_ASSERT(lock_app_display(&app)->observed_id == 0U);
    TEST_ASSERT(lock_app_display(&app)->now_ms == 100U);

    lock_app_update(&app, 200U, 0U);
    TEST_ASSERT(app.position.distance_quality == LOCK_DISTANCE_MEDIUM);
    TEST_ASSERT(!lock_app_outputs(&app)->authorized);
    TEST_ASSERT(lock_app_display(&app)->now_ms == 100U);

    lock_app_update(&app, 300U, 0U);
    TEST_ASSERT(app.position.valid);
    TEST_ASSERT(app.position.auth_distance_valid);
    TEST_ASSERT(!app.position.key_id_valid);
    TEST_ASSERT(!app.position.angle_valid);
    TEST_ASSERT(!app.position.angle_auth_valid);
    TEST_ASSERT(app.position.distance_quality == LOCK_DISTANCE_HIGH);
    TEST_ASSERT(
        app.position.mode == LOCK_LOCALIZATION_TWO_STATION_EMPIRICAL);
    TEST_ASSERT(app.position.anchor_count == LOCK_UWB_CHANNEL_COUNT);
    TEST_ASSERT(
        app.position.sample_count[UWB_TWO_STATION_RIGHT] == 6U);
    TEST_ASSERT(
        app.position.sample_count[UWB_TWO_STATION_LEFT] == 6U);
    TEST_ASSERT(app.position.snr_db[UWB_TWO_STATION_RIGHT] == 12);
    TEST_ASSERT(app.position.snr_db[UWB_TWO_STATION_LEFT] == -4);
    TEST_ASSERT(!lock_app_outputs(&app)->authorized);
    TEST_ASSERT(lock_app_outputs(&app)->state == LOCK_STATE_LOCKED);
    TEST_ASSERT(!lock_app_outputs(&app)->unlock_output);
    return true;
}

static bool test_app_keyed_high_unlock_and_display_throttle(void)
{
    LockApp app;

    lock_app_init(&app, LOCK_ID_INPUT_DIRECT_BITS);
    app_send_keyed_samples(&app, 6U, 10U, 0x0A00U);

    lock_app_update(&app, 100U, 0U);
    TEST_ASSERT(app.position.valid);
    TEST_ASSERT(app.position.key_id_valid);
    TEST_ASSERT(app.position.key_addr == 0x0A00U);
    TEST_ASSERT(app.position.distance_quality == LOCK_DISTANCE_MEDIUM);
    TEST_ASSERT(!lock_app_outputs(&app)->authorized);
    TEST_ASSERT(lock_app_display(&app)->observed_id_valid);
    TEST_ASSERT(lock_app_display(&app)->observed_id == 0U);
    TEST_ASSERT(lock_app_display(&app)->now_ms == 100U);

    lock_app_update(&app, 200U, 0U);
    TEST_ASSERT(!lock_app_outputs(&app)->authorized);
    TEST_ASSERT(lock_app_display(&app)->now_ms == 100U);

    lock_app_update(&app, 300U, 0U);
    TEST_ASSERT(app.position.distance_quality == LOCK_DISTANCE_HIGH);
    TEST_ASSERT(app.position.auth_distance_valid);
    TEST_ASSERT(app.position.key_id_valid);
    TEST_ASSERT(!app.position.angle_valid);
    TEST_ASSERT(!app.position.angle_auth_valid);
    TEST_ASSERT(lock_app_outputs(&app)->authorized);
    TEST_ASSERT(lock_app_outputs(&app)->state == LOCK_STATE_UNLOCKED);
    TEST_ASSERT(lock_app_outputs(&app)->unlock_output);
    TEST_ASSERT(lock_app_display(&app)->now_ms == 100U);
    TEST_ASSERT(!lock_app_display(&app)->authorized);
    TEST_ASSERT(lock_app_display(&app)->state == LOCK_STATE_LOCKED);

    lock_app_update(&app, 599U, 0U);
    TEST_ASSERT(lock_app_display(&app)->now_ms == 100U);

    lock_app_update(&app, 600U, 0U);
    TEST_ASSERT(lock_app_display(&app)->now_ms == 600U);
    TEST_ASSERT(lock_app_display(&app)->authorized);
    TEST_ASSERT(lock_app_display(&app)->state == LOCK_STATE_UNLOCKED);
    TEST_ASSERT(
        lock_app_display(&app)->position.distance_quality ==
        LOCK_DISTANCE_HIGH);
    TEST_ASSERT(!lock_app_display(&app)->position.angle_valid);
    return true;
}

static bool test_app_official_no_snr_frames_unlock_after_quality_gate(void)
{
    LockApp app;

    lock_app_init(&app, LOCK_ID_INPUT_DIRECT_BITS);
    app_send_keyed_samples_without_snr(&app, 6U, 10U, 0x0A00U);

    lock_app_update(&app, 100U, 0U);
    TEST_ASSERT(app.position.key_id_valid);
    TEST_ASSERT(app.position.key_addr == 0x0A00U);
    TEST_ASSERT(app.position.distance_quality == LOCK_DISTANCE_MEDIUM);
    TEST_ASSERT(!lock_app_outputs(&app)->authorized);

    lock_app_update(&app, 200U, 0U);
    TEST_ASSERT(app.position.distance_quality == LOCK_DISTANCE_MEDIUM);
    TEST_ASSERT(!lock_app_outputs(&app)->authorized);

    lock_app_update(&app, 300U, 0U);
    TEST_ASSERT(app.position.distance_quality == LOCK_DISTANCE_HIGH);
    TEST_ASSERT(app.position.auth_distance_valid);
    TEST_ASSERT(app.position.key_id_valid);
    TEST_ASSERT(lock_app_outputs(&app)->authorized);
    TEST_ASSERT(lock_app_outputs(&app)->state == LOCK_STATE_UNLOCKED);
    TEST_ASSERT(lock_app_outputs(&app)->unlock_output);
    return true;
}

static bool test_uart_overflow_flag_keeps_lock_closed(void)
{
    LockApp app;
    size_t index;

    lock_app_init(&app, LOCK_ID_INPUT_DIRECT_BITS);
    for (index = 0U; index < (LOCK_UWB_RAW_LINE_CAPACITY + 8U);
         index++) {
        lock_app_process_uart_byte(
            &app, UWB_TWO_STATION_RIGHT, (uint8_t)'A', 10U);
    }
    lock_app_update(&app, 100U, 0U);

    TEST_ASSERT(
        (app.position.failure_flags &
         UWB_TWO_STATION_FAILURE_BUFFER_OVERFLOW) != 0U);
    TEST_ASSERT(!app.position.valid);
    TEST_ASSERT(!app.position.auth_distance_valid);
    TEST_ASSERT(!app.position.key_id_valid);
    TEST_ASSERT(!lock_app_outputs(&app)->authorized);
    TEST_ASSERT(lock_app_outputs(&app)->state == LOCK_STATE_LOCKED);
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
        {"direct input runtime debounce", test_direct_bits_debounces_runtime_changes},
        {"LCD text password and pairing status", test_lock_ui_password_pairing_and_status},
        {"UWB normal frames, all IDs, and noise", test_uwb_parser_normal_all_ids_and_noise},
        {"UWB fragmented and sticky frames", test_uwb_parser_fragmented_and_sticky_lines},
        {"UWB units and compact CRLF frame", test_uwb_parser_units_and_compact_crlf_frame},
        {"fusion two-station quality and timeout", test_fusion_two_station_quality_and_timeout},
        {"FSM HIGH-only authorization and dropout", test_fsm_high_only_authorization_and_dropout},
        {"app station-address frames never unlock", test_app_station_frames_high_never_unlock},
        {"app keyed HIGH unlock and display throttle", test_app_keyed_high_unlock_and_display_throttle},
        {"official no-SNR key frames pass guarded quality profile", test_app_official_no_snr_frames_unlock_after_quality_gate},
        {"UART overflow flag keeps lock closed", test_uart_overflow_flag_keeps_lock_closed},
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
