#include "lock_app.h"
#include "four_station_model_data.h"

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

static void feed_line(LockApp *app, uint8_t channel, const char *line,
                      uint32_t timestamp_ms)
{
    size_t index;

    for (index = 0U; line[index] != '\0'; index++) {
        lock_app_process_uart_byte(
            app, channel, (uint8_t)line[index], timestamp_ms);
    }
    lock_app_process_uart_byte(app, channel, (uint8_t)'\n', timestamp_ms);
}

static bool test_raw_uwb_immediately_exposes_fixed_tag_id(void)
{
    LockApp app;
    const LockDisplayModel *display;

    lock_app_init(&app, LOCK_ID_INPUT_DIRECT_BITS);
    lock_app_update(&app, 0U, 0x01U);
    feed_line(&app, 0U, "P0,0100,100cm,10dB", 10U);
    lock_app_update(&app, 40U, 0x01U);
    display = lock_app_display(&app);

    TEST_ASSERT((display->channel_valid_mask & 0x01U) != 0U);
    TEST_ASSERT(display->observed_address == 0x000AU);
    TEST_ASSERT(display->observed_id_valid);
    TEST_ASSERT(display->observed_id == 1U);
    TEST_ASSERT(display->expected_id == 1U);
    TEST_ASSERT(display->authorized);
    return true;
}

static bool test_near_field_dropout_keeps_open_and_last_position(void)
{
    LockApp app;
    const UwbFourStationPrototype *prototype =
        &g_four_station_model_20260801.prototypes[5];
    uint8_t repeat;
    uint8_t station;

    lock_app_init(&app, LOCK_ID_INPUT_DIRECT_BITS);
    for (repeat = 0U; repeat < 8U; repeat++) {
        uint32_t timestamp_ms = (uint32_t)repeat * 100U;

        for (station = 0U; station < LOCK_UWB_CHANNEL_COUNT; station++) {
            char line[40];

            (void)snprintf(line, sizeof(line), "ID=A,DIST=%u",
                           prototype->range_mm[station]);
            feed_line(&app, station, line, timestamp_ms);
        }
        lock_app_update(&app, timestamp_ms, LOCK_DESIGN_KEY_ID);
    }
    lock_app_update(&app, 800U, LOCK_DESIGN_KEY_ID);
    lock_app_update(&app, 900U, LOCK_DESIGN_KEY_ID);
    lock_app_update(&app, 1000U, LOCK_DESIGN_KEY_ID);
    TEST_ASSERT(lock_app_outputs(&app)->state == LOCK_STATE_UNLOCKED);
    TEST_ASSERT(lock_app_display(&app)->position.valid);

    lock_app_update(&app, 5000U, LOCK_DESIGN_KEY_ID);
    TEST_ASSERT(!app.position.valid);
    TEST_ASSERT(lock_app_outputs(&app)->state == LOCK_STATE_UNLOCKED);
    TEST_ASSERT(lock_app_outputs(&app)->unlock_output);
    TEST_ASSERT(lock_app_display(&app)->position.valid);
    TEST_ASSERT(lock_app_display(&app)->state == LOCK_STATE_UNLOCKED);
    return true;
}

int main(void)
{
    unsigned int failures = 0U;

    if (!test_raw_uwb_immediately_exposes_fixed_tag_id()) {
        failures++;
    }
    if (!test_near_field_dropout_keeps_open_and_last_position()) {
        failures++;
    }
    printf("%u assertions, %u failures\n", g_assertions, failures);
    return failures == 0U ? 0 : 1;
}
