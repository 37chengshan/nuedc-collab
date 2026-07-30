#include "uwb_fusion.h"

#include <math.h>
#include <string.h>

static uint32_t elapsed_ms(uint32_t since_ms, uint32_t now_ms)
{
    return now_ms - since_ms;
}

static bool sample_is_fresh(const LockUwbMeasurement *measurement,
                            uint32_t now_ms, uint32_t window_ms)
{
    return measurement->valid &&
           (elapsed_ms(measurement->timestamp_ms, now_ms) <= window_ms);
}

static void fill_solution_metrics(LockPositionSolution *solution,
                                  const LockAppConfig *config)
{
    solution->radius_from_origin_mm =
        sqrtf((solution->x_mm * solution->x_mm) +
              (solution->y_mm * solution->y_mm));
    solution->radial_mm =
        solution->radius_from_origin_mm - config->radial_zero_offset_mm;
    if (solution->radial_mm < 0.0f) {
        solution->radial_mm = 0.0f;
    }
    solution->bearing_deg =
        atan2f(solution->x_mm, solution->y_mm) * (180.0f / 3.14159265358979323846f);
}

void uwb_fusion_init(LockUwbFusion *fusion)
{
    memset(fusion, 0, sizeof(*fusion));
}

void uwb_fusion_store_measurement(LockUwbFusion *fusion, uint8_t channel,
                                  const LockUwbMeasurement *measurement)
{
    if (channel >= LOCK_UWB_CHANNEL_COUNT) {
        return;
    }

    fusion->channels[channel].occupied = measurement->valid;
    fusion->channels[channel].measurement = *measurement;
}

void uwb_fusion_solve(LockUwbFusion *fusion, const LockAppConfig *config,
                      uint32_t now_ms, LockPositionSolution *solution)
{
    const LockUwbMeasurement *newest = NULL;
    LockAnchor2d anchors[LOCK_UWB_CHANNEL_COUNT];
    float distances_mm[LOCK_UWB_CHANNEL_COUNT];
    LockPoint2f hint;
    uint8_t valid_mask = 0U;
    uint8_t count = 0U;
    uint8_t channel;
    TrilaterationResult result;

    memset(solution, 0, sizeof(*solution));

    for (channel = 0U; channel < LOCK_UWB_CHANNEL_COUNT; channel++) {
        const LockUwbChannelCache *cache = &fusion->channels[channel];

        if (!cache->occupied) {
            continue;
        }
        if (!sample_is_fresh(&cache->measurement, now_ms,
                             config->sample_window_ms)) {
            continue;
        }
        if ((newest == NULL) ||
            (cache->measurement.timestamp_ms > newest->timestamp_ms)) {
            newest = &cache->measurement;
        }
    }

    if (newest == NULL) {
        return;
    }

    for (channel = 0U; channel < LOCK_UWB_CHANNEL_COUNT; channel++) {
        const LockUwbChannelCache *cache = &fusion->channels[channel];

        if (!cache->occupied) {
            continue;
        }
        if (!sample_is_fresh(&cache->measurement, now_ms,
                             config->sample_window_ms)) {
            continue;
        }
        if (cache->measurement.key_addr != newest->key_addr) {
            continue;
        }

        anchors[count] = config->anchors[channel];
        distances_mm[count] = (float)cache->measurement.distance_mm;
        valid_mask |= (uint8_t)(1U << channel);
        count++;
    }

    if (count >= 3U) {
        if (!trilateration_solve_three(anchors, distances_mm, &result)) {
            return;
        }
        solution->mode = LOCK_LOCALIZATION_THREE_ANCHOR;
    } else if (count == 2U) {
        LockPoint2f *hint_ptr = NULL;

        if (fusion->last_solution.valid &&
            (fusion->last_solution.key_addr == newest->key_addr)) {
            hint.x_mm = fusion->last_solution.x_mm;
            hint.y_mm = fusion->last_solution.y_mm;
            hint_ptr = &hint;
        }
        if (!trilateration_solve_two(anchors, distances_mm, hint_ptr,
                                     &result)) {
            return;
        }
        solution->mode = LOCK_LOCALIZATION_TWO_ANCHOR;
    } else if ((count == 1U) && fusion->last_solution.valid &&
               (fusion->last_solution.key_addr == newest->key_addr) &&
               (elapsed_ms(fusion->last_solution.updated_ms, now_ms) <=
                config->solution_hold_ms)) {
        *solution = fusion->last_solution;
        solution->valid_mask = valid_mask;
        solution->anchor_count = 1U;
        solution->mode = LOCK_LOCALIZATION_HOLD;
        solution->updated_ms = now_ms;
        fusion->last_solution = *solution;
        return;
    } else {
        return;
    }

    solution->valid = true;
    solution->key_addr = newest->key_addr;
    solution->key_id = newest->key_id;
    solution->valid_mask = valid_mask;
    solution->anchor_count = count;
    solution->updated_ms = now_ms;
    solution->x_mm = result.point.x_mm;
    solution->y_mm = result.point.y_mm;
    solution->residual_mm = result.residual_mm;
    fill_solution_metrics(solution, config);
    fusion->last_solution = *solution;
}
