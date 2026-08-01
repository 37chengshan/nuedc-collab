#include "lock_display_format.h"
#include "lock_display_ui.h"

#include <stdbool.h>
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

#define TEST_ASSERT_TEXT(actual, expected)                                      \
    TEST_ASSERT(strcmp((actual), (expected)) == 0)

static bool test_four_bit_id_keeps_leading_zeroes(void)
{
    char text[LOCK_DISPLAY_ID_TEXT_CAPACITY];

    lock_display_format_id4(0U, text);
    TEST_ASSERT_TEXT(text, "0000");
    lock_display_format_id4(2U, text);
    TEST_ASSERT_TEXT(text, "0010");
    lock_display_format_id4(15U, text);
    TEST_ASSERT_TEXT(text, "1111");

    lock_display_format_id4(0x12U, text);
    TEST_ASSERT_TEXT(text, "0010");
    return true;
}

static bool test_full_numeric_address_uses_four_hex_digits(void)
{
    char text[LOCK_DISPLAY_ID_TEXT_CAPACITY];

    lock_display_format_address4(0x000AU, text);
    TEST_ASSERT_TEXT(text, "000A");
    lock_display_format_address4(0x0100U, text);
    TEST_ASSERT_TEXT(text, "0100");
    lock_display_format_address4(0xFFFFU, text);
    TEST_ASSERT_TEXT(text, "FFFF");
    return true;
}

static bool test_key_id_uses_placeholder_when_invalid(void)
{
    LockDisplayModel model;
    char text[LOCK_DISPLAY_ID_TEXT_CAPACITY];

    memset(&model, 0, sizeof(model));
    model.observed_address = 0x000AU;
    model.observed_id = 1U;
    model.observed_id_valid = false;
    lock_display_format_key_id(&model, text);
    TEST_ASSERT_TEXT(text, "----");

    model.observed_id_valid = true;
    lock_display_format_key_id(&model, text);
    TEST_ASSERT_TEXT(text, "0001");

    lock_display_format_key_id(NULL, text);
    TEST_ASSERT_TEXT(text, "----");
    return true;
}

static bool test_angle_formats_positive_negative_and_invalid(void)
{
    LockDisplayModel model;
    char text[LOCK_DISPLAY_ANGLE_TEXT_CAPACITY];

    memset(&model, 0, sizeof(model));
    model.position.angle_valid = true;

    model.position.bearing_deg = 30.4f;
    lock_display_format_angle(&model, text);
    TEST_ASSERT_TEXT(text, "+30 deg");

    model.position.bearing_deg = -17.6f;
    lock_display_format_angle(&model, text);
    TEST_ASSERT_TEXT(text, "-18 deg");

    model.position.bearing_deg = 0.0f;
    lock_display_format_angle(&model, text);
    TEST_ASSERT_TEXT(text, "+0 deg");

    model.position.angle_valid = false;
    model.position.angle_held = true;
    model.position.bearing_deg = 12.4f;
    lock_display_format_angle(&model, text);
    TEST_ASSERT_TEXT(text, "+12 deg");

    model.position.angle_held = false;
    model.position.angle_valid = true;
    model.position.bearing_deg = 181.0f;
    lock_display_format_angle(&model, text);
    TEST_ASSERT_TEXT(text, "--");

    lock_display_format_angle(NULL, text);
    TEST_ASSERT_TEXT(text, "--");
    return true;
}

static bool test_distance_formats_one_decimal_meter(void)
{
    LockDisplayModel model;
    char text[LOCK_DISPLAY_DISTANCE_TEXT_CAPACITY];

    memset(&model, 0, sizeof(model));
    lock_display_format_distance(&model, text);
    TEST_ASSERT_TEXT(text, "--.-m");

    model.position.valid = true;
    model.position.boundary_distance_mm = 400.0f;
    lock_display_format_distance(&model, text);
    TEST_ASSERT_TEXT(text, "0.4m");

    model.position.boundary_distance_mm = 1234.0f;
    lock_display_format_distance(&model, text);
    TEST_ASSERT_TEXT(text, "1.2m");
    return true;
}

static bool test_raw_channels_show_each_uart_before_fusion(void)
{
    LockDisplayModel model;
    char text[LOCK_DISPLAY_CHANNEL_TEXT_CAPACITY];

    memset(&model, 0, sizeof(model));
    lock_display_format_channels(&model, text);
    TEST_ASSERT_TEXT(text, "A:-- B:--");

    model.channel_valid_mask = 0x01U;
    model.channel_distance_mm[0] = 0U;
    lock_display_format_channels(&model, text);
    TEST_ASSERT_TEXT(text, "A:OK B:--");

    model.channel_valid_mask = 0x03U;
    model.channel_distance_mm[0] = 259U;
    model.channel_distance_mm[1] = 966U;
    lock_display_format_channels(&model, text);
    TEST_ASSERT_TEXT(text, "A:OK B:OK");

    model.channel_valid_mask = 0x0FU;
    model.channel_distance_mm[2] = 1234U;
    model.channel_distance_mm[3] = 567U;
    lock_display_format_channel_pair(&model, 2U, text);
    TEST_ASSERT_TEXT(text, "C:OK D:OK");

    lock_display_format_channels(NULL, text);
    TEST_ASSERT_TEXT(text, "A:-- B:--");
    return true;
}

static bool test_auth_text_has_wait_pass_and_fail_states(void)
{
    LockDisplayModel model;

    memset(&model, 0, sizeof(model));
    TEST_ASSERT_TEXT(lock_display_auth_text(&model), "WAIT");
    TEST_ASSERT_TEXT(lock_display_auth_text(NULL), "WAIT");

    model.observed_id_valid = true;
    model.authorized = true;
    TEST_ASSERT_TEXT(lock_display_auth_text(&model), "PASS");

    model.authorized = false;
    TEST_ASSERT_TEXT(lock_display_auth_text(&model), "FAIL");
    return true;
}

static bool test_zone_text_covers_every_zone(void)
{
    TEST_ASSERT_TEXT(lock_display_zone_text(LOCK_ZONE_INVALID), "INVALID");
    TEST_ASSERT_TEXT(lock_display_zone_text(LOCK_ZONE_OUTSIDE), "OUTSIDE");
    TEST_ASSERT_TEXT(lock_display_zone_text(LOCK_ZONE_APPROACH), "APPROACH");
    TEST_ASSERT_TEXT(lock_display_zone_text(LOCK_ZONE_UNLOCK), "UNLOCK");
    TEST_ASSERT_TEXT(lock_display_zone_text(LOCK_ZONE_BACKSIDE), "BACKSIDE");
    TEST_ASSERT_TEXT(lock_display_zone_text((LockZone)99), "INVALID");
    return true;
}

static bool test_lock_state_is_open_only_when_unlocked(void)
{
    TEST_ASSERT_TEXT(lock_display_state_text(LOCK_STATE_LOCKED), "LOCKED");
    TEST_ASSERT_TEXT(lock_display_state_text(LOCK_STATE_WELCOME), "LOCKED");
    TEST_ASSERT_TEXT(lock_display_state_text(LOCK_STATE_UNLOCKED), "OPEN");
    TEST_ASSERT_TEXT(lock_display_state_text(LOCK_STATE_DENIED), "LOCKED");
    TEST_ASSERT_TEXT(lock_display_state_text(LOCK_STATE_CALIBRATION_ERROR),
                     "LOCKED");
    TEST_ASSERT_TEXT(lock_display_state_text((LockState)99), "LOCKED");
    return true;
}

static bool test_monitor_firmware_uses_monitor_footer(void)
{
    LockDisplayModel model;

    memset(&model, 0, sizeof(model));
    model.monitor_only = true;
    model.state = LOCK_STATE_LOCKED;
    TEST_ASSERT_TEXT(lock_display_footer_text(&model), "MONITOR");

    model.monitor_only = false;
    model.state = LOCK_STATE_UNLOCKED;
    TEST_ASSERT_TEXT(lock_display_footer_text(&model), "OPEN");
    return true;
}

static bool test_display_refresh_interval_is_500_ms(void)
{
    TEST_ASSERT(LOCK_DISPLAY_UI_REFRESH_MS == 500U);
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
        {"four-bit ID keeps leading zeroes",
         test_four_bit_id_keeps_leading_zeroes},
        {"full address uses four hex digits",
         test_full_numeric_address_uses_four_hex_digits},
        {"invalid key ID uses placeholder",
         test_key_id_uses_placeholder_when_invalid},
        {"angle positive, negative, and invalid",
         test_angle_formats_positive_negative_and_invalid},
        {"distance formats one decimal meter",
         test_distance_formats_one_decimal_meter},
        {"raw channels display before fusion",
         test_raw_channels_show_each_uart_before_fusion},
        {"AUTH WAIT, PASS, and FAIL",
         test_auth_text_has_wait_pass_and_fail_states},
        {"ZONE text covers every value", test_zone_text_covers_every_zone},
        {"lock state is OPEN only when unlocked",
         test_lock_state_is_open_only_when_unlocked},
        {"monitor firmware uses MONITOR footer",
         test_monitor_firmware_uses_monitor_footer},
        {"display refresh interval is 500 ms",
         test_display_refresh_interval_is_500_ms},
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
