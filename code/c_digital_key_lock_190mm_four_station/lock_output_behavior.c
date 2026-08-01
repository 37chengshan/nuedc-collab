#include "lock_output_behavior.h"

#include <stddef.h>
#include <string.h>

static bool deadline_is_future(uint32_t deadline_ms, uint32_t now_ms)
{
    return (int32_t)(deadline_ms - now_ms) > 0;
}

static void start_pattern(LockOutputBehavior *behavior,
                          LockBeepPattern pattern, uint32_t now_ms)
{
    behavior->pattern = pattern;
    behavior->pattern_started_ms = now_ms;
}

static bool pattern_buzzer_on(LockOutputBehavior *behavior,
                              uint32_t now_ms)
{
    uint32_t elapsed = now_ms - behavior->pattern_started_ms;

    switch (behavior->pattern) {
    case LOCK_BEEP_WELCOME:
        if (elapsed < LOCK_WELCOME_BEEP_MS) {
            return true;
        }
        behavior->pattern = LOCK_BEEP_NONE;
        return false;
    case LOCK_BEEP_UNLOCK:
        if (elapsed < LOCK_UNLOCK_BEEP_ON_MS) {
            return true;
        }
        if (elapsed <
            (LOCK_UNLOCK_BEEP_ON_MS + LOCK_UNLOCK_BEEP_GAP_MS)) {
            return false;
        }
        if (elapsed < LOCK_UNLOCK_BEEP_TOTAL_MS) {
            return true;
        }
        behavior->pattern = LOCK_BEEP_NONE;
        return false;
    case LOCK_BEEP_DENIED:
        if (elapsed < LOCK_DENIED_BEEP_MS) {
            return true;
        }
        behavior->pattern = LOCK_BEEP_NONE;
        return false;
    case LOCK_BEEP_NONE:
    default:
        return false;
    }
}

void lock_output_behavior_init(LockOutputBehavior *behavior)
{
    if (behavior != NULL) {
        memset(behavior, 0, sizeof(*behavior));
    }
}

LockPhysicalOutputs lock_output_behavior_update(
    LockOutputBehavior *behavior,
    const LockOutputSnapshot *logical,
    uint32_t now_ms)
{
    LockPhysicalOutputs physical = {0};
    bool welcome_only;
    bool beep_allowed;

    if ((behavior == NULL) || (logical == NULL)) {
        if (behavior != NULL) {
            lock_output_behavior_init(behavior);
        }
        return physical;
    }

    welcome_only =
        logical->welcome_output && !logical->unlock_output;
    beep_allowed =
        !behavior->beep_cooldown_active ||
        !deadline_is_future(behavior->beep_cooldown_until_ms, now_ms);
    if (welcome_only && !behavior->previous_welcome &&
        beep_allowed) {
        start_pattern(behavior, LOCK_BEEP_WELCOME, now_ms);
        behavior->beep_cooldown_active = true;
        behavior->beep_cooldown_until_ms =
            now_ms + LOCK_BEEP_COOLDOWN_MS;
        beep_allowed = false;
    }
    if (logical->unlock_output && !behavior->previous_unlock &&
        beep_allowed) {
        start_pattern(behavior, LOCK_BEEP_UNLOCK, now_ms);
        behavior->beep_cooldown_active = true;
        behavior->beep_cooldown_until_ms =
            now_ms + LOCK_BEEP_COOLDOWN_MS;
        beep_allowed = false;
    }
    if (logical->buzzer_alarm && !behavior->previous_denied &&
        beep_allowed) {
        start_pattern(behavior, LOCK_BEEP_DENIED, now_ms);
        behavior->beep_cooldown_active = true;
        behavior->beep_cooldown_until_ms =
            now_ms + LOCK_BEEP_COOLDOWN_MS;
    }
    behavior->previous_welcome = welcome_only;
    behavior->previous_unlock = logical->unlock_output;
    behavior->previous_denied = logical->buzzer_alarm;

    /*
     * Red is an alarm-only output.  A stale/conflicting logical snapshot
     * must never leave the red lamp on while the key is in WELCOME/UNLOCK.
     */
    physical.red_on =
        logical->red_led && !logical->welcome_output &&
        !logical->unlock_output;
    physical.green_on = logical->green_led;
    physical.buzzer_on = pattern_buzzer_on(behavior, now_ms);
    physical.lock_on = logical->unlock_output;
    return physical;
}
