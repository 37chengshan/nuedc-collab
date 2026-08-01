#include "uwb_fusion.h"

#include "four_station_model_data.h"

#include <limits.h>
#include <math.h>
#include <string.h>

static LockDistanceQuality map_quality(UwbFourDistanceQuality quality)
{
    switch (quality) {
    case UWB_FOUR_DISTANCE_HIGH:
        return LOCK_DISTANCE_HIGH;
    case UWB_FOUR_DISTANCE_MEDIUM:
        return LOCK_DISTANCE_MEDIUM;
    case UWB_FOUR_DISTANCE_REJECT:
    default:
        return LOCK_DISTANCE_REJECT;
    }
}

static uint8_t map_tag_address_to_id(uint16_t address)
{
    if ((address >= 0x000AU) && (address <= 0x0013U)) {
        return (uint8_t)((address - 0x000AU) + 1U);
    }
    return (uint8_t)(address & 0x0FU);
}

static void fill_solution(const UwbFourStationResult *result,
                          const LockAppConfig *config,
                          LockPositionSolution *solution)
{
    float radians;

    memset(solution, 0, sizeof(*solution));
    solution->valid = result->distance_valid;
    solution->auth_distance_valid = result->auth_distance_valid;
    solution->angle_valid = result->angle_valid;
    /*
     * The display must continue showing the measured angle even when the
     * angle-quality gate disallows authorization. angle_held is therefore
     * also the "diagnostic angle available" bit for this four-station model.
     */
    solution->angle_held = result->distance_valid || result->held;
    solution->key_addr = config->configured_tag_address;
    solution->key_id =
        map_tag_address_to_id(config->configured_tag_address);
    solution->valid_mask = result->valid_mask;
    solution->anchor_count =
        (result->valid_mask == 0x0FU) ? 4U : 0U;
    solution->distance_quality = map_quality(result->distance_quality);
    solution->updated_ms = result->updated_ms;
    solution->radius_from_origin_mm =
        (float)result->center_distance_mm;
    solution->boundary_distance_mm =
        (float)result->boundary_distance_mm;
    solution->radial_mm = solution->boundary_distance_mm;
    /*
     * The fitted model was generated in the acquisition-camera convention,
     * whose horizontal sign is opposite to the installed lock's front view.
     * Convert once at the public solution boundary so the UI convention is:
     * looking toward 0 degrees, right is positive and left is negative.
     */
    solution->bearing_deg =
        -(float)result->angle_deg_x10 / 10.0f;
    radians =
        solution->bearing_deg * (3.14159265358979323846f / 180.0f);
    solution->x_mm =
        solution->radius_from_origin_mm * sinf(radians);
    solution->y_mm =
        solution->radius_from_origin_mm * cosf(radians);
    solution->raw_x_mm = solution->x_mm;
    solution->raw_y_mm = solution->y_mm;
    solution->distance_confidence =
        (result->distance_quality == UWB_FOUR_DISTANCE_HIGH)
            ? 1.0f
            : (result->distance_quality == UWB_FOUR_DISTANCE_MEDIUM)
                  ? 0.5f
                  : 0.0f;
    solution->angle_confidence =
        (float)result->angle_confidence / 100.0f;
    solution->residual_mm = (float)result->neighbor_span_mm;
    solution->mode =
        result->held ? LOCK_LOCALIZATION_HOLD
                     : (result->distance_valid
                            ? LOCK_LOCALIZATION_FOUR_ANCHOR
                            : LOCK_LOCALIZATION_NONE);
}

void uwb_fusion_init(LockUwbFusion *fusion)
{
    memset(fusion, 0, sizeof(*fusion));
    (void)uwb_four_station_estimator_init(
        &fusion->estimator, &g_four_station_model_20260801);
}

void uwb_fusion_init_with_model(LockUwbFusion *fusion,
                                const CalibrationModelV1 *model)
{
    (void)model;
    uwb_fusion_init(fusion);
}

void uwb_fusion_init_with_models(LockUwbFusion *fusion,
                                 const CalibrationModelV1 *calibration_model,
                                 const EmpiricalModelV1 *empirical_model)
{
    (void)calibration_model;
    (void)empirical_model;
    uwb_fusion_init(fusion);
}

void uwb_fusion_store_measurement(LockUwbFusion *fusion, uint8_t channel,
                                  const LockUwbMeasurement *measurement)
{
    UwbFourStationSample sample;

    if ((fusion == NULL) || (measurement == NULL) ||
        !measurement->valid || (channel >= LOCK_UWB_CHANNEL_COUNT)) {
        return;
    }
    fusion->channels[channel].occupied = true;
    fusion->channels[channel].measurement = *measurement;
    fusion->latest_measurement[channel] = *measurement;
    fusion->latest_valid[channel] = true;
    if ((measurement->distance_mm == 0U) ||
        (measurement->distance_mm > UINT16_MAX)) {
        return;
    }

    memset(&sample, 0, sizeof(sample));
    sample.range_mm = (uint16_t)measurement->distance_mm;
    /*
     * The physical UART is the station identity. Some responder firmware
     * reports the moving-key address instead of its own station address, so
     * rejecting that frame would hide localization while raw A/B/C/D values
     * remain visible. Bind the station to the verified wiring map here.
     */
    sample.station_address =
        fusion->estimator.model->station_address[channel];
    sample.target_address = 0x000AU;
    sample.target_address_valid = true;
    sample.timestamp_ms = measurement->timestamp_ms;
    (void)uwb_four_station_estimator_push(
        &fusion->estimator, channel, &sample);
}

void uwb_fusion_solve(LockUwbFusion *fusion, const LockAppConfig *config,
                      uint32_t now_ms, LockPositionSolution *solution)
{
    UwbFourStationResult result;

    if ((fusion == NULL) || (config == NULL) || (solution == NULL)) {
        return;
    }
    if (!uwb_four_station_estimator_update(
            &fusion->estimator, now_ms, &result)) {
        const UwbFourStationResult *current =
            uwb_four_station_estimator_result(&fusion->estimator);

        if (current == NULL) {
            memset(solution, 0, sizeof(*solution));
            return;
        }
        result = *current;
    }
    fill_solution(&result, config, solution);
    fusion->last_solution = *solution;
}
