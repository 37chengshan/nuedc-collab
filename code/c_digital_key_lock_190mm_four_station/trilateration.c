#include "trilateration.h"

#include <math.h>
#include <stddef.h>
#include <string.h>

static float squaref(float value)
{
    return value * value;
}

static float predicted_distance(const LockAnchor2d *anchor,
                                const LockPoint2f *point)
{
    return sqrtf(squaref(point->x_mm - anchor->x_mm) +
                 squaref(point->y_mm - anchor->y_mm));
}

static float residual_rms_mask(const LockAnchor2d *anchors,
                               const float *distances_mm, uint8_t count,
                               uint8_t active_mask,
                               const LockPoint2f *point)
{
    float sum_sq = 0.0f;
    uint8_t used_count = 0U;
    uint8_t i;

    for (i = 0U; i < count; i++) {
        float error;

        if ((active_mask & (uint8_t)(1U << i)) == 0U) {
            continue;
        }
        error = predicted_distance(&anchors[i], point) - distances_mm[i];
        sum_sq += error * error;
        used_count++;
    }

    return (used_count == 0U) ? 0.0f
                              : sqrtf(sum_sq / (float)used_count);
}

static uint8_t population_count(uint8_t value)
{
    uint8_t count = 0U;

    while (value != 0U) {
        count = (uint8_t)(count + (value & 1U));
        value >>= 1U;
    }
    return count;
}

static bool linear_initial_guess(const LockAnchor2d *anchors,
                                 const float *distances_mm, uint8_t count,
                                 uint8_t active_mask, LockPoint2f *point)
{
    uint8_t reference = 0xFFU;
    uint8_t index;
    float normal00 = 0.0f;
    float normal01 = 0.0f;
    float normal11 = 0.0f;
    float rhs0 = 0.0f;
    float rhs1 = 0.0f;
    float determinant;

    for (index = 0U; index < count; index++) {
        if ((active_mask & (uint8_t)(1U << index)) != 0U) {
            reference = index;
            break;
        }
    }
    if (reference == 0xFFU) {
        return false;
    }

    for (index = (uint8_t)(reference + 1U); index < count; index++) {
        float a0;
        float a1;
        float rhs;

        if ((active_mask & (uint8_t)(1U << index)) == 0U) {
            continue;
        }
        a0 = 2.0f * (anchors[index].x_mm - anchors[reference].x_mm);
        a1 = 2.0f * (anchors[index].y_mm - anchors[reference].y_mm);
        rhs = squaref(distances_mm[reference]) -
              squaref(distances_mm[index]) -
              squaref(anchors[reference].x_mm) +
              squaref(anchors[index].x_mm) -
              squaref(anchors[reference].y_mm) +
              squaref(anchors[index].y_mm);
        normal00 += a0 * a0;
        normal01 += a0 * a1;
        normal11 += a1 * a1;
        rhs0 += a0 * rhs;
        rhs1 += a1 * rhs;
    }

    determinant = (normal00 * normal11) - (normal01 * normal01);
    if (fabsf(determinant) < 1.0e-6f) {
        return false;
    }
    point->x_mm =
        ((rhs0 * normal11) - (normal01 * rhs1)) / determinant;
    point->y_mm =
        ((normal00 * rhs1) - (rhs0 * normal01)) / determinant;
    return isfinite(point->x_mm) && isfinite(point->y_mm);
}

static bool solve_gauss_newton(const LockAnchor2d *anchors,
                               const float *distances_mm, uint8_t count,
                               uint8_t active_mask, const LockPoint2f *hint,
                               float huber_delta_mm,
                               TrilaterationResult *result)
{
    LockPoint2f point;
    uint8_t iteration;

    if (population_count(active_mask) < 3U) {
        return false;
    }
    if (hint != NULL) {
        point = *hint;
    } else if (!linear_initial_guess(anchors, distances_mm, count,
                                     active_mask, &point)) {
        return false;
    }

    for (iteration = 0U; iteration < 5U; iteration++) {
        float h00 = 0.01f;
        float h01 = 0.0f;
        float h11 = 0.01f;
        float gradient0 = 0.0f;
        float gradient1 = 0.0f;
        float determinant;
        float step_x;
        float step_y;
        float step_length;
        uint8_t index;

        for (index = 0U; index < count; index++) {
            float dx;
            float dy;
            float predicted;
            float residual;
            float absolute_residual;
            float weight;
            float jacobian_x;
            float jacobian_y;

            if ((active_mask & (uint8_t)(1U << index)) == 0U) {
                continue;
            }
            dx = point.x_mm - anchors[index].x_mm;
            dy = point.y_mm - anchors[index].y_mm;
            predicted = sqrtf((dx * dx) + (dy * dy));
            if (predicted < 1.0e-3f) {
                predicted = 1.0e-3f;
            }
            residual = predicted - distances_mm[index];
            absolute_residual = fabsf(residual);
            weight = (absolute_residual <= huber_delta_mm)
                         ? 1.0f
                         : (huber_delta_mm / absolute_residual);
            jacobian_x = dx / predicted;
            jacobian_y = dy / predicted;
            h00 += weight * jacobian_x * jacobian_x;
            h01 += weight * jacobian_x * jacobian_y;
            h11 += weight * jacobian_y * jacobian_y;
            gradient0 += weight * jacobian_x * residual;
            gradient1 += weight * jacobian_y * residual;
        }

        determinant = (h00 * h11) - (h01 * h01);
        if (fabsf(determinant) < 1.0e-8f) {
            return false;
        }
        step_x =
            -((h11 * gradient0) - (h01 * gradient1)) / determinant;
        step_y =
            -((-h01 * gradient0) + (h00 * gradient1)) / determinant;
        step_length = sqrtf((step_x * step_x) + (step_y * step_y));
        if (step_length > 500.0f) {
            float scale = 500.0f / step_length;
            step_x *= scale;
            step_y *= scale;
            step_length = 500.0f;
        }
        point.x_mm += step_x;
        point.y_mm += step_y;
        if (step_length < 1.0f) {
            iteration++;
            break;
        }
    }

    if (!isfinite(point.x_mm) || !isfinite(point.y_mm)) {
        return false;
    }
    memset(result, 0, sizeof(*result));
    result->valid = true;
    result->point = point;
    result->residual_mm =
        residual_rms_mask(anchors, distances_mm, count, active_mask, &point);
    result->used_count = population_count(active_mask);
    result->used_mask = active_mask;
    result->rejected_mask =
        (uint8_t)(((1U << count) - 1U) & (uint8_t)~active_mask);
    result->iterations = iteration;
    return true;
}

static bool solve_pair_mask(const LockAnchor2d *anchors,
                            const float *distances_mm, uint8_t count,
                            uint8_t active_mask, const LockPoint2f *hint,
                            TrilaterationResult *result)
{
    LockAnchor2d pair_anchors[2];
    float pair_distances[2];
    uint8_t pair_indices[2];
    uint8_t pair_count = 0U;
    uint8_t index;
    TrilaterationResult pair_result;

    for (index = 0U; index < count; index++) {
        if ((active_mask & (uint8_t)(1U << index)) != 0U) {
            if (pair_count >= 2U) {
                return false;
            }
            pair_anchors[pair_count] = anchors[index];
            pair_distances[pair_count] = distances_mm[index];
            pair_indices[pair_count] = index;
            pair_count++;
        }
    }
    if ((pair_count != 2U) ||
        !trilateration_solve_two(pair_anchors, pair_distances, hint,
                                 &pair_result)) {
        return false;
    }

    *result = pair_result;
    result->used_count = 2U;
    result->used_mask = (uint8_t)((1U << pair_indices[0]) |
                                  (1U << pair_indices[1]));
    result->rejected_mask =
        (uint8_t)(((1U << count) - 1U) & (uint8_t)~result->used_mask);
    result->residual_mm = residual_rms_mask(
        anchors, distances_mm, count, result->used_mask, &result->point);
    return true;
}

bool trilateration_solve_three(const LockAnchor2d anchors[3],
                               const float distances_mm[3],
                               TrilaterationResult *result)
{
    return solve_gauss_newton(anchors, distances_mm, 3U, 0x07U, NULL,
                              150.0f, result);
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

    if ((candidate_a.y_mm >= 0.0f) != (candidate_b.y_mm >= 0.0f)) {
        result->point =
            (candidate_a.y_mm >= 0.0f) ? candidate_a : candidate_b;
    } else if (hint != NULL) {
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
        residual_rms_mask(anchors, distances_mm, 2U, 0x03U,
                          &result->point);
    result->valid = true;
    result->used_count = 2U;
    result->used_mask = 0x03U;
    result->rejected_mask = 0U;
    result->iterations = 0U;
    return true;
}

bool trilateration_solve_robust(const LockAnchor2d *anchors,
                                const float *distances_mm, uint8_t count,
                                const LockPoint2f *hint,
                                float nlos_threshold_mm,
                                TrilaterationResult *result)
{
    uint8_t all_mask;
    TrilaterationResult full_result;
    float huber_delta_mm;

    if ((anchors == NULL) || (distances_mm == NULL) || (result == NULL) ||
        (count < 2U) || (count > LOCK_UWB_CHANNEL_COUNT) ||
        !isfinite(nlos_threshold_mm) || (nlos_threshold_mm <= 0.0f)) {
        return false;
    }
    all_mask = (uint8_t)((1U << count) - 1U);
    huber_delta_mm = fminf(nlos_threshold_mm, 150.0f);

    if (count == 2U) {
        return solve_pair_mask(anchors, distances_mm, count, all_mask, hint,
                               result);
    }
    if (!solve_gauss_newton(anchors, distances_mm, count, all_mask, hint,
                            huber_delta_mm, &full_result)) {
        return false;
    }

    if (count == 3U) {
        float largest_residual = 0.0f;
        uint8_t largest_index = 0U;
        uint8_t index;

        for (index = 0U; index < count; index++) {
            float residual =
                fabsf(predicted_distance(&anchors[index],
                                         &full_result.point) -
                      distances_mm[index]);
            if (residual > largest_residual) {
                largest_residual = residual;
                largest_index = index;
            }
        }
        if (largest_residual > nlos_threshold_mm) {
            TrilaterationResult best_pair;
            float best_hint_error = INFINITY;
            bool found = false;

            for (index = 0U; index < count; index++) {
                TrilaterationResult candidate;
                uint8_t pair_mask =
                    (uint8_t)(all_mask & (uint8_t)~(1U << index));
                float hint_error;

                if (!solve_pair_mask(anchors, distances_mm, count, pair_mask,
                                     hint, &candidate)) {
                    continue;
                }
                if (hint != NULL) {
                    hint_error =
                        squaref(candidate.point.x_mm - hint->x_mm) +
                        squaref(candidate.point.y_mm - hint->y_mm);
                } else {
                    float excluded_residual =
                        fabsf(predicted_distance(&anchors[index],
                                                 &candidate.point) -
                              distances_mm[index]);
                    hint_error = excluded_residual;
                    if (index == largest_index) {
                        hint_error *= 0.5f;
                    }
                }
                if (!found || (hint_error < best_hint_error)) {
                    best_hint_error = hint_error;
                    best_pair = candidate;
                    found = true;
                }
            }
            if (found) {
                *result = best_pair;
                return true;
            }
        }
        *result = full_result;
        return true;
    }

    if (count == 4U) {
        TrilaterationResult best_subset;
        float best_subset_rms = INFINITY;
        float best_excluded_residual = 0.0f;
        bool found = false;
        uint8_t excluded;

        for (excluded = 0U; excluded < count; excluded++) {
            uint8_t subset_mask =
                (uint8_t)(all_mask & (uint8_t)~(1U << excluded));
            TrilaterationResult candidate;
            float excluded_residual;

            if (!solve_gauss_newton(anchors, distances_mm, count,
                                    subset_mask, hint, huber_delta_mm,
                                    &candidate)) {
                continue;
            }
            excluded_residual =
                fabsf(predicted_distance(&anchors[excluded],
                                         &candidate.point) -
                      distances_mm[excluded]);
            if (!found || (candidate.residual_mm < best_subset_rms)) {
                best_subset = candidate;
                best_subset_rms = candidate.residual_mm;
                best_excluded_residual = excluded_residual;
                found = true;
            }
        }
        if (found && (best_excluded_residual > nlos_threshold_mm) &&
            ((best_subset_rms + 1.0f) <
             (full_result.residual_mm * 0.75f))) {
            *result = best_subset;
            return true;
        }
        *result = full_result;
        return true;
    }

    return false;
}
