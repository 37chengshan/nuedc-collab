#ifndef TRILATERATION_H
#define TRILATERATION_H

#include "lock_types.h"

typedef struct {
    bool valid;
    LockPoint2f point;
    float residual_mm;
} TrilaterationResult;

bool trilateration_solve_three(const LockAnchor2d anchors[3],
                               const float distances_mm[3],
                               TrilaterationResult *result);
bool trilateration_solve_two(const LockAnchor2d anchors[2],
                             const float distances_mm[2],
                             const LockPoint2f *hint,
                             TrilaterationResult *result);

#endif
