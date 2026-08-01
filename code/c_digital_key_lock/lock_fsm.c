#include "lock_fsm.h"

#include <string.h>

void lock_fsm_init(LockStateMachine *state_machine)
{
    memset(state_machine, 0, sizeof(*state_machine));
    state_machine->state = LOCK_STATE_LOCKED;
}

LockZone lock_fsm_classify_zone(const LockPositionSolution *position,
                                const LockAppConfig *config)
{
    if (!position->valid) {
        return LOCK_ZONE_INVALID;
    }

    if (position->radial_mm <= config->unlock_radius_mm) {
        return LOCK_ZONE_UNLOCK;
    }

    if (position->radial_mm <= config->welcome_radius_mm) {
        return LOCK_ZONE_APPROACH;
    }

    return LOCK_ZONE_OUTSIDE;
}

LockOutputSnapshot lock_fsm_update(LockStateMachine *state_machine,
                                   const LockPositionSolution *position,
                                   uint8_t expected_id,
                                   const LockAppConfig *config,
                                   uint32_t now_ms)
{
    LockOutputSnapshot snapshot;
    LockZone zone = lock_fsm_classify_zone(position, config);
    bool trusted_position =
        position->valid &&
        position->auth_distance_valid &&
        (position->distance_quality == LOCK_DISTANCE_HIGH) &&
        (position->mode ==
         LOCK_LOCALIZATION_TWO_STATION_EMPIRICAL) &&
        (position->anchor_count == LOCK_UWB_CHANNEL_COUNT);
    bool identity_observed = position->key_id_valid;
    bool authorized = trusted_position && identity_observed &&
                      (position->key_id == expected_id);

    memset(&snapshot, 0, sizeof(snapshot));
    snapshot.zone = zone;
    snapshot.authorized = authorized;

    if (authorized && (zone == LOCK_ZONE_UNLOCK)) {
        state_machine->state = LOCK_STATE_UNLOCKED;
    } else if (trusted_position && identity_observed && !authorized &&
               (zone == LOCK_ZONE_UNLOCK)) {
        state_machine->state = LOCK_STATE_DENIED;
        state_machine->denied_hold_until_ms = now_ms + config->denied_hold_ms;
    } else if (authorized && (zone == LOCK_ZONE_APPROACH)) {
        state_machine->state = LOCK_STATE_WELCOME;
    } else if (now_ms < state_machine->denied_hold_until_ms) {
        state_machine->state = LOCK_STATE_DENIED;
    } else {
        state_machine->state = LOCK_STATE_LOCKED;
    }

    snapshot.state = state_machine->state;
    snapshot.unlock_output = (snapshot.state == LOCK_STATE_UNLOCKED);
    snapshot.welcome_output = (snapshot.state == LOCK_STATE_WELCOME) ||
                              snapshot.unlock_output;
    snapshot.green_led = snapshot.unlock_output;
    snapshot.red_led = (snapshot.state == LOCK_STATE_DENIED);
    snapshot.buzzer_alarm = false;
    return snapshot;
}
