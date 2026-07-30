#ifndef TRILATERATION_H
#define TRILATERATION_H

#include "lock_types.h"

typedef struct {
    bool valid;
    LockPoint2f point;
    float residual_mm;
    uint8_t used_count;
    uint8_t used_mask;
    uint8_t rejected_mask;
    uint8_t iterations;
} TrilaterationResult;

bool trilateration_solve_robust(const LockAnchor2d *anchors,
                                const float *distances_mm, uint8_t count,
                                const LockPoint2f *hint,
                                float nlos_threshold_mm,
                                TrilaterationResult *result);
bool trilateration_solve_three(const LockAnchor2d anchors[3],
                               const float distances_mm[3],
                               TrilaterationResult *result);
bool trilateration_solve_two(const LockAnchor2d anchors[2],
                             const float distances_mm[2],
                             const LockPoint2f *hint,
                             TrilaterationResult *result);

#endif
