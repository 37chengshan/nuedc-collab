#include "lock_app.h"

#include "empirical_model_data.h"
#include "lock_app_config.h"

#include <math.h>
#include <string.h>

#define LOCK_DISPLAY_DATA_HOLD_MS 3000U

static bool update_raw_channel_display(LockApp *app, uint32_t now_ms)
{
    uint8_t channel;
    bool any_recent = false;

    app->display.channel_valid_mask = 0U;
    for (channel = 0U; channel < LOCK_UWB_CHANNEL_COUNT; channel++) {
        const LockUwbMeasurement *measurement =
            &app->fusion.latest_measurement[channel];

        if (app->fusion.latest_valid[channel] && measurement->valid &&
            ((now_ms - measurement->timestamp_ms) <=
             LOCK_DISPLAY_DATA_HOLD_MS)) {
            app->display.channel_valid_mask |=
                (uint8_t)(1U << channel);
            app->display.channel_distance_mm[channel] =
                measurement->distance_mm;
            any_recent = true;
        }
    }
    return any_recent;
}

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
    /*
     * The independent 190 mm firmware uses the geometry and CRC carried by
     * four_station_model_data.c. The legacy calibration ABI remains linked
     * for the shared application framework but must not overwrite the new
     * four-station coordinates.
     */

    for (channel = 0U; channel < LOCK_UWB_CHANNEL_COUNT; channel++) {
        uwb_text_parser_init(&app->parsers[channel]);
    }
    uwb_fusion_init_with_models(&app->fusion, calibration_model,
                                empirical_model);
    id_input_init(&app->id_input, backend);
    lock_fsm_init(&app->state_machine);
    app->display.state = LOCK_STATE_LOCKED;
    app->display.zone = LOCK_ZONE_INVALID;
    app->display_position_available = false;
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
    bool any_raw_uwb;

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

    if (app->position.valid &&
        (app->position.mode != LOCK_LOCALIZATION_HOLD) &&
        isfinite(app->position.boundary_distance_mm) &&
        isfinite(app->position.bearing_deg)) {
        app->display_position = app->position;
        app->display_position_available = true;
    }

    memset(&app->display, 0, sizeof(app->display));
    app->display.expected_address =
        (uint16_t)((app->config.configured_tag_address & 0xFFF0U) |
                   expected_id);
    app->display.expected_id = expected_id;
    if (app->display_position_available &&
        (((now_ms - app->display_position.updated_ms) <=
          LOCK_DISPLAY_DATA_HOLD_MS) ||
         app->outputs.unlock_output)) {
        app->display.position = app->display_position;
        app->display.observed_address =
            app->display_position.key_addr;
        app->display.observed_id =
            app->display_position.key_id;
        app->display.observed_id_valid = true;
        app->display.authorized =
            app->display_position.key_id == expected_id;
    } else {
        app->display_position_available = false;
    }
    any_raw_uwb = update_raw_channel_display(app, now_ms);
    if (any_raw_uwb) {
        /*
         * The moving digital key uses original address 0x000A. The four
         * responder frames may expose station addresses 0100..0400, so the
         * displayed key identity is the fixed numeric mapping 000A -> 0001.
         */
        app->display.observed_address =
            app->config.configured_tag_address;
        app->display.observed_id = LOCK_DESIGN_KEY_ID;
        app->display.observed_id_valid = true;
        app->display.authorized =
            (expected_id == LOCK_DESIGN_KEY_ID);
        /*
         * PA7 is the yellow field indicator. It remains a welcome indicator
         * for a solved position and also confirms that at least one UWB link
         * is alive while four channels are being brought up.
         */
        app->outputs.yellow_led = true;
    }
    app->display.now_ms = now_ms;
    app->display.zone = app->outputs.zone;
    app->display.state = app->outputs.state;
    app->display.calibration_status = (uint8_t)app->calibration_status;
    app->display.empirical_status = (uint8_t)app->empirical_status;
}

const LockOutputSnapshot *lock_app_outputs(const LockApp *app)
{
    return &app->outputs;
}

const LockDisplayModel *lock_app_display(const LockApp *app)
{
    return &app->display;
}
