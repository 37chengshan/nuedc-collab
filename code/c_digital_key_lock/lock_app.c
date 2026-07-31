#include "lock_app.h"

#include "empirical_model_data.h"
#include "lock_app_config.h"

#include <string.h>

void lock_app_init(LockApp *app, LockIdInputBackend backend)
{
    lock_app_init_with_models(app, backend, &g_calibration_model_v1,
                              &g_empirical_model_v1);
}

void lock_app_init_with_model(LockApp *app, LockIdInputBackend backend,
                              const CalibrationModelV1 *model)
{
    lock_app_init_with_models(app, backend, model, NULL);
}

void lock_app_init_with_models(LockApp *app, LockIdInputBackend backend,
                               const CalibrationModelV1 *calibration_model,
                               const EmpiricalModelV1 *empirical_model)
{
    uint8_t channel;

    memset(app, 0, sizeof(*app));
    app->config = g_lock_app_default_config;
    app->calibration_model = calibration_model;
    app->empirical_model = empirical_model;
    app->calibration_status =
        calibration_model_validate(calibration_model);
    app->empirical_status =
        empirical_model == NULL
            ? EMPIRICAL_MODEL_OK
            : empirical_model_validate(empirical_model);
    if (app->calibration_status == CALIBRATION_MODEL_OK) {
        app->config.anchor_count = calibration_model->anchor_count;
        app->config.enabled_anchor_mask =
            calibration_model->enabled_anchor_mask;
        for (channel = 0U; channel < LOCK_UWB_CHANNEL_COUNT; channel++) {
            app->config.anchors[channel] =
                calibration_model->anchors[channel];
        }
    }

    for (channel = 0U; channel < LOCK_UWB_CHANNEL_COUNT; channel++) {
        uwb_text_parser_init(&app->parsers[channel]);
    }
    uwb_fusion_init_with_models(&app->fusion, calibration_model,
                                empirical_model);
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

    app->calibration_status =
        calibration_model_validate(app->calibration_model);
    app->empirical_status =
        app->empirical_model == NULL
            ? EMPIRICAL_MODEL_OK
            : empirical_model_validate(app->empirical_model);
    if ((app->calibration_status != CALIBRATION_MODEL_OK) ||
        (app->empirical_status != EMPIRICAL_MODEL_OK) ||
        !lock_app_config_validate(&app->config)) {
        memset(&app->position, 0, sizeof(app->position));
        memset(&app->outputs, 0, sizeof(app->outputs));
        app->state_machine.state = LOCK_STATE_CALIBRATION_ERROR;
        app->outputs.zone = LOCK_ZONE_INVALID;
        app->outputs.state = LOCK_STATE_CALIBRATION_ERROR;
        app->outputs.red_led = true;
        app->outputs.calibration_error = true;
    } else {
        uwb_fusion_solve(&app->fusion, &app->config, now_ms,
                         &app->position);
        app->outputs = lock_fsm_update(&app->state_machine, &app->position,
                                       expected_id, &app->config, now_ms);
    }

    memset(&app->display, 0, sizeof(app->display));
    app->display.expected_id = expected_id;
    app->display.observed_id_valid = app->position.valid;
    app->display.observed_id = app->position.key_id;
    app->display.channel_valid_mask = app->position.valid_mask;
    app->display.now_ms = now_ms;
    app->display.zone = app->outputs.zone;
    app->display.state = app->outputs.state;
    app->display.authorized = app->outputs.authorized;
    app->display.calibration_status = (uint8_t)app->calibration_status;
    app->display.empirical_status = (uint8_t)app->empirical_status;
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
