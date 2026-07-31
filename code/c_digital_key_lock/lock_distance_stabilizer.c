#include "lock_distance_stabilizer.h"

#include <math.h>
#include <stddef.h>
#include <string.h>

#define LOCK_DISTANCE_SMOOTH_ALPHA 0.25f
#define LOCK_DISTANCE_JUMP_THRESHOLD_MM 180.0f
#define LOCK_DISTANCE_CANDIDATE_TOLERANCE_MM 120.0f
#define LOCK_DISTANCE_JUMP_CONFIRMATIONS 3U

void lock_distance_stabilizer_reset(LockDistanceStabilizer *stabilizer)
{
    if (stabilizer != NULL) {
        memset(stabilizer, 0, sizeof(*stabilizer));
    }
}

float lock_distance_stabilizer_update(LockDistanceStabilizer *stabilizer,
                                      uint16_t key_addr, uint8_t key_id,
                                      float measured_distance_mm)
{
    float delta;

    if ((stabilizer == NULL) || !isfinite(measured_distance_mm)) {
        return measured_distance_mm;
    }
    if (!stabilizer->initialized ||
        (stabilizer->key_addr != key_addr) ||
        (stabilizer->key_id != key_id)) {
        stabilizer->initialized = true;
        stabilizer->key_addr = key_addr;
        stabilizer->key_id = key_id;
        stabilizer->candidate_count = 0U;
        stabilizer->stable_distance_mm = measured_distance_mm;
        stabilizer->candidate_distance_mm = measured_distance_mm;
        return measured_distance_mm;
    }

    delta = measured_distance_mm - stabilizer->stable_distance_mm;
    if (fabsf(delta) <= LOCK_DISTANCE_JUMP_THRESHOLD_MM) {
        stabilizer->stable_distance_mm +=
            LOCK_DISTANCE_SMOOTH_ALPHA * delta;
        stabilizer->candidate_count = 0U;
        stabilizer->candidate_distance_mm = measured_distance_mm;
        return stabilizer->stable_distance_mm;
    }

    if ((stabilizer->candidate_count == 0U) ||
        (fabsf(measured_distance_mm -
               stabilizer->candidate_distance_mm) >
         LOCK_DISTANCE_CANDIDATE_TOLERANCE_MM)) {
        stabilizer->candidate_distance_mm = measured_distance_mm;
        stabilizer->candidate_count = 1U;
    } else {
        stabilizer->candidate_distance_mm =
            ((stabilizer->candidate_distance_mm *
              (float)stabilizer->candidate_count) +
             measured_distance_mm) /
            (float)(stabilizer->candidate_count + 1U);
        stabilizer->candidate_count++;
    }

    if (stabilizer->candidate_count >=
        LOCK_DISTANCE_JUMP_CONFIRMATIONS) {
        stabilizer->stable_distance_mm =
            stabilizer->candidate_distance_mm;
        stabilizer->candidate_count = 0U;
    }
    return stabilizer->stable_distance_mm;
}
