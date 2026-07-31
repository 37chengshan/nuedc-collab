#include "oled_recovery.h"

#include <stddef.h>

static uint32_t next_retry_time(uint32_t now_ms)
{
    return now_ms + OLED_RECOVERY_RETRY_DELAY_MS;
}

static bool time_reached(uint32_t now_ms, uint32_t deadline_ms)
{
    return (int32_t)(now_ms - deadline_ms) >= 0;
}

void oled_recovery_init(OledRecoveryState *state, bool initialized,
                        uint32_t now_ms)
{
    if (state == NULL) {
        return;
    }

    state->ready = initialized;
    state->consecutive_failures = 0U;
    state->retry_at_ms =
        initialized ? now_ms : next_retry_time(now_ms);
}

bool oled_recovery_is_ready(const OledRecoveryState *state)
{
    return (state != NULL) && state->ready;
}

void oled_recovery_record_refresh(OledRecoveryState *state, bool success,
                                  uint32_t now_ms)
{
    if (state == NULL) {
        return;
    }

    if (success) {
        state->ready = true;
        state->consecutive_failures = 0U;
        return;
    }

    if (state->consecutive_failures < UINT8_MAX) {
        state->consecutive_failures++;
    }
    if (state->consecutive_failures >= OLED_RECOVERY_FAILURE_LIMIT) {
        state->ready = false;
        state->retry_at_ms = next_retry_time(now_ms);
    }
}

bool oled_recovery_reinit_due(const OledRecoveryState *state,
                              uint32_t now_ms)
{
    return (state != NULL) && !state->ready &&
           time_reached(now_ms, state->retry_at_ms);
}

void oled_recovery_record_reinit(OledRecoveryState *state, bool success,
                                 uint32_t now_ms)
{
    if (state == NULL) {
        return;
    }

    state->ready = success;
    state->consecutive_failures = 0U;
    state->retry_at_ms =
        success ? now_ms : next_retry_time(now_ms);
}
