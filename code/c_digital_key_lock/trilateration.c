#include "trilateration.h"

#include <math.h>
#include <stddef.h>

static float squaref(float value)
{
    return value * value;
}

static float residual_rms(const LockAnchor2d *anchors, const float *distances_mm,
                          uint8_t count, const LockPoint2f *point)
{
    float sum_sq = 0.0f;
    uint8_t i;

    for (i = 0U; i < count; i++) {
        float dx = point->x_mm - anchors[i].x_mm;
        float dy = point->y_mm - anchors[i].y_mm;
        float predicted = sqrtf(squaref(dx) + squaref(dy));
        float error = predicted - distances_mm[i];
        sum_sq += error * error;
    }

    return sqrtf(sum_sq / (float)count);
}

bool trilateration_solve_three(const LockAnchor2d anchors[3],
                               const float distances_mm[3],
                               TrilaterationResult *result)
{
    float a11 = 2.0f * (anchors[1].x_mm - anchors[0].x_mm);
    float a12 = 2.0f * (anchors[1].y_mm - anchors[0].y_mm);
    float a21 = 2.0f * (anchors[2].x_mm - anchors[0].x_mm);
    float a22 = 2.0f * (anchors[2].y_mm - anchors[0].y_mm);
    float b1 = squaref(distances_mm[0]) - squaref(distances_mm[1]) -
               squaref(anchors[0].x_mm) + squaref(anchors[1].x_mm) -
               squaref(anchors[0].y_mm) + squaref(anchors[1].y_mm);
    float b2 = squaref(distances_mm[0]) - squaref(distances_mm[2]) -
               squaref(anchors[0].x_mm) + squaref(anchors[2].x_mm) -
               squaref(anchors[0].y_mm) + squaref(anchors[2].y_mm);
    float det = (a11 * a22) - (a12 * a21);

    if (fabsf(det) < 1.0e-3f) {
        result->valid = false;
        return false;
    }

    result->point.x_mm = ((b1 * a22) - (a12 * b2)) / det;
    result->point.y_mm = ((a11 * b2) - (b1 * a21)) / det;
    result->residual_mm =
        residual_rms(anchors, distances_mm, 3U, &result->point);
    result->valid = true;
    return true;
}

bool trilateration_solve_two(const LockAnchor2d anchors[2],
                             const float distances_mm[2],
                             const LockPoint2f *hint,
                             TrilaterationResult *result)
{
    float dx = anchors[1].x_mm - anchors[0].x_mm;
    float dy = anchors[1].y_mm - anchors[0].y_mm;
    float base_distance = sqrtf(squaref(dx) + squaref(dy));
    float along;
    float height_sq;
    float height;
    LockPoint2f midpoint;
    LockPoint2f candidate_a;
    LockPoint2f candidate_b;

    if (base_distance < 1.0e-3f) {
        result->valid = false;
        return false;
    }

    along = (squaref(distances_mm[0]) - squaref(distances_mm[1]) +
             squaref(base_distance)) /
            (2.0f * base_distance);
    height_sq = squaref(distances_mm[0]) - squaref(along);
    if (height_sq < 0.0f) {
        height_sq = 0.0f;
    }
    height = sqrtf(height_sq);

    midpoint.x_mm = anchors[0].x_mm + (along * dx / base_distance);
    midpoint.y_mm = anchors[0].y_mm + (along * dy / base_distance);

    candidate_a.x_mm = midpoint.x_mm - (height * dy / base_distance);
    candidate_a.y_mm = midpoint.y_mm + (height * dx / base_distance);
    candidate_b.x_mm = midpoint.x_mm + (height * dy / base_distance);
    candidate_b.y_mm = midpoint.y_mm - (height * dx / base_distance);

    if (hint != NULL) {
        float error_a = squaref(candidate_a.x_mm - hint->x_mm) +
                        squaref(candidate_a.y_mm - hint->y_mm);
        float error_b = squaref(candidate_b.x_mm - hint->x_mm) +
                        squaref(candidate_b.y_mm - hint->y_mm);
        result->point = (error_a <= error_b) ? candidate_a : candidate_b;
    } else {
        result->point = (candidate_a.y_mm >= candidate_b.y_mm) ? candidate_a
                                                                : candidate_b;
    }

    result->residual_mm =
        residual_rms(anchors, distances_mm, 2U, &result->point);
    result->valid = true;
    return true;
}
