#include "lock_app_config.h"

#include <math.h>
#include <stddef.h>

const LockAppConfig g_lock_app_default_config = {
    .anchors = {
        {-125.0f, 40.0f},
        {125.0f, 40.0f},
        {0.0f, 0.0f},
        {0.0f, 0.0f},
    },
    .anchor_count = 2U,
    .enabled_anchor_mask = 0x03U,
    .zone_confirmation_frames = 3U,
    .radial_zero_offset_mm = 300.0f,
    .welcome_radius_mm = 2000.0f,
    .welcome_exit_radius_mm = 2050.0f,
    .unlock_radius_mm = 1000.0f,
    .unlock_exit_radius_mm = 1050.0f,
    .access_bearing_limit_deg = 45.0f,
    .nlos_residual_threshold_mm = 180.0f,
    .huber_delta_mm = 150.0f,
    .sample_window_ms = 120U,
    .solution_hold_ms = 500U,
    .denied_hold_ms = 700U,
};

bool lock_app_config_validate(const LockAppConfig *config)
{
    uint8_t enabled_count = 0U;
    uint8_t channel;

    if ((config == NULL) ||
        (config->anchor_count < LOCK_UWB_MIN_CHANNEL_COUNT) ||
        (config->anchor_count > LOCK_UWB_CHANNEL_COUNT) ||
        (config->zone_confirmation_frames == 0U) ||
        !isfinite(config->radial_zero_offset_mm) ||
        (config->radial_zero_offset_mm < 0.0f) ||
        !isfinite(config->unlock_radius_mm) ||
        !isfinite(config->unlock_exit_radius_mm) ||
        !isfinite(config->welcome_radius_mm) ||
        !isfinite(config->welcome_exit_radius_mm) ||
        (config->unlock_radius_mm < 0.0f) ||
        (config->unlock_exit_radius_mm < config->unlock_radius_mm) ||
        (config->welcome_radius_mm < config->unlock_exit_radius_mm) ||
        (config->welcome_exit_radius_mm < config->welcome_radius_mm) ||
        !isfinite(config->access_bearing_limit_deg) ||
        (config->access_bearing_limit_deg <= 0.0f) ||
        !isfinite(config->nlos_residual_threshold_mm) ||
        (config->nlos_residual_threshold_mm <= 0.0f) ||
        !isfinite(config->huber_delta_mm) ||
        (config->huber_delta_mm <= 0.0f)) {
        return false;
    }

    for (channel = 0U; channel < LOCK_UWB_CHANNEL_COUNT; channel++) {
        if ((config->enabled_anchor_mask & (uint8_t)(1U << channel)) != 0U) {
            if (!isfinite(config->anchors[channel].x_mm) ||
                !isfinite(config->anchors[channel].y_mm)) {
                return false;
            }
            enabled_count++;
        }
    }

    return enabled_count == config->anchor_count;
}
