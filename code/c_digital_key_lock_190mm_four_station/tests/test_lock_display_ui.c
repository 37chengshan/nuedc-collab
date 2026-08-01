#include "lock_display_ui.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef struct {
    size_t writes;
    size_t bytes;
} MockBus;

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

static void set_pin(void *context, bool high)
{
    (void)context;
    (void)high;
}

static void write_bytes(void *context, const uint8_t *data, size_t length)
{
    MockBus *bus = (MockBus *)context;

    (void)data;
    bus->writes++;
    bus->bytes += length;
}

static void delay_ms(void *context, uint32_t milliseconds)
{
    (void)context;
    (void)milliseconds;
}

static bool test_ui_states_and_refresh_limit(void)
{
    MockBus mock = {0};
    St7735sBus bus = {
        .context = &mock,
        .set_cs = set_pin,
        .set_dc = set_pin,
        .set_reset = set_pin,
        .write = write_bytes,
        .delay_ms = delay_ms,
    };
    St7735s display;
    LockDisplayUi ui;
    LockDisplayModel model;
    size_t first_writes;

    TEST_ASSERT(st7735s_init(&display, &bus));
    mock.writes = 0U;
    mock.bytes = 0U;
    lock_display_ui_init(&ui, &display);

    memset(&model, 0, sizeof(model));
    model.state = LOCK_STATE_LOCKED;
    model.zone = LOCK_ZONE_INVALID;
    lock_display_ui_render(&ui, &model);
    TEST_ASSERT(mock.writes > 0U);
    first_writes = mock.writes;

    model.now_ms = 50U;
    model.observed_id_valid = true;
    model.observed_id = 0x0AU;
    model.authorized = true;
    model.state = LOCK_STATE_UNLOCKED;
    model.zone = LOCK_ZONE_UNLOCK;
    model.position.valid = true;
    model.position.angle_valid = true;
    model.position.bearing_deg = 30.0f;
    model.position.boundary_distance_mm = 800.0f;
    lock_display_ui_render(&ui, &model);
    TEST_ASSERT(mock.writes == first_writes);

    model.now_ms = LOCK_DISPLAY_UI_REFRESH_MS;
    lock_display_ui_render(&ui, &model);
    TEST_ASSERT(mock.writes > first_writes);
    first_writes = mock.writes;

    model.now_ms += LOCK_DISPLAY_UI_REFRESH_MS;
    model.authorized = false;
    model.state = LOCK_STATE_DENIED;
    model.position.bearing_deg = -18.0f;
    lock_display_ui_render(&ui, &model);
    TEST_ASSERT(mock.writes > first_writes);

    first_writes = mock.writes;
    lock_display_ui_show_color_test(&ui);
    TEST_ASSERT(mock.writes > first_writes);
    return true;
}

int main(void)
{
    unsigned int failures = 0U;

    if (test_ui_states_and_refresh_limit()) {
        puts("PASS UI WAIT/PASS/FAIL, LOCKED/OPEN, and 2 Hz limit");
    } else {
        failures++;
    }
    printf("%u assertions, %u failures\n", g_assertions, failures);
    return failures == 0U ? 0 : 1;
}
