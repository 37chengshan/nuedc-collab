#include "uwb_two_station_estimator.h"

#include <limits.h>
#include <stddef.h>
#include <string.h>

#define UWB_TWO_STATION_MIN_RANGE_MM 300U
#define UWB_TWO_STATION_MAX_RANGE_MM 5000U
#define UWB_TWO_STATION_HIGH_MIN_SAMPLES 6U
#define UWB_TWO_STATION_MEDIUM_MIN_SAMPLES 5U
#define UWB_TWO_STATION_HIGH_MAX_MAD_MM 50U
#define UWB_TWO_STATION_MEDIUM_MAX_MAD_MM 100U
#define UWB_TWO_STATION_HIGH_MIN_LEFT_SNR_DB (-5)
#define UWB_TWO_STATION_MEDIUM_MIN_LEFT_SNR_DB (-6)
#define UWB_TWO_STATION_HIGH_MAX_FEATURE_DELTA_MM 300U
#define UWB_TWO_STATION_MEDIUM_MAX_FEATURE_DELTA_MM 500U
#define UWB_TWO_STATION_MAX_NEIGHBOR_SPAN_MM 400U
#define UWB_TWO_STATION_MAX_STABILITY_SPAN_MM 150U
#define UWB_TWO_STATION_Q24_ONE 16777216UL
#define UWB_TWO_STATION_WEIGHT_NUMERATOR (1ULL << 40)

typedef struct {
    uint32_t q_q24;
    uint16_t prototype_index;
} Neighbor;

static uint32_t elapsed_ms(uint32_t since_ms, uint32_t now_ms)
{
    return now_ms - since_ms;
}

static uint32_t crc32_byte(uint32_t crc, uint8_t value)
{
    uint8_t bit;

    crc ^= value;
    for (bit = 0U; bit < 8U; bit++) {
        crc = (crc >> 1U) ^
              (((crc & 1U) != 0U) ? 0xEDB88320UL : 0UL);
    }
    return crc;
}

static uint32_t crc32_u16(uint32_t crc, uint16_t value)
{
    crc = crc32_byte(crc, (uint8_t)value);
    return crc32_byte(crc, (uint8_t)(value >> 8U));
}

static uint32_t crc32_u32(uint32_t crc, uint32_t value)
{
    crc = crc32_byte(crc, (uint8_t)value);
    crc = crc32_byte(crc, (uint8_t)(value >> 8U));
    crc = crc32_byte(crc, (uint8_t)(value >> 16U));
    return crc32_byte(crc, (uint8_t)(value >> 24U));
}

uint32_t uwb_two_station_model_compute_crc32(
    const UwbTwoStationModel *model)
{
    uint32_t crc = 0xFFFFFFFFUL;
    uint16_t index;

    if ((model == NULL) || (model->prototypes == NULL) ||
        (model->prototype_count !=
         UWB_TWO_STATION_EXPECTED_PROTOTYPES) ||
        (model->serialized_bytes !=
         UWB_TWO_STATION_MODEL_SERIALIZED_BYTES)) {
        return 0U;
    }

    crc = crc32_u32(crc, model->magic);
    crc = crc32_u16(crc, model->version);
    crc = crc32_u16(crc, model->prototype_count);
    crc = crc32_u16(crc, model->station_address[UWB_TWO_STATION_RIGHT]);
    crc = crc32_u16(crc, model->station_address[UWB_TWO_STATION_LEFT]);
    crc = crc32_u16(crc, model->window_ms);
    crc = crc32_u16(crc, model->pair_skew_ms);
    crc = crc32_u16(crc, model->update_period_ms);
    crc = crc32_u16(crc, model->hold_ms);
    crc = crc32_u32(crc, model->scale_right_q16);
    crc = crc32_u32(crc, model->scale_left_q16);
    crc = crc32_u32(crc, model->q_floor_q24);
    crc = crc32_u32(crc, model->high_nearest_q24);
    crc = crc32_u16(crc, model->minimum_distance_mm);
    crc = crc32_u16(crc, model->maximum_distance_mm);

    for (index = 0U; index < model->prototype_count; index++) {
        const UwbTwoStationPrototype *prototype =
            &model->prototypes[index];

        crc = crc32_u16(crc, prototype->right_mm);
        crc = crc32_u16(crc, prototype->left_mm);
        crc = crc32_u16(crc, prototype->distance_mm);
        crc = crc32_byte(crc, (uint8_t)prototype->angle_deg);
        crc = crc32_byte(crc, prototype->reserved);
    }

    return crc ^ 0xFFFFFFFFUL;
}

bool uwb_two_station_model_is_valid(const UwbTwoStationModel *model)
{
    if ((model == NULL) || (model->magic != UWB_TWO_STATION_MODEL_MAGIC) ||
        (model->version != UWB_TWO_STATION_MODEL_VERSION) ||
        (model->prototypes == NULL) ||
        (model->prototype_count !=
         UWB_TWO_STATION_EXPECTED_PROTOTYPES) ||
        (model->serialized_bytes !=
         UWB_TWO_STATION_MODEL_SERIALIZED_BYTES) ||
        (model->window_ms == 0U) || (model->update_period_ms == 0U) ||
        (model->scale_right_q16 == 0U) ||
        (model->scale_left_q16 == 0U) || (model->q_floor_q24 == 0U) ||
        (model->minimum_distance_mm >= model->maximum_distance_mm)) {
        return false;
    }

    return model->crc32 == uwb_two_station_model_compute_crc32(model);
}

static void sort_u16(uint16_t *values, uint8_t count)
{
    uint8_t index;

    for (index = 1U; index < count; index++) {
        uint16_t value = values[index];
        uint8_t cursor = index;

        while ((cursor > 0U) && (values[cursor - 1U] > value)) {
            values[cursor] = values[cursor - 1U];
            cursor--;
        }
        values[cursor] = value;
    }
}

static void sort_i16(int16_t *values, uint8_t count)
{
    uint8_t index;

    for (index = 1U; index < count; index++) {
        int16_t value = values[index];
        uint8_t cursor = index;

        while ((cursor > 0U) && (values[cursor - 1U] > value)) {
            values[cursor] = values[cursor - 1U];
            cursor--;
        }
        values[cursor] = value;
    }
}

static uint16_t median_u16(const uint16_t *sorted, uint8_t count)
{
    uint8_t middle = (uint8_t)(count / 2U);

    if ((count & 1U) != 0U) {
        return sorted[middle];
    }
    return (uint16_t)(((uint32_t)sorted[middle - 1U] +
                       (uint32_t)sorted[middle]) /
                      2U);
}

static int16_t median_i16(const int16_t *sorted, uint8_t count)
{
    uint8_t middle = (uint8_t)(count / 2U);

    if ((count & 1U) != 0U) {
        return sorted[middle];
    }
    return (int16_t)(((int32_t)sorted[middle - 1U] +
                      (int32_t)sorted[middle]) /
                     2);
}

static bool collect_link_stats(const UwbTwoStationEstimator *estimator,
                               uint8_t station, uint32_t now_ms,
                               UwbTwoStationLinkStats *stats)
{
    const UwbTwoStationHistory *history = &estimator->history[station];
    uint16_t ranges[UWB_TWO_STATION_HISTORY_CAPACITY];
    uint16_t deviations[UWB_TWO_STATION_HISTORY_CAPACITY];
    int16_t snr_values[UWB_TWO_STATION_HISTORY_CAPACITY];
    uint8_t range_count = 0U;
    uint8_t snr_count = 0U;
    uint32_t latest_age = UINT32_MAX;
    uint8_t index;
    uint16_t center;

    memset(stats, 0, sizeof(*stats));
    for (index = 0U; index < history->count; index++) {
        const UwbTwoStationSample *sample = &history->samples[index];
        uint32_t age = elapsed_ms(sample->timestamp_ms, now_ms);

        if (age > estimator->model->window_ms) {
            continue;
        }
        ranges[range_count++] = sample->range_mm;
        if (sample->snr_valid) {
            snr_values[snr_count++] = sample->snr_db;
        }
        if (age < latest_age) {
            latest_age = age;
            stats->latest_timestamp_ms = sample->timestamp_ms;
            stats->station_address = sample->station_address;
            stats->target_address = sample->target_address;
            stats->target_address_valid =
                sample->target_address_valid;
        }
    }

    if (range_count < 3U) {
        stats->sample_count = range_count;
        return false;
    }

    sort_u16(ranges, range_count);
    stats->feature_mm =
        (uint16_t)(((uint32_t)ranges[0] + (uint32_t)ranges[1] +
                    (uint32_t)ranges[2] + 1U) /
                   3U);
    center = median_u16(ranges, range_count);
    for (index = 0U; index < range_count; index++) {
        deviations[index] = (ranges[index] >= center)
                                ? (uint16_t)(ranges[index] - center)
                                : (uint16_t)(center - ranges[index]);
    }
    sort_u16(deviations, range_count);
    stats->mad_mm = median_u16(deviations, range_count);
    stats->sample_count = range_count;

    if (snr_count > 0U) {
        sort_i16(snr_values, snr_count);
        stats->snr_db = median_i16(snr_values, snr_count);
        stats->snr_valid = true;
    }
    return true;
}

static bool snr_gate_passes(
    const UwbTwoStationLinkStats *right,
    const UwbTwoStationLinkStats *left,
    bool target_address_valid,
    int16_t minimum_left_snr_db)
{
    if (left->snr_valid) {
        return left->snr_db >= minimum_left_snr_db;
    }

    /*
     * The vendor's standard responder frame carries the initiator
     * address and distance but no SNR. Permit that profile only when
     * both links omit SNR and have already agreed on one target
     * address. Station-only or partially missing-SNR input remains
     * rejected.
     */
    return target_address_valid && !right->snr_valid;
}

static uint32_t normalized_q_q24(int32_t right_delta_mm,
                                 int32_t left_delta_mm,
                                 const UwbTwoStationModel *model)
{
    int64_t right_ratio_q16 =
        ((int64_t)right_delta_mm * 4294967296LL) /
        (int64_t)model->scale_right_q16;
    int64_t left_ratio_q16 =
        ((int64_t)left_delta_mm * 4294967296LL) /
        (int64_t)model->scale_left_q16;
    uint64_t q_q32 =
        (uint64_t)(right_ratio_q16 * right_ratio_q16) +
        (uint64_t)(left_ratio_q16 * left_ratio_q16);
    uint64_t q_q24 = (q_q32 + 128ULL) >> 8U;

    return (q_q24 > UINT32_MAX) ? UINT32_MAX : (uint32_t)q_q24;
}

static void insert_neighbor(Neighbor *neighbors, uint32_t q_q24,
                            uint16_t prototype_index)
{
    uint8_t position;

    for (position = 0U; position < UWB_TWO_STATION_NEIGHBOR_COUNT;
         position++) {
        if (q_q24 < neighbors[position].q_q24) {
            uint8_t move;

            for (move = UWB_TWO_STATION_NEIGHBOR_COUNT - 1U;
                 move > position; move--) {
                neighbors[move] = neighbors[move - 1U];
            }
            neighbors[position].q_q24 = q_q24;
            neighbors[position].prototype_index = prototype_index;
            break;
        }
    }
}

static int8_t angle_bucket_center(int8_t angle_deg)
{
    int16_t shifted = (int16_t)angle_deg + 45;
    int16_t bucket;

    if (shifted <= 0) {
        return -45;
    }
    if (shifted >= 90) {
        return 45;
    }
    bucket = (int16_t)((shifted + 7) / 15);
    return (int8_t)(bucket * 15 - 45);
}

static uint16_t clamp_distance(uint64_t value,
                               const UwbTwoStationModel *model)
{
    if (value < model->minimum_distance_mm) {
        return model->minimum_distance_mm;
    }
    if (value > model->maximum_distance_mm) {
        return model->maximum_distance_mm;
    }
    return (uint16_t)value;
}

static bool estimate_from_model(const UwbTwoStationEstimator *estimator,
                                const UwbTwoStationLinkStats *right,
                                const UwbTwoStationLinkStats *left,
                                UwbTwoStationResult *result,
                                uint32_t *nearest_q_q24_out)
{
    Neighbor neighbors[UWB_TWO_STATION_NEIGHBOR_COUNT];
    uint64_t angle_weights[7] = {0U};
    uint64_t weighted_distance = 0U;
    uint64_t total_weight = 0U;
    uint16_t minimum_neighbor_distance = UINT16_MAX;
    uint16_t maximum_neighbor_distance = 0U;
    uint16_t index;
    uint8_t neighbor_index;
    uint8_t best_bucket = 0U;
    uint8_t second_bucket = 0U;
    uint64_t best_bucket_weight = 0U;
    uint64_t second_bucket_weight = 0U;

    for (neighbor_index = 0U;
         neighbor_index < UWB_TWO_STATION_NEIGHBOR_COUNT;
         neighbor_index++) {
        neighbors[neighbor_index].q_q24 = UINT32_MAX;
        neighbors[neighbor_index].prototype_index = 0U;
    }

    for (index = 0U; index < estimator->model->prototype_count; index++) {
        const UwbTwoStationPrototype *prototype =
            &estimator->model->prototypes[index];
        uint32_t q_q24 = normalized_q_q24(
            (int32_t)right->feature_mm - (int32_t)prototype->right_mm,
            (int32_t)left->feature_mm - (int32_t)prototype->left_mm,
            estimator->model);

        insert_neighbor(neighbors, q_q24, index);
    }

    for (neighbor_index = 0U;
         neighbor_index < UWB_TWO_STATION_NEIGHBOR_COUNT;
         neighbor_index++) {
        const Neighbor *neighbor = &neighbors[neighbor_index];
        const UwbTwoStationPrototype *prototype =
            &estimator->model->prototypes[neighbor->prototype_index];
        uint32_t denominator =
            (neighbor->q_q24 < estimator->model->q_floor_q24)
                ? estimator->model->q_floor_q24
                : neighbor->q_q24;
        uint64_t weight = UWB_TWO_STATION_WEIGHT_NUMERATOR / denominator;
        int8_t bucket_center = angle_bucket_center(prototype->angle_deg);
        uint8_t bucket_index =
            (uint8_t)(((int16_t)bucket_center + 45) / 15);

        if (weight == 0U) {
            weight = 1U;
        }
        total_weight += weight;
        weighted_distance += weight * prototype->distance_mm;
        angle_weights[bucket_index] += weight;
        if (prototype->distance_mm < minimum_neighbor_distance) {
            minimum_neighbor_distance = prototype->distance_mm;
        }
        if (prototype->distance_mm > maximum_neighbor_distance) {
            maximum_neighbor_distance = prototype->distance_mm;
        }
    }

    if (total_weight == 0U) {
        return false;
    }

    result->distance_mm = clamp_distance(
        (weighted_distance + total_weight / 2U) / total_weight,
        estimator->model);
    result->neighbor_span_mm =
        (uint16_t)(maximum_neighbor_distance - minimum_neighbor_distance);
    if (nearest_q_q24_out != NULL) {
        *nearest_q_q24_out = neighbors[0].q_q24;
    }
    {
        uint64_t nearest_q_milli =
            ((uint64_t)neighbors[0].q_q24 * 1000U +
             UWB_TWO_STATION_Q24_ONE / 2U) /
            UWB_TWO_STATION_Q24_ONE;

        result->nearest_q_milli =
            (nearest_q_milli > UINT16_MAX)
                ? UINT16_MAX
                : (uint16_t)nearest_q_milli;
    }

    for (neighbor_index = 0U; neighbor_index < 7U; neighbor_index++) {
        uint64_t weight = angle_weights[neighbor_index];

        if (weight > best_bucket_weight) {
            second_bucket = best_bucket;
            second_bucket_weight = best_bucket_weight;
            best_bucket = neighbor_index;
            best_bucket_weight = weight;
        } else if (weight > second_bucket_weight) {
            second_bucket = neighbor_index;
            second_bucket_weight = weight;
        }
    }

    result->angle_candidate_1_deg =
        (int16_t)((int16_t)best_bucket * 15 - 45);
    result->angle_candidate_2_deg =
        (second_bucket_weight == 0U)
            ? UWB_TWO_STATION_INVALID_ANGLE_DEG
            : (int16_t)((int16_t)second_bucket * 15 - 45);
    result->angle_confidence =
        (uint8_t)((best_bucket_weight * 100U + total_weight / 2U) /
                  total_weight);
    result->angle_candidate_1_weight = result->angle_confidence;
    result->angle_candidate_2_weight =
        (uint8_t)((second_bucket_weight * 100U + total_weight / 2U) /
                  total_weight);
    result->angle_candidate_span_deg =
        (second_bucket_weight == 0U)
            ? 0U
            : (uint8_t)((result->angle_candidate_1_deg >=
                         result->angle_candidate_2_deg)
                            ? result->angle_candidate_1_deg -
                                  result->angle_candidate_2_deg
                            : result->angle_candidate_2_deg -
                                  result->angle_candidate_1_deg);
    result->angle_valid = false;
    result->angle_auth_valid = false;
    return true;
}

static bool recent_distances_are_stable(
    const UwbTwoStationEstimator *estimator)
{
    uint16_t minimum;
    uint16_t maximum;
    uint8_t index;

    if (estimator->recent_distance_count < 3U) {
        return false;
    }
    minimum = estimator->recent_distance_mm[0];
    maximum = estimator->recent_distance_mm[0];
    for (index = 1U; index < 3U; index++) {
        if (estimator->recent_distance_mm[index] < minimum) {
            minimum = estimator->recent_distance_mm[index];
        }
        if (estimator->recent_distance_mm[index] > maximum) {
            maximum = estimator->recent_distance_mm[index];
        }
    }
    return (uint16_t)(maximum - minimum) <=
           UWB_TWO_STATION_MAX_STABILITY_SPAN_MM;
}

static void record_recent_distance(UwbTwoStationEstimator *estimator,
                                   uint16_t distance_mm)
{
    estimator->recent_distance_mm[estimator->recent_distance_index] =
        distance_mm;
    estimator->recent_distance_index =
        (uint8_t)((estimator->recent_distance_index + 1U) % 3U);
    if (estimator->recent_distance_count < 3U) {
        estimator->recent_distance_count++;
    }
}

static void clear_target_observations(
    UwbTwoStationEstimator *estimator)
{
    memset(estimator->history, 0, sizeof(estimator->history));
    memset(estimator->recent_distance_mm, 0,
           sizeof(estimator->recent_distance_mm));
    estimator->recent_distance_count = 0U;
    estimator->recent_distance_index = 0U;
    estimator->has_result = false;
    estimator->has_trusted_result = false;
    memset(&estimator->result, 0, sizeof(estimator->result));
    memset(&estimator->trusted_result, 0,
           sizeof(estimator->trusted_result));
}

static void select_target_context(
    UwbTwoStationEstimator *estimator,
    const UwbTwoStationSample *sample)
{
    bool target_changed =
        estimator->target_context_initialized &&
        ((estimator->active_target_valid !=
          sample->target_address_valid) ||
         (sample->target_address_valid &&
          (estimator->active_target_address !=
           sample->target_address)));

    if (target_changed) {
        clear_target_observations(estimator);
        estimator->input_failure_flags |=
            UWB_TWO_STATION_FAILURE_TARGET;
    }
    estimator->target_context_initialized = true;
    estimator->active_target_valid =
        sample->target_address_valid;
    estimator->active_target_address =
        sample->target_address_valid ? sample->target_address : 0U;
}

bool uwb_two_station_estimator_init(UwbTwoStationEstimator *estimator,
                                    const UwbTwoStationModel *model)
{
    if (estimator == NULL) {
        return false;
    }

    memset(estimator, 0, sizeof(*estimator));
    estimator->model = model;
    estimator->initialized = uwb_two_station_model_is_valid(model);
    if (!estimator->initialized) {
        estimator->result.failure_flags = UWB_TWO_STATION_FAILURE_MODEL;
    }
    return estimator->initialized;
}

bool uwb_two_station_estimator_push(UwbTwoStationEstimator *estimator,
                                    uint8_t station,
                                    const UwbTwoStationSample *sample)
{
    UwbTwoStationHistory *history;

    if ((estimator == NULL) || !estimator->initialized ||
        (sample == NULL) || (station >= UWB_TWO_STATION_COUNT) ||
        (sample->range_mm < UWB_TWO_STATION_MIN_RANGE_MM) ||
        (sample->range_mm > UWB_TWO_STATION_MAX_RANGE_MM)) {
        return false;
    }
    if ((estimator->model->station_address[station] != 0U) &&
        (sample->station_address !=
         estimator->model->station_address[station])) {
        estimator->input_failure_flags |=
            UWB_TWO_STATION_FAILURE_ADDRESS;
        return false;
    }

    select_target_context(estimator, sample);
    history = &estimator->history[station];
    history->samples[history->write_index] = *sample;
    history->write_index =
        (uint8_t)((history->write_index + 1U) %
                  UWB_TWO_STATION_HISTORY_CAPACITY);
    if (history->count < UWB_TWO_STATION_HISTORY_CAPACITY) {
        history->count++;
    }
    return true;
}

bool uwb_two_station_estimator_update(UwbTwoStationEstimator *estimator,
                                      uint32_t now_ms,
                                      UwbTwoStationResult *result)
{
    UwbTwoStationLinkStats stats[UWB_TWO_STATION_COUNT];
    UwbTwoStationResult next;
    bool right_ready;
    bool left_ready;
    bool stable;
    uint16_t feature_delta;
    uint32_t pair_skew;
    uint32_t nearest_q24;
    bool high;
    bool medium;
    bool high_snr_ok;
    bool medium_snr_ok;

    if ((estimator == NULL) || (result == NULL)) {
        return false;
    }
    if (!estimator->initialized) {
        memset(result, 0, sizeof(*result));
        result->failure_flags = UWB_TWO_STATION_FAILURE_MODEL;
        return true;
    }
    if (estimator->has_result &&
        (elapsed_ms(estimator->last_update_ms, now_ms) <
         estimator->model->update_period_ms)) {
        *result = estimator->result;
        return false;
    }

    memset(&next, 0, sizeof(next));
    next.angle_candidate_1_deg = UWB_TWO_STATION_INVALID_ANGLE_DEG;
    next.angle_candidate_2_deg = UWB_TWO_STATION_INVALID_ANGLE_DEG;
    next.distance_quality = UWB_DISTANCE_REJECT;
    next.model_version = estimator->model->version;
    next.model_bytes = estimator->model->serialized_bytes;
    next.model_crc32 = estimator->model->crc32;
    next.failure_flags = estimator->input_failure_flags;
    next.updated_ms = now_ms;
    estimator->input_failure_flags = 0U;

    right_ready = collect_link_stats(
        estimator, UWB_TWO_STATION_RIGHT, now_ms,
        &stats[UWB_TWO_STATION_RIGHT]);
    left_ready = collect_link_stats(
        estimator, UWB_TWO_STATION_LEFT, now_ms,
        &stats[UWB_TWO_STATION_LEFT]);

    next.sample_count[UWB_TWO_STATION_RIGHT] =
        stats[UWB_TWO_STATION_RIGHT].sample_count;
    next.sample_count[UWB_TWO_STATION_LEFT] =
        stats[UWB_TWO_STATION_LEFT].sample_count;
    next.mad_mm[UWB_TWO_STATION_RIGHT] =
        stats[UWB_TWO_STATION_RIGHT].mad_mm;
    next.mad_mm[UWB_TWO_STATION_LEFT] =
        stats[UWB_TWO_STATION_LEFT].mad_mm;
    next.snr_db[UWB_TWO_STATION_RIGHT] =
        stats[UWB_TWO_STATION_RIGHT].snr_db;
    next.snr_db[UWB_TWO_STATION_LEFT] =
        stats[UWB_TWO_STATION_LEFT].snr_db;
    next.feature_mm[UWB_TWO_STATION_RIGHT] =
        stats[UWB_TWO_STATION_RIGHT].feature_mm;
    next.feature_mm[UWB_TWO_STATION_LEFT] =
        stats[UWB_TWO_STATION_LEFT].feature_mm;

    if (!right_ready || !left_ready) {
        next.failure_flags |=
            UWB_TWO_STATION_FAILURE_INSUFFICIENT_SAMPLES;
        goto reject_or_hold;
    }
    next.valid_mask = 0x03U;
    if (stats[UWB_TWO_STATION_RIGHT].target_address_valid !=
        stats[UWB_TWO_STATION_LEFT].target_address_valid) {
        next.failure_flags |= UWB_TWO_STATION_FAILURE_TARGET;
        goto reject_or_hold;
    }
    if (stats[UWB_TWO_STATION_RIGHT].target_address_valid) {
        if (stats[UWB_TWO_STATION_RIGHT].target_address !=
            stats[UWB_TWO_STATION_LEFT].target_address) {
            next.failure_flags |= UWB_TWO_STATION_FAILURE_TARGET;
            goto reject_or_hold;
        }
        next.target_address_valid = true;
        next.target_address =
            stats[UWB_TWO_STATION_RIGHT].target_address;
    }
    {
        uint32_t right_age = elapsed_ms(
            stats[UWB_TWO_STATION_RIGHT].latest_timestamp_ms, now_ms);
        uint32_t left_age = elapsed_ms(
            stats[UWB_TWO_STATION_LEFT].latest_timestamp_ms, now_ms);
        uint32_t newest_pair_age =
            (right_age >= left_age) ? right_age : left_age;

        next.age_ms = (newest_pair_age > UINT16_MAX)
                          ? UINT16_MAX
                          : (uint16_t)newest_pair_age;
    }
    pair_skew =
        (stats[UWB_TWO_STATION_RIGHT].latest_timestamp_ms >=
         stats[UWB_TWO_STATION_LEFT].latest_timestamp_ms)
            ? stats[UWB_TWO_STATION_RIGHT].latest_timestamp_ms -
                  stats[UWB_TWO_STATION_LEFT].latest_timestamp_ms
            : stats[UWB_TWO_STATION_LEFT].latest_timestamp_ms -
                  stats[UWB_TWO_STATION_RIGHT].latest_timestamp_ms;
    if (pair_skew > estimator->model->pair_skew_ms) {
        next.failure_flags |= UWB_TWO_STATION_FAILURE_PAIR_SKEW;
        goto reject_or_hold;
    }
    if (!estimate_from_model(estimator,
                             &stats[UWB_TWO_STATION_RIGHT],
                             &stats[UWB_TWO_STATION_LEFT], &next,
                             &nearest_q24)) {
        next.failure_flags |= UWB_TWO_STATION_FAILURE_MODEL;
        goto reject_or_hold;
    }

    record_recent_distance(estimator, next.distance_mm);
    stable = recent_distances_are_stable(estimator);
    feature_delta =
        (stats[UWB_TWO_STATION_RIGHT].feature_mm >=
         stats[UWB_TWO_STATION_LEFT].feature_mm)
            ? (uint16_t)(stats[UWB_TWO_STATION_RIGHT].feature_mm -
                         stats[UWB_TWO_STATION_LEFT].feature_mm)
            : (uint16_t)(stats[UWB_TWO_STATION_LEFT].feature_mm -
                         stats[UWB_TWO_STATION_RIGHT].feature_mm);
    high_snr_ok = snr_gate_passes(
        &stats[UWB_TWO_STATION_RIGHT],
        &stats[UWB_TWO_STATION_LEFT],
        next.target_address_valid,
        UWB_TWO_STATION_HIGH_MIN_LEFT_SNR_DB);
    medium_snr_ok = snr_gate_passes(
        &stats[UWB_TWO_STATION_RIGHT],
        &stats[UWB_TWO_STATION_LEFT],
        next.target_address_valid,
        UWB_TWO_STATION_MEDIUM_MIN_LEFT_SNR_DB);
    high =
        (stats[UWB_TWO_STATION_RIGHT].sample_count >=
         UWB_TWO_STATION_HIGH_MIN_SAMPLES) &&
        (stats[UWB_TWO_STATION_LEFT].sample_count >=
         UWB_TWO_STATION_HIGH_MIN_SAMPLES) &&
        (stats[UWB_TWO_STATION_RIGHT].mad_mm <=
         UWB_TWO_STATION_HIGH_MAX_MAD_MM) &&
        (stats[UWB_TWO_STATION_LEFT].mad_mm <=
         UWB_TWO_STATION_HIGH_MAX_MAD_MM) &&
        high_snr_ok &&
        (feature_delta <=
         UWB_TWO_STATION_HIGH_MAX_FEATURE_DELTA_MM) &&
        (nearest_q24 <= estimator->model->high_nearest_q24) &&
        (next.neighbor_span_mm <=
         UWB_TWO_STATION_MAX_NEIGHBOR_SPAN_MM) &&
        stable;

    medium =
        (stats[UWB_TWO_STATION_RIGHT].sample_count >=
         UWB_TWO_STATION_MEDIUM_MIN_SAMPLES) &&
        (stats[UWB_TWO_STATION_LEFT].sample_count >=
         UWB_TWO_STATION_MEDIUM_MIN_SAMPLES) &&
        (stats[UWB_TWO_STATION_RIGHT].mad_mm <=
         UWB_TWO_STATION_MEDIUM_MAX_MAD_MM) &&
        (stats[UWB_TWO_STATION_LEFT].mad_mm <=
         UWB_TWO_STATION_MEDIUM_MAX_MAD_MM) &&
        medium_snr_ok &&
        (feature_delta <=
         UWB_TWO_STATION_MEDIUM_MAX_FEATURE_DELTA_MM) &&
        (next.neighbor_span_mm <=
         UWB_TWO_STATION_MAX_NEIGHBOR_SPAN_MM);

    if (high) {
        next.distance_quality = UWB_DISTANCE_HIGH;
        next.distance_valid = true;
        next.auth_distance_valid = true;
        estimator->trusted_result = next;
        estimator->trusted_result_ms = now_ms;
        estimator->has_trusted_result = true;
    } else if (medium) {
        next.distance_quality = UWB_DISTANCE_MEDIUM;
        next.distance_valid = true;
        if (!stable) {
            next.failure_flags |= UWB_TWO_STATION_FAILURE_UNSTABLE;
        }
        if (nearest_q24 > estimator->model->high_nearest_q24) {
            next.failure_flags |=
                UWB_TWO_STATION_FAILURE_MODEL_DISTANCE;
        }
    } else {
        if (!medium_snr_ok) {
            next.failure_flags |= UWB_TWO_STATION_FAILURE_SNR;
        }
        if ((stats[UWB_TWO_STATION_RIGHT].mad_mm >
             UWB_TWO_STATION_MEDIUM_MAX_MAD_MM) ||
            (stats[UWB_TWO_STATION_LEFT].mad_mm >
             UWB_TWO_STATION_MEDIUM_MAX_MAD_MM)) {
            next.failure_flags |= UWB_TWO_STATION_FAILURE_MAD;
        }
        if (feature_delta >
            UWB_TWO_STATION_MEDIUM_MAX_FEATURE_DELTA_MM) {
            next.failure_flags |=
                UWB_TWO_STATION_FAILURE_FEATURE_DELTA;
        }
        if (next.neighbor_span_mm >
            UWB_TWO_STATION_MAX_NEIGHBOR_SPAN_MM) {
            next.failure_flags |=
                UWB_TWO_STATION_FAILURE_NEIGHBOR_SPAN;
        }
        if (!stable) {
            next.failure_flags |= UWB_TWO_STATION_FAILURE_UNSTABLE;
        }
        goto reject_or_hold;
    }
    goto finish;

reject_or_hold:
    next.distance_quality = UWB_DISTANCE_REJECT;
    next.auth_distance_valid = false;
    if (estimator->has_trusted_result &&
        (elapsed_ms(estimator->trusted_result_ms, now_ms) <=
         estimator->model->hold_ms)) {
        uint32_t current_flags = next.failure_flags;

        next.distance_mm = estimator->trusted_result.distance_mm;
        next.angle_candidate_1_deg =
            estimator->trusted_result.angle_candidate_1_deg;
        next.angle_candidate_2_deg =
            estimator->trusted_result.angle_candidate_2_deg;
        next.angle_confidence =
            estimator->trusted_result.angle_confidence;
        next.angle_candidate_1_weight =
            estimator->trusted_result.angle_candidate_1_weight;
        next.angle_candidate_2_weight =
            estimator->trusted_result.angle_candidate_2_weight;
        next.angle_candidate_span_deg =
            estimator->trusted_result.angle_candidate_span_deg;
        next.distance_valid = true;
        next.held = true;
        next.failure_flags =
            current_flags | UWB_TWO_STATION_FAILURE_HELD;
        next.age_ms = (uint16_t)elapsed_ms(
            estimator->trusted_result_ms, now_ms);
    } else {
        next.failure_flags |= UWB_TWO_STATION_FAILURE_STALE;
    }

finish:
    next.angle_valid = false;
    next.angle_auth_valid = false;
    estimator->result = next;
    estimator->last_update_ms = now_ms;
    estimator->has_result = true;
    *result = next;
    return true;
}

const UwbTwoStationResult *uwb_two_station_estimator_result(
    const UwbTwoStationEstimator *estimator)
{
    return (estimator == NULL) ? NULL : &estimator->result;
}

void uwb_two_station_estimator_report_failure(
    UwbTwoStationEstimator *estimator, uint32_t failure_flags)
{
    if (estimator != NULL) {
        estimator->input_failure_flags |= failure_flags;
    }
}
