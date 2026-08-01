#include "lock_app_config.h"

const LockAppConfig g_lock_app_default_config = {
    .anchors = {
        {72.5f, 0.0f},
        {-72.5f, 0.0f},
    },
    .radial_zero_offset_mm = 300.0f,
    .welcome_radius_mm = 2000.0f,
    .unlock_radius_mm = 1000.0f,
    .access_bearing_limit_deg = 45.0f,
    .sample_window_ms = 800U,
    .estimator_update_period_ms = 100U,
    .display_period_ms = 500U,
    .solution_hold_ms = 500U,
    .denied_hold_ms = 700U,
};
