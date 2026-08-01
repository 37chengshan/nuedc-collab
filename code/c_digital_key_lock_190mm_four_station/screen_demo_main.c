#include "ti_msp_dl_config.h"

#include "lock_hw.h"

#include <stdbool.h>
#include <string.h>

#define SCREEN_DEMO_PHASE_MS 3000U
#define SCREEN_DEMO_PHASE_COUNT 4U

static LockDisplayModel demo_model(uint8_t phase, uint32_t now_ms)
{
    LockDisplayModel model;

    memset(&model, 0, sizeof(model));
    model.expected_id = 0x0AU;
    model.now_ms = now_ms;
    model.state = LOCK_STATE_LOCKED;
    model.zone = LOCK_ZONE_INVALID;

    if (phase == 1U) {
        model.observed_id_valid = true;
        model.observed_id = 0x0AU;
        model.authorized = true;
        model.state = LOCK_STATE_UNLOCKED;
        model.zone = LOCK_ZONE_UNLOCK;
        model.channel_valid_mask = 0x07U;
        model.position.valid = true;
        model.position.angle_valid = true;
        model.position.key_id = 0x0AU;
        model.position.anchor_count = 3U;
        model.position.mode = LOCK_LOCALIZATION_THREE_ANCHOR;
        model.position.bearing_deg = 30.0f;
        model.position.boundary_distance_mm = 800.0f;
        model.position.radial_mm = 800.0f;
    } else if (phase == 2U) {
        model.observed_id_valid = true;
        model.observed_id = 0x06U;
        model.authorized = false;
        model.state = LOCK_STATE_DENIED;
        model.zone = LOCK_ZONE_APPROACH;
        model.channel_valid_mask = 0x07U;
        model.position.valid = true;
        model.position.angle_valid = true;
        model.position.key_id = 0x06U;
        model.position.anchor_count = 3U;
        model.position.mode = LOCK_LOCALIZATION_THREE_ANCHOR;
        model.position.bearing_deg = -18.0f;
        model.position.boundary_distance_mm = 1200.0f;
        model.position.radial_mm = 1200.0f;
    }

    return model;
}

int main(void)
{
    uint8_t last_phase = 0xFFU;

    SYSCFG_DL_init();
    lock_hw_init();

    while (1) {
        uint32_t now_ms = lock_hw_millis();
        uint8_t phase =
            (uint8_t)((now_ms / SCREEN_DEMO_PHASE_MS) %
                      SCREEN_DEMO_PHASE_COUNT);

        if (phase != last_phase) {
            if (phase == 0U) {
                lock_hw_show_display_test_pattern();
            } else {
                LockDisplayModel model = demo_model(phase, now_ms);

                lock_hw_present_display(&model);
            }
            last_phase = phase;
        }
        lock_hw_idle();
    }
}
