#include "../uwb_monitor.h"
#include "../uwb_calibration.h"
#include "../oled_recovery.h"
#include "../uwb_position.h"

#include <assert.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static void push_text(UwbMonitor *monitor, uint8_t channel, const char *text)
{
    while (*text != '\0') {
        uwb_monitor_push_byte(monitor, channel, (uint8_t)*text);
        text++;
    }
}

static void push_text_at(UwbMonitor *monitor, uint8_t channel,
                         const char *text, uint32_t now_ms)
{
    while (*text != '\0') {
        uwb_monitor_push_byte_at(monitor, channel, (uint8_t)*text, now_ms);
        text++;
    }
}

static uint32_t distance_cm_to_target(float anchor_x_mm, float anchor_y_mm,
                                      float target_x_mm, float target_y_mm)
{
    float dx = target_x_mm - anchor_x_mm;
    float dy = target_y_mm - anchor_y_mm;
    float distance_mm = sqrtf((dx * dx) + (dy * dy));

    return (uint32_t)((distance_mm + 5.0f) / 10.0f);
}

static void push_distance(UwbMonitor *monitor, uint8_t channel,
                          const char *address, uint32_t distance_cm,
                          uint32_t now_ms)
{
    char frame[40];

    (void)snprintf(frame, sizeof(frame), "P,%s,%lucm",
                   address, (unsigned long)distance_cm);
    push_text_at(monitor, channel, frame, now_ms);
}

static void test_real_frame(void)
{
    UwbMonitor monitor;
    const UwbChannelState *state;

    uwb_monitor_init(&monitor);
    push_text(&monitor, 0U, "P,0A00,62cm\r\n");

    state = uwb_monitor_channel(&monitor, 0U);
    assert(state != NULL);
    assert(state->valid);
    assert(strcmp(state->address, "0A00") == 0);
    assert(state->distance_cm == 62U);
    assert(state->frame_count == 1U);
    assert(state->received_bytes == strlen("P,0A00,62cm\r\n"));
    assert(state->rejected_lines == 0U);
}

static void test_current_ewt_frame_with_snr(void)
{
    UwbMonitor monitor;
    const UwbChannelState *state;

    uwb_monitor_init(&monitor);
    push_text(&monitor, 1U, "P1,0200,21cm,3dB\r\n");

    state = uwb_monitor_channel(&monitor, 1U);
    assert(state != NULL);
    assert(state->valid);
    assert(strcmp(state->address, "0200") == 0);
    assert(state->distance_cm == 21U);
    assert(state->frame_count == 1U);
    assert(state->rejected_lines == 0U);

    push_text(&monitor, 1U, "re:P1,0200,7cm,-2dB\r\n");
    assert(strcmp(state->address, "0200") == 0);
    assert(state->distance_cm == 7U);
    assert(state->frame_count == 2U);
}

static void test_current_ewt_stream_without_line_endings(void)
{
    UwbMonitor monitor;
    const UwbChannelState *state;

    uwb_monitor_init(&monitor);
    push_text(&monitor, 0U,
              "P1,0100,21cm,3dBP1,0100,22cm,4dB");

    state = uwb_monitor_channel(&monitor, 0U);
    assert(state != NULL);
    assert(state->valid);
    assert(strcmp(state->address, "0100") == 0);
    assert(state->distance_cm == 22U);
    assert(state->frame_count == 2U);
    assert(state->rejected_lines == 0U);
}

static void test_numbered_frames_follow_physical_uart(void)
{
    UwbMonitor monitor;
    const UwbChannelState *first;
    const UwbChannelState *second;

    uwb_monitor_init(&monitor);
    push_text_at(&monitor, 0U, "re:P1,0100,127cm,18dB", 100U);
    push_text_at(&monitor, 1U, "P0,0200,127cm,15dB", 110U);

    first = uwb_monitor_channel(&monitor, 0U);
    second = uwb_monitor_channel(&monitor, 1U);
    assert(first != NULL);
    assert(second != NULL);
    assert(first->valid);
    assert(second->valid);
    assert(strcmp(first->address, "0100") == 0);
    assert(strcmp(second->address, "0200") == 0);
    assert(first->distance_cm == 127U);
    assert(second->distance_cm == 127U);
    assert(first->frame_count == 1U);
    assert(second->frame_count == 1U);
}

static void test_display_update_waits_for_complete_line(void)
{
    UwbMonitor monitor;
    char row[17];

    uwb_monitor_init(&monitor);

    assert(!uwb_monitor_push_byte(&monitor, 0U, (uint8_t)'X'));
    uwb_monitor_format_row(&monitor, 0U, false, row, sizeof(row));
    assert(strcmp(row, "1 ----    1 BAD") == 0);

    assert(!uwb_monitor_push_byte(&monitor, 0U, (uint8_t)'Y'));
    assert(uwb_monitor_push_byte(&monitor, 0U, (uint8_t)'\n'));
}

static void test_fragmented_and_back_to_back_frames(void)
{
    UwbMonitor monitor;
    const UwbChannelState *state;

    uwb_monitor_init(&monitor);
    push_text(&monitor, 1U, "P,0A");
    push_text(&monitor, 1U, "00,63cm\r\nP,0A00,61cm\n");

    state = uwb_monitor_channel(&monitor, 1U);
    assert(state->valid);
    assert(strcmp(state->address, "0A00") == 0);
    assert(state->distance_cm == 61U);
    assert(state->frame_count == 2U);
}

static void test_two_channels_are_independent(void)
{
    UwbMonitor monitor;

    uwb_monitor_init(&monitor);
    push_text(&monitor, 0U, "P,0A00,34cm\r\n");
    push_text(&monitor, 1U, "P,0A00,150cm\r\n");

    assert(uwb_monitor_channel(&monitor, 0U)->distance_cm == 34U);
    assert(uwb_monitor_channel(&monitor, 1U)->distance_cm == 150U);
    assert(uwb_monitor_channel(&monitor, 0U)->frame_count == 1U);
    assert(uwb_monitor_channel(&monitor, 1U)->frame_count == 1U);
}

static void test_noise_and_invalid_frames_are_ignored(void)
{
    UwbMonitor monitor;
    const UwbChannelState *state;

    uwb_monitor_init(&monitor);
    push_text(&monitor, 1U, "send:+++\r\n");
    push_text(&monitor, 1U, "P,ZZZZ,10cm\r\n");
    push_text(&monitor, 1U, "P,0A00,cm\r\n");

    state = uwb_monitor_channel(&monitor, 1U);
    assert(!state->valid);
    assert(state->frame_count == 0U);
    assert(state->received_bytes != 0U);
    assert(state->rejected_lines == 3U);

    push_text(&monitor, 1U, "P,0a00,7cm\r\n");
    assert(state->valid);
    assert(strcmp(state->address, "0A00") == 0);
    assert(state->distance_cm == 7U);
    assert(state->frame_count == 1U);
}

static void test_overlong_line_recovers_at_next_newline(void)
{
    UwbMonitor monitor;
    char noise[UWB_LINE_CAPACITY + 16U];

    memset(noise, 'X', sizeof(noise) - 1U);
    noise[sizeof(noise) - 1U] = '\0';

    uwb_monitor_init(&monitor);
    push_text(&monitor, 0U, noise);
    push_text(&monitor, 0U, "\r\nP,0A00,99cm\r\n");

    assert(uwb_monitor_channel(&monitor, 0U)->valid);
    assert(uwb_monitor_channel(&monitor, 0U)->distance_cm == 99U);
}

static void test_oled_rows_include_channel_data_and_status(void)
{
    UwbMonitor monitor;
    char row[17];

    uwb_monitor_init(&monitor);
    uwb_monitor_format_row(&monitor, 0U, false, row, sizeof(row));
    assert(strcmp(row, "1 ---- --- WAIT") == 0);
    assert(strlen(row) <= 15U);

    push_text(&monitor, 0U, "send:+++\r\n");
    uwb_monitor_format_row(&monitor, 0U, false, row, sizeof(row));
    assert(strcmp(row, "1 ----   10 BAD") == 0);
    assert(strlen(row) <= 15U);

    push_text(&monitor, 1U, "P,0A00,62cm\r\n");
    uwb_monitor_format_row(&monitor, 1U, false, row, sizeof(row));
    assert(strcmp(row, "2 0A00   62 OK") == 0);
    assert(strlen(row) <= 15U);

    uwb_monitor_format_row(&monitor, 1U, true, row, sizeof(row));
    assert(strcmp(row, "2 ---- ---- OVF") == 0);
    assert(strlen(row) <= 15U);
}

static void test_five_sample_median_and_raw_distance(void)
{
    UwbMonitor monitor;
    const UwbChannelState *state;

    uwb_monitor_init(&monitor);
    push_distance(&monitor, 0U, "0A00", 100U, 100U);
    push_distance(&monitor, 0U, "0A00", 500U, 200U);
    push_distance(&monitor, 0U, "0A00", 102U, 300U);
    push_distance(&monitor, 0U, "0A00", 99U, 400U);
    push_distance(&monitor, 0U, "0A00", 101U, 500U);

    state = uwb_monitor_channel(&monitor, 0U);
    assert(state->valid);
    assert(state->raw_distance_cm == 101U);
    assert(state->distance_cm == 101U);
    assert(state->filter_sample_count == 5U);
    assert(state->last_frame_ms == 500U);
}

static void test_channel_wait_bad_ok_and_lost_states(void)
{
    UwbMonitor monitor;

    uwb_monitor_init(&monitor);
    assert(uwb_monitor_channel_status(&monitor, 0U, 0U) ==
           UWB_CHANNEL_WAIT);

    push_text_at(&monitor, 0U, "garbage\r\n", 10U);
    assert(uwb_monitor_channel_status(&monitor, 0U, 10U) ==
           UWB_CHANNEL_BAD);

    push_distance(&monitor, 0U, "0A00", 100U, 100U);
    assert(uwb_monitor_channel_status(&monitor, 0U, 600U) ==
           UWB_CHANNEL_OK);
    assert(uwb_monitor_channel_status(&monitor, 0U, 601U) ==
           UWB_CHANNEL_LOST);
}

static void store_target(UwbMonitor *monitor, float x_mm, float y_mm,
                         uint32_t first_time_ms, uint32_t second_time_ms)
{
    uint32_t d1_cm = distance_cm_to_target(-125.0f, 40.0f, x_mm, y_mm);
    uint32_t d2_cm = distance_cm_to_target(125.0f, 40.0f, x_mm, y_mm);

    push_distance(monitor, 0U, "0A00", d1_cm, first_time_ms);
    push_distance(monitor, 1U, "0A00", d2_cm, second_time_ms);
}

static void test_two_anchor_distance_and_bearing(void)
{
    UwbMonitor monitor;
    UwbPositionResult result;

    uwb_monitor_init(&monitor);
    store_target(&monitor, 0.0f, 1300.0f, 100U, 110U);
    assert(uwb_position_solve(&monitor, 110U, &result));
    assert(result.status == UWB_POSITION_OK);
    assert(result.radial_cm >= 99U);
    assert(result.radial_cm <= 101U);
    assert(result.angle_deg >= -1);
    assert(result.angle_deg <= 1);
    assert(strcmp(result.address, "0A00") == 0);

    uwb_monitor_init(&monitor);
    store_target(&monitor, 1300.0f, 1300.0f, 200U, 210U);
    assert(uwb_position_solve(&monitor, 210U, &result));
    assert(result.angle_deg >= 44);
    assert(result.angle_deg <= 46);

    uwb_monitor_init(&monitor);
    store_target(&monitor, -1300.0f, 1300.0f, 300U, 310U);
    assert(uwb_position_solve(&monitor, 310U, &result));
    assert(result.angle_deg >= -46);
    assert(result.angle_deg <= -44);
}

static void test_position_rejects_stale_unsynced_and_mismatched_data(void)
{
    UwbMonitor monitor;
    UwbPositionResult result;

    uwb_monitor_init(&monitor);
    store_target(&monitor, 0.0f, 1300.0f, 100U, 301U);
    assert(!uwb_position_solve(&monitor, 301U, &result));
    assert(result.status == UWB_POSITION_SYNC);

    uwb_monitor_init(&monitor);
    push_distance(&monitor, 0U, "0A00", 130U, 100U);
    push_distance(&monitor, 1U, "0A01", 130U, 110U);
    assert(!uwb_position_solve(&monitor, 110U, &result));
    assert(result.status == UWB_POSITION_ADDRESS);

    uwb_monitor_init(&monitor);
    store_target(&monitor, 0.0f, 1300.0f, 100U, 110U);
    assert(!uwb_position_solve(&monitor, 611U, &result));
    assert(result.status == UWB_POSITION_LOST);
}

static void test_position_matches_address_low_nibble(void)
{
    UwbMonitor monitor;
    UwbPositionResult result;

    uwb_monitor_init(&monitor);
    push_distance(&monitor, 0U, "0100", 127U, 100U);
    push_distance(&monitor, 1U, "0200", 127U, 110U);
    assert(uwb_position_solve(&monitor, 110U, &result));
    assert(result.status == UWB_POSITION_OK);

    uwb_monitor_init(&monitor);
    push_distance(&monitor, 0U, "0100", 127U, 100U);
    push_distance(&monitor, 1U, "0201", 127U, 110U);
    assert(!uwb_position_solve(&monitor, 110U, &result));
    assert(result.status == UWB_POSITION_ADDRESS);
}

static void test_four_line_position_screen(void)
{
    UwbMonitor monitor;
    char lines[UWB_SCREEN_LINE_COUNT][UWB_SCREEN_LINE_SIZE];

    uwb_monitor_init(&monitor);
    store_target(&monitor, 0.0f, 1300.0f, 100U, 110U);
    uwb_position_format_screen(&monitor, 110U, lines);

    assert(strcmp(lines[0], "D1: 127 D2: 127") == 0);
    assert(strcmp(lines[1], "R : 100cm") == 0);
    assert(strcmp(lines[2], "A :  +0deg") == 0);
    assert(strcmp(lines[3], "0A00 POS:OK") == 0);

    uwb_position_format_screen(&monitor, 611U, lines);
    assert(strcmp(lines[0], "D1:LOST D2:LOST") == 0);
    assert(strcmp(lines[1], "R :----cm") == 0);
    assert(strcmp(lines[2], "A :----deg") == 0);
    assert(strcmp(lines[3], "---- POS:LOST") == 0);
}

static void test_per_channel_distance_calibration_math(void)
{
    UwbDistanceCalibration identity = {1000U, 0};
    UwbDistanceCalibration corrected = {1020U, -20};
    UwbDistanceCalibration enlarged = {1250U, 0};

    assert(uwb_calibration_apply_mm(100U, &identity) == 1000U);
    assert(uwb_calibration_apply_mm(100U, &corrected) == 1000U);
    assert(uwb_calibration_apply_mm(80U, &enlarged) == 1000U);
}

static void test_oled_recovery_after_repeated_refresh_failures(void)
{
    OledRecoveryState state;

    oled_recovery_init(&state, true, 0U);
    assert(oled_recovery_is_ready(&state));

    oled_recovery_record_refresh(&state, false, 100U);
    oled_recovery_record_refresh(&state, false, 200U);
    assert(oled_recovery_is_ready(&state));

    oled_recovery_record_refresh(&state, false, 300U);
    assert(!oled_recovery_is_ready(&state));
    assert(!oled_recovery_reinit_due(&state, 1299U));
    assert(oled_recovery_reinit_due(&state, 1300U));

    oled_recovery_record_reinit(&state, false, 1300U);
    assert(!oled_recovery_reinit_due(&state, 2299U));
    assert(oled_recovery_reinit_due(&state, 2300U));

    oled_recovery_record_reinit(&state, true, 2300U);
    assert(oled_recovery_is_ready(&state));
    assert(state.consecutive_failures == 0U);
}

static void test_oled_success_clears_failure_count(void)
{
    OledRecoveryState state;

    oled_recovery_init(&state, false, 500U);
    assert(!oled_recovery_is_ready(&state));
    assert(!oled_recovery_reinit_due(&state, 1499U));
    assert(oled_recovery_reinit_due(&state, 1500U));

    oled_recovery_record_reinit(&state, true, 1500U);
    oled_recovery_record_refresh(&state, false, 1600U);
    assert(state.consecutive_failures == 1U);
    oled_recovery_record_refresh(&state, true, 1700U);
    assert(state.consecutive_failures == 0U);
    assert(oled_recovery_is_ready(&state));
}

int main(void)
{
    test_real_frame();
    test_current_ewt_frame_with_snr();
    test_current_ewt_stream_without_line_endings();
    test_numbered_frames_follow_physical_uart();
    test_display_update_waits_for_complete_line();
    test_fragmented_and_back_to_back_frames();
    test_two_channels_are_independent();
    test_noise_and_invalid_frames_are_ignored();
    test_overlong_line_recovers_at_next_newline();
    test_oled_rows_include_channel_data_and_status();
    test_five_sample_median_and_raw_distance();
    test_channel_wait_bad_ok_and_lost_states();
    test_two_anchor_distance_and_bearing();
    test_position_rejects_stale_unsynced_and_mismatched_data();
    test_position_matches_address_low_nibble();
    test_four_line_position_screen();
    test_per_channel_distance_calibration_math();
    test_oled_recovery_after_repeated_refresh_failures();
    test_oled_success_clears_failure_count();
    puts("uwb_monitor tests passed");
    return 0;
}
