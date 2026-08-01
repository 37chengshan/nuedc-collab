#ifndef LOCK_APP_CONFIG_H
#define LOCK_APP_CONFIG_H

#include "lock_types.h"

enum {
    LOCK_ID_INPUT_DEBOUNCE_MS = 30U
};

typedef struct {
    LockAnchor2d anchors[LOCK_UWB_CHANNEL_COUNT];
    float radial_zero_offset_mm;
    float welcome_radius_mm;
    float unlock_radius_mm;
    float access_bearing_limit_deg;
    uint32_t sample_window_ms;
    uint32_t estimator_update_period_ms;
    uint32_t display_period_ms;
    uint32_t solution_hold_ms;
    uint32_t denied_hold_ms;
} LockAppConfig;

extern const LockAppConfig g_lock_app_default_config;

#endif
