#include "lock_fsm.h"

#include <math.h>
#include <string.h>

void lock_fsm_init(LockStateMachine *state_machine)
{
    memset(state_machine, 0, sizeof(*state_machine));
    state_machine->state = LOCK_STATE_LOCKED;
}

LockZone lock_fsm_classify_zone(const LockPositionSolution *position,
                                const LockAppConfig *config)
{
    bool distance_only_two_anchor;
    bool trusted_multi_anchor;

    if (!position->valid) {
        return LOCK_ZONE_INVALID;
    }

    distance_only_two_anchor =
        (position->mode == LOCK_LOCALIZATION_TWO_ANCHOR) &&
        (position->anchor_count >= 2U);
    trusted_multi_anchor =
        ((position->mode == LOCK_LOCALIZATION_THREE_ANCHOR) ||
         (position->mode == LOCK_LOCALIZATION_FOUR_ANCHOR)) &&
        position->angle_valid;
    if (!distance_only_two_anchor && !trusted_multi_anchor) {
        return LOCK_ZONE_INVALID;
    }

    if (trusted_multi_anchor &&
        (fabsf(position->bearing_deg) >
         config->access_bearing_limit_deg)) {
        return LOCK_ZONE_BACKSIDE;
    }

    if (position->boundary_distance_mm <= config->unlock_radius_mm) {
        return LOCK_ZONE_UNLOCK;
    }

    if (position->boundary_distance_mm <= config->welcome_radius_mm) {
        return LOCK_ZONE_APPROACH;
    }

    return LOCK_ZONE_OUTSIDE;
}

static bool position_is_measured(const LockPositionSolution *position)
{
    if (!position->valid ||
        (position->anchor_count < LOCK_UWB_MIN_CHANNEL_COUNT)) {
        return false;
    }
    if (position->mode == LOCK_LOCALIZATION_TWO_ANCHOR) {
        return true;
    }
    return position->angle_valid &&
           ((position->mode == LOCK_LOCALIZATION_THREE_ANCHOR) ||
            (position->mode == LOCK_LOCALIZATION_FOUR_ANCHOR));
}

static LockState measured_target_state(const LockStateMachine *state_machine,
                                       const LockPositionSolution *position,
                                       const LockAppConfig *config)
{
    float boundary_distance_mm = position->boundary_distance_mm;

    if (position->angle_valid &&
        (fabsf(position->bearing_deg) >
         config->access_bearing_limit_deg)) {
        return LOCK_STATE_LOCKED;
    }

    if (state_machine->state == LOCK_STATE_UNLOCKED) {
        if (boundary_distance_mm <= config->unlock_exit_radius_mm) {
            return LOCK_STATE_UNLOCKED;
        }
        if (boundary_distance_mm <= config->welcome_exit_radius_mm) {
            return LOCK_STATE_WELCOME;
        }
        return LOCK_STATE_LOCKED;
    }

    if (state_machine->state == LOCK_STATE_WELCOME) {
        if (boundary_distance_mm <= config->unlock_radius_mm) {
            return LOCK_STATE_UNLOCKED;
        }
        if (boundary_distance_mm <= config->welcome_exit_radius_mm) {
            return LOCK_STATE_WELCOME;
        }
        return LOCK_STATE_LOCKED;
    }

    if (boundary_distance_mm <= config->unlock_radius_mm) {
        return LOCK_STATE_UNLOCKED;
    }
    if (boundary_distance_mm <= config->welcome_radius_mm) {
        return LOCK_STATE_WELCOME;
    }
    return LOCK_STATE_LOCKED;
}

static void reset_candidate(LockStateMachine *state_machine)
{
    state_machine->candidate_state = state_machine->state;
    state_machine->candidate_count = 0U;
}

static void confirm_target_state(LockStateMachine *state_machine,
                                 LockState target,
                                 const LockAppConfig *config)
{
    if (target == state_machine->state) {
        reset_candidate(state_machine);
        return;
    }
    if (target != state_machine->candidate_state) {
        state_machine->candidate_state = target;
        state_machine->candidate_count = 1U;
    } else if (state_machine->candidate_count < UINT8_MAX) {
        state_machine->candidate_count++;
    }

    if (state_machine->candidate_count >= config->zone_confirmation_frames) {
        state_machine->state = target;
        reset_candidate(state_machine);
    }
}

LockOutputSnapshot lock_fsm_update(LockStateMachine *state_machine,
                                   const LockPositionSolution *position,
                                   uint8_t expected_id,
                                   const LockAppConfig *config,
                                   uint32_t now_ms)
{
    LockOutputSnapshot snapshot;
    LockZone zone = lock_fsm_classify_zone(position, config);
    bool authorized = position->valid && (position->key_id == expected_id);

    memset(&snapshot, 0, sizeof(snapshot));
    snapshot.zone = zone;
    snapshot.authorized = authorized;

    if (!position->valid) {
        state_machine->state = LOCK_STATE_LOCKED;
        reset_candidate(state_machine);
    } else if (!authorized) {
        state_machine->state = LOCK_STATE_DENIED;
        state_machine->denied_hold_until_ms = now_ms + config->denied_hold_ms;
        reset_candidate(state_machine);
    } else if (position->mode == LOCK_LOCALIZATION_HOLD) {
        reset_candidate(state_machine);
    } else if (now_ms < state_machine->denied_hold_until_ms) {
        state_machine->state = LOCK_STATE_DENIED;
        reset_candidate(state_machine);
    } else if (position_is_measured(position)) {
        confirm_target_state(
            state_machine,
            measured_target_state(state_machine, position, config), config);
    } else {
        state_machine->state = LOCK_STATE_LOCKED;
        reset_candidate(state_machine);
    }

    snapshot.state = state_machine->state;
    snapshot.unlock_output = (snapshot.state == LOCK_STATE_UNLOCKED);
    snapshot.welcome_output = (snapshot.state == LOCK_STATE_WELCOME) ||
                              snapshot.unlock_output;
    snapshot.green_led = snapshot.unlock_output;
    snapshot.red_led = (snapshot.state == LOCK_STATE_LOCKED) ||
                       (snapshot.state == LOCK_STATE_DENIED) ||
                       (snapshot.state == LOCK_STATE_CALIBRATION_ERROR);
    snapshot.buzzer_alarm = (snapshot.state == LOCK_STATE_DENIED);
    return snapshot;
}
