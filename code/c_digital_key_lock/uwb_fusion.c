#include "uwb_fusion.h"

#include "two_station_model_data.h"

#include <limits.h>
#include <string.h>

static LockDistanceQuality map_distance_quality(
    UwbDistanceQuality quality)
{
    switch (quality) {
    case UWB_DISTANCE_HIGH:
        return LOCK_DISTANCE_HIGH;
    case UWB_DISTANCE_MEDIUM:
        return LOCK_DISTANCE_MEDIUM;
    case UWB_DISTANCE_REJECT:
    default:
        return LOCK_DISTANCE_REJECT;
    }
}

static void fill_solution_from_result(
    const UwbTwoStationResult *result,
    const LockAppConfig *config,
    LockPositionSolution *solution)
{
    uint8_t channel;

    memset(solution, 0, sizeof(*solution));
    solution->valid = result->distance_valid;
    solution->auth_distance_valid = result->auth_distance_valid;
    solution->held = result->held;
    solution->angle_valid = false;
    solution->angle_auth_valid = false;
    solution->key_id_valid = result->target_address_valid;
    solution->key_addr = result->target_address;
    solution->key_id =
        (uint8_t)(result->target_address & 0x0FU);
    solution->valid_mask = result->valid_mask;
    solution->anchor_count =
        (result->valid_mask == 0x03U) ? LOCK_UWB_CHANNEL_COUNT : 0U;
    solution->distance_quality =
        map_distance_quality(result->distance_quality);
    solution->updated_ms = result->updated_ms;
    solution->radial_mm = (float)result->distance_mm;
    solution->radius_from_origin_mm =
        solution->radial_mm + config->radial_zero_offset_mm;
    solution->bearing_deg =
        (result->angle_candidate_1_deg ==
         UWB_TWO_STATION_INVALID_ANGLE_DEG)
            ? 0.0f
            : (float)result->angle_candidate_1_deg;
    solution->residual_mm = (float)result->neighbor_span_mm;
    solution->angle_candidate_1_deg = result->angle_candidate_1_deg;
    solution->angle_candidate_2_deg = result->angle_candidate_2_deg;
    solution->angle_confidence = result->angle_confidence;
    solution->angle_candidate_1_weight =
        result->angle_candidate_1_weight;
    solution->angle_candidate_2_weight =
        result->angle_candidate_2_weight;
    solution->angle_candidate_span_deg =
        result->angle_candidate_span_deg;
    solution->age_ms = result->age_ms;
    solution->model_version = result->model_version;
    solution->model_bytes = result->model_bytes;
    solution->model_crc32 = result->model_crc32;
    solution->failure_flags = result->failure_flags;
    solution->mode =
        result->held
            ? LOCK_LOCALIZATION_HOLD
            : (result->distance_valid
                   ? LOCK_LOCALIZATION_TWO_STATION_EMPIRICAL
                   : LOCK_LOCALIZATION_NONE);
    for (channel = 0U; channel < LOCK_UWB_CHANNEL_COUNT; channel++) {
        solution->sample_count[channel] = result->sample_count[channel];
        solution->mad_mm[channel] = result->mad_mm[channel];
        solution->snr_db[channel] = result->snr_db[channel];
    }
}

void uwb_fusion_init(LockUwbFusion *fusion)
{
    memset(fusion, 0, sizeof(*fusion));
    (void)uwb_two_station_estimator_init(
        &fusion->estimator, &g_two_station_model_20260731);
}

void uwb_fusion_store_measurement(LockUwbFusion *fusion, uint8_t channel,
                                  const LockUwbMeasurement *measurement)
{
    UwbTwoStationSample sample;

    if ((fusion == NULL) || (measurement == NULL) ||
        !measurement->valid || (channel >= LOCK_UWB_CHANNEL_COUNT) ||
        (measurement->distance_mm > UINT16_MAX)) {
        return;
    }

    memset(&sample, 0, sizeof(sample));
    sample.range_mm = (uint16_t)measurement->distance_mm;
    sample.station_address =
        measurement->station_addr_valid
            ? measurement->station_addr
            : fusion->estimator.model->station_address[channel];
    sample.target_address = measurement->key_addr;
    sample.target_address_valid = measurement->key_addr_valid;
    sample.snr_db = measurement->snr_db;
    sample.snr_valid = measurement->snr_valid;
    sample.timestamp_ms = measurement->timestamp_ms;
    if (uwb_two_station_estimator_push(
            &fusion->estimator, channel, &sample)) {
        fusion->latest_measurement[channel] = *measurement;
        fusion->latest_valid[channel] = true;
    }
}

void uwb_fusion_solve(LockUwbFusion *fusion, const LockAppConfig *config,
                      uint32_t now_ms, LockPositionSolution *solution)
{
    UwbTwoStationResult result;

    if ((fusion == NULL) || (config == NULL) || (solution == NULL)) {
        return;
    }

    if (!uwb_two_station_estimator_update(
            &fusion->estimator, now_ms, &result)) {
        const UwbTwoStationResult *current =
            uwb_two_station_estimator_result(&fusion->estimator);

        if (current == NULL) {
            memset(solution, 0, sizeof(*solution));
            return;
        }
        result = *current;
    }

    fill_solution_from_result(&result, config, solution);
    fusion->last_solution = *solution;
}

void uwb_fusion_report_failure(LockUwbFusion *fusion,
                               uint32_t failure_flags)
{
    if (fusion != NULL) {
        uwb_two_station_estimator_report_failure(
            &fusion->estimator, failure_flags);
    }
}
