#ifndef LOCK_OUTPUT_BEHAVIOR_H
#define LOCK_OUTPUT_BEHAVIOR_H

#include "lock_types.h"

#include <stdbool.h>
#include <stdint.h>

#define LOCK_WELCOME_BEEP_MS 80U
#define LOCK_UNLOCK_BEEP_ON_MS 70U
#define LOCK_UNLOCK_BEEP_GAP_MS 100U
#define LOCK_UNLOCK_BEEP_TOTAL_MS 240U
#define LOCK_DENIED_BEEP_MS 1000U
#define LOCK_BEEP_COOLDOWN_MS 2000U

typedef enum {
    LOCK_BEEP_NONE = 0,
    LOCK_BEEP_WELCOME,
    LOCK_BEEP_UNLOCK,
    LOCK_BEEP_DENIED
} LockBeepPattern;

typedef struct {
    bool previous_welcome;
    bool previous_unlock;
    bool previous_denied;
    bool beep_cooldown_active;
    uint32_t beep_cooldown_until_ms;
    uint32_t pattern_started_ms;
    LockBeepPattern pattern;
} LockOutputBehavior;

typedef struct {
    bool red_on;
    bool green_on;
    bool buzzer_on;
    bool lock_on;
} LockPhysicalOutputs;

void lock_output_behavior_init(LockOutputBehavior *behavior);
LockPhysicalOutputs lock_output_behavior_update(
    LockOutputBehavior *behavior,
    const LockOutputSnapshot *logical,
    uint32_t now_ms);

#endif
