#ifndef LOCK_FSM_H
#define LOCK_FSM_H

#include "lock_app_config.h"

typedef struct {
    LockState state;
    LockState candidate_state;
    uint8_t candidate_count;
    uint32_t denied_hold_until_ms;
} LockStateMachine;

void lock_fsm_init(LockStateMachine *state_machine);
LockZone lock_fsm_classify_zone(const LockPositionSolution *position,
                                const LockAppConfig *config);
LockOutputSnapshot lock_fsm_update(LockStateMachine *state_machine,
                                   const LockPositionSolution *position,
                                   uint8_t expected_id,
                                   const LockAppConfig *config,
                                   uint32_t now_ms);

#endif
