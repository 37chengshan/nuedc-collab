#include "lock_output_behavior.h"

#include <stddef.h>
#include <string.h>

static bool deadline_is_future(uint32_t deadline_ms, uint32_t now_ms)
{
    return (int32_t)(deadline_ms - now_ms) > 0;
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

    if ((behavior == NULL) || (logical == NULL)) {
        if (behavior != NULL) {
            lock_output_behavior_init(behavior);
        }
        return physical;
    }

    if (logical->welcome_output && !behavior->previous_welcome) {
        behavior->welcome_beep_until_ms =
            now_ms + LOCK_WELCOME_BEEP_MS;
    }
    behavior->previous_welcome = logical->welcome_output;

    welcome_only =
        logical->welcome_output && !logical->unlock_output;
    physical.red_on = logical->red_led;
    physical.green_on =
        logical->green_led ||
        (welcome_only &&
         (((now_ms / LOCK_WELCOME_BLINK_HALF_PERIOD_MS) & 1U) == 0U));
    physical.buzzer_on =
        logical->buzzer_alarm ||
        deadline_is_future(behavior->welcome_beep_until_ms, now_ms);
    physical.lock_on = logical->unlock_output;
    return physical;
}
