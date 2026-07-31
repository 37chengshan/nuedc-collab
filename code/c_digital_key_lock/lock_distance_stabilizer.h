#ifndef LOCK_DISTANCE_STABILIZER_H
#define LOCK_DISTANCE_STABILIZER_H

#include <stdbool.h>
#include <stdint.h>

typedef struct {
    bool initialized;
    uint16_t key_addr;
    uint8_t key_id;
    uint8_t candidate_count;
    float stable_distance_mm;
    float candidate_distance_mm;
} LockDistanceStabilizer;

void lock_distance_stabilizer_reset(LockDistanceStabilizer *stabilizer);
float lock_distance_stabilizer_update(LockDistanceStabilizer *stabilizer,
                                      uint16_t key_addr, uint8_t key_id,
                                      float measured_distance_mm);

#endif
