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
    if (!position->valid) {
        return LOCK_ZONE_INVALID;
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
    return position->valid &&
           (position->anchor_count >= LOCK_UWB_MIN_CHANNEL_COUNT) &&
           (position->mode != LOCK_LOCALIZATION_HOLD);
}

static LockState measured_target_state(const LockStateMachine *state_machine,
                                       const LockPositionSolution *position,
                                       const LockAppConfig *config)
{
    float boundary_distance_mm = position->boundary_distance_mm;

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
    bool expected_id_matches_design_key =
        (expected_id == LOCK_DESIGN_KEY_ID);
    /*
     * The design key is fixed at ID 0001.  The UWB frame's address is not
     * used as an identity source; expected_id is the value selected by DIP.
     */
    bool authorized =
        position->valid && expected_id_matches_design_key &&
        (position->key_id == LOCK_DESIGN_KEY_ID);

    memset(&snapshot, 0, sizeof(snapshot));
    snapshot.zone = zone;
    snapshot.authorized = authorized;

    if (!position->valid) {
        /*
         * Near-field blind-zone latch: once a correctly identified key has
         * reached UNLOCKED (<= 1 m boundary distance), loss of UWB ranging
         * keeps the lock open until a new valid solution updates the zone.
         * A DIP mismatch still overrides the latch immediately.
         */
        if ((state_machine->state == LOCK_STATE_UNLOCKED) &&
            expected_id_matches_design_key) {
            reset_candidate(state_machine);
        } else if (state_machine->state == LOCK_STATE_UNLOCKED) {
            state_machine->state = LOCK_STATE_DENIED;
            reset_candidate(state_machine);
        } else {
            state_machine->state = LOCK_STATE_LOCKED;
            reset_candidate(state_machine);
        }
    } else if (!authorized) {
        /*
         * ID mismatch has absolute priority over distance/zone.  Never
         * permit an unauthorized key to reach WELCOME or UNLOCKED.
         */
        state_machine->state = LOCK_STATE_DENIED;
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
    snapshot.yellow_led = snapshot.welcome_output;
    snapshot.green_led = snapshot.unlock_output;
    snapshot.red_led = (snapshot.state == LOCK_STATE_DENIED) ||
                       (snapshot.state == LOCK_STATE_CALIBRATION_ERROR);
    snapshot.buzzer_alarm = (snapshot.state == LOCK_STATE_DENIED);
    return snapshot;
}
