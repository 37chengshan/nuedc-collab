#ifndef LOCK_OUTPUT_BEHAVIOR_H
#define LOCK_OUTPUT_BEHAVIOR_H

#include "lock_types.h"

#include <stdbool.h>
#include <stdint.h>

#define LOCK_WELCOME_BEEP_MS 180U
#define LOCK_WELCOME_BLINK_HALF_PERIOD_MS 250U

typedef struct {
    bool previous_welcome;
    uint32_t welcome_beep_until_ms;
} LockOutputBehavior;

typedef struct {
    bool red_on;
    bool green_on;
    bool buzzer_on;
} LockPhysicalOutputs;

void lock_output_behavior_init(LockOutputBehavior *behavior);
LockPhysicalOutputs lock_output_behavior_update(
    LockOutputBehavior *behavior,
    const LockOutputSnapshot *logical,
    uint32_t now_ms);

#endif
