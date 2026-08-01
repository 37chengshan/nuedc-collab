#ifndef LOCK_APP_CONFIG_H
#define LOCK_APP_CONFIG_H

#include "lock_types.h"

enum {
    LOCK_ID_INPUT_DEBOUNCE_MS = 30U
};

typedef struct {
    LockAnchor2d anchors[LOCK_UWB_CHANNEL_COUNT];
    uint16_t configured_tag_address;
    uint8_t anchor_count;
    uint8_t enabled_anchor_mask;
    uint8_t zone_confirmation_frames;
    float radial_zero_offset_mm;
    float welcome_radius_mm;
    float welcome_exit_radius_mm;
    float unlock_radius_mm;
    float unlock_exit_radius_mm;
    float access_bearing_limit_deg;
    float nlos_residual_threshold_mm;
    float huber_delta_mm;
    uint32_t solution_update_interval_ms;
    uint32_t sample_window_ms;
    uint32_t solution_hold_ms;
    uint32_t denied_hold_ms;
} LockAppConfig;

extern const LockAppConfig g_lock_app_default_config;

bool lock_app_config_validate(const LockAppConfig *config);

#endif
