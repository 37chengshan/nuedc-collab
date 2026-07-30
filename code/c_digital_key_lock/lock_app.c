#include "lock_app.h"

#include "lock_app_config.h"

#include <string.h>

void lock_app_init(LockApp *app, LockIdInputBackend backend)
{
    uint8_t channel;

    memset(app, 0, sizeof(*app));
    app->config = g_lock_app_default_config;

    for (channel = 0U; channel < LOCK_UWB_CHANNEL_COUNT; channel++) {
        uwb_text_parser_init(&app->parsers[channel]);
    }
    uwb_fusion_init(&app->fusion);
    id_input_init(&app->id_input, backend);
    lock_fsm_init(&app->state_machine);
    app->display.state = LOCK_STATE_LOCKED;
    app->display.zone = LOCK_ZONE_INVALID;
}

void lock_app_process_uart_byte(LockApp *app, uint8_t channel, uint8_t byte,
                                uint32_t now_ms)
{
    LockUwbMeasurement measurement;

    if (channel >= LOCK_UWB_CHANNEL_COUNT) {
        return;
    }

    if (uwb_text_parser_push(&app->parsers[channel], byte, now_ms,
                             &measurement)) {
        uwb_fusion_store_measurement(&app->fusion, channel, &measurement);
    }
}

void lock_app_update(LockApp *app, uint32_t now_ms,
                     uint8_t raw_id_low_active_bits)
{
    uint8_t expected_id;

    id_input_process(&app->id_input, raw_id_low_active_bits, now_ms);
    expected_id = id_input_get_value(&app->id_input);

    uwb_fusion_solve(&app->fusion, &app->config, now_ms, &app->position);
    app->outputs = lock_fsm_update(&app->state_machine, &app->position,
                                   expected_id, &app->config, now_ms);

    memset(&app->display, 0, sizeof(app->display));
    app->display.expected_id = expected_id;
    app->display.observed_id_valid = app->position.valid;
    app->display.observed_id = app->position.key_id;
    app->display.channel_valid_mask = app->position.valid_mask;
    app->display.now_ms = now_ms;
    app->display.zone = app->outputs.zone;
    app->display.state = app->outputs.state;
    app->display.authorized = app->outputs.authorized;
    app->display.position = app->position;
}

const LockOutputSnapshot *lock_app_outputs(const LockApp *app)
{
    return &app->outputs;
}

const LockDisplayModel *lock_app_display(const LockApp *app)
{
    return &app->display;
}
