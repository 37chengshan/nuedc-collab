#include "uwb_four_station_estimator.h"

#include <limits.h>
#include <stddef.h>
#include <string.h>

#define UWB_FOUR_MIN_RANGE_MM 300U
#define UWB_FOUR_MAX_RANGE_MM 5000U
#define UWB_FOUR_Q24_ONE 16777216UL
#define UWB_FOUR_WEIGHT_NUMERATOR 1000000000UL
#define UWB_FOUR_HIGH_MIN_SAMPLES 6U
#define UWB_FOUR_MEDIUM_MIN_SAMPLES 4U
#define UWB_FOUR_HIGH_MAX_MAD_MM 100U
#define UWB_FOUR_MEDIUM_MAX_MAD_MM 150U
#define UWB_FOUR_MEDIUM_NEAREST_Q24 13421773UL
#define UWB_FOUR_HIGH_MAX_SPAN_MM 400U
#define UWB_FOUR_MEDIUM_MAX_SPAN_MM 800U
#define UWB_FOUR_MAX_STABILITY_MM 150U
#define UWB_FOUR_ANGLE_AUTH_DISAGREEMENT_X10 250

typedef struct {
    uint32_t q_q24;
    uint16_t index;
} UwbFourNeighbor;

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

static uint32_t crc32_i16(uint32_t crc, int16_t value)
{
    return crc32_u16(crc, (uint16_t)value);
}

static uint32_t crc32_u32(uint32_t crc, uint32_t value)
{
    crc = crc32_byte(crc, (uint8_t)value);
    crc = crc32_byte(crc, (uint8_t)(value >> 8U));
    crc = crc32_byte(crc, (uint8_t)(value >> 16U));
    return crc32_byte(crc, (uint8_t)(value >> 24U));
}

static uint32_t crc32_i32(uint32_t crc, int32_t value)
{
    return crc32_u32(crc, (uint32_t)value);
}

uint32_t uwb_four_station_model_compute_crc32(
    const UwbFourStationModel *model)
{
    uint32_t crc = 0xFFFFFFFFUL;
    uint16_t index;
    uint8_t station;

    if ((model == NULL) || (model->prototypes == NULL) ||
        (model->prototype_count != UWB_FOUR_STATION_EXPECTED_PROTOTYPES) ||
        (model->serialized_bytes !=
         UWB_FOUR_STATION_MODEL_SERIALIZED_BYTES)) {
        return 0U;
    }
    crc = crc32_u32(crc, model->magic);
    crc = crc32_u16(crc, model->version);
    crc = crc32_u16(crc, model->prototype_count);
    crc = crc32_u16(crc, model->serialized_bytes);
    for (station = 0U; station < UWB_FOUR_STATION_COUNT; station++) {
        crc = crc32_u16(crc, model->station_address[station]);
    }
    crc = crc32_u16(crc, model->window_ms);
    crc = crc32_u16(crc, model->pair_skew_ms);
    crc = crc32_u16(crc, model->update_period_ms);
    crc = crc32_u16(crc, model->hold_ms);
    for (station = 0U; station < UWB_FOUR_STATION_COUNT; station++) {
        crc = crc32_u32(crc, model->scale_q16[station]);
    }
    crc = crc32_u32(crc, model->q_floor_q24);
    crc = crc32_u32(crc, model->high_nearest_q24);
    crc = crc32_u16(crc, model->minimum_distance_mm);
    crc = crc32_u16(crc, model->maximum_distance_mm);
    for (station = 0U; station < UWB_FOUR_STATION_COUNT; station++) {
        crc = crc32_u16(crc, model->angle_mean_mm[station]);
    }
    for (station = 0U; station <= UWB_FOUR_STATION_COUNT; station++) {
        crc = crc32_i32(crc, model->angle_coefficient_q16[station]);
    }
    crc = crc32_u16(crc, model->angle_scale_mm);
    for (index = 0U; index < model->prototype_count; index++) {
        const UwbFourStationPrototype *prototype =
            &model->prototypes[index];

        for (station = 0U; station < UWB_FOUR_STATION_COUNT; station++) {
            crc = crc32_u16(crc, prototype->range_mm[station]);
        }
        crc = crc32_u16(crc, prototype->center_distance_mm);
        crc = crc32_i16(crc, prototype->angle_deg_x10);
    }
    return crc ^ 0xFFFFFFFFUL;
}

bool uwb_four_station_model_is_valid(const UwbFourStationModel *model)
{
    uint8_t station;

    if ((model == NULL) ||
        (model->magic != UWB_FOUR_STATION_MODEL_MAGIC) ||
        (model->version != UWB_FOUR_STATION_MODEL_VERSION) ||
        (model->prototype_count != UWB_FOUR_STATION_EXPECTED_PROTOTYPES) ||
        (model->serialized_bytes !=
         UWB_FOUR_STATION_MODEL_SERIALIZED_BYTES) ||
        (model->prototypes == NULL) || (model->window_ms == 0U) ||
        (model->update_period_ms == 0U) ||
        (model->angle_scale_mm == 0U) ||
        (model->minimum_distance_mm >= model->maximum_distance_mm)) {
        return false;
    }
    for (station = 0U; station < UWB_FOUR_STATION_COUNT; station++) {
        if (model->scale_q16[station] == 0U) {
            return false;
        }
    }
    return model->crc32 == uwb_four_station_model_compute_crc32(model);
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

static uint16_t median_u16(const uint16_t *values, uint8_t count)
{
    uint8_t middle = (uint8_t)(count / 2U);

    return ((count & 1U) != 0U)
               ? values[middle]
               : (uint16_t)(((uint32_t)values[middle - 1U] +
                              (uint32_t)values[middle]) /
                             2U);
}

static bool collect_stats(const UwbFourStationEstimator *estimator,
                          uint8_t station, uint32_t now_ms,
                          UwbFourStationLinkStats *stats)
{
    const UwbFourStationHistory *history = &estimator->history[station];
    uint16_t ranges[UWB_FOUR_STATION_HISTORY_CAPACITY];
    uint16_t deviations[UWB_FOUR_STATION_HISTORY_CAPACITY];
    int16_t snrs[UWB_FOUR_STATION_HISTORY_CAPACITY];
    uint8_t range_count = 0U;
    uint8_t snr_count = 0U;
    uint32_t newest_age = UINT32_MAX;
    uint8_t index;
    uint16_t center;

    memset(stats, 0, sizeof(*stats));
    for (index = 0U; index < history->count; index++) {
        const UwbFourStationSample *sample = &history->samples[index];
        uint32_t age = now_ms - sample->timestamp_ms;

        if (age > estimator->model->window_ms) {
            continue;
        }
        ranges[range_count++] = sample->range_mm;
        if (sample->snr_valid) {
            snrs[snr_count++] = sample->snr_db;
        }
        if (age < newest_age) {
            newest_age = age;
            stats->latest_timestamp_ms = sample->timestamp_ms;
        }
    }
    stats->sample_count = range_count;
    if (range_count < 3U) {
        return false;
    }
    sort_u16(ranges, range_count);
    stats->feature_mm =
        (uint16_t)(((uint32_t)ranges[0] + ranges[1] + ranges[2] + 1U) /
                   3U);
    center = median_u16(ranges, range_count);
    for (index = 0U; index < range_count; index++) {
        deviations[index] = (ranges[index] >= center)
                                ? (uint16_t)(ranges[index] - center)
                                : (uint16_t)(center - ranges[index]);
    }
    sort_u16(deviations, range_count);
    stats->mad_mm = median_u16(deviations, range_count);
    if (snr_count > 0U) {
        sort_i16(snrs, snr_count);
        stats->snr_db = snrs[snr_count / 2U];
        stats->snr_valid = true;
    }
    return true;
}

static uint32_t normalized_q_q24(
    const uint16_t feature_mm[UWB_FOUR_STATION_COUNT],
    const UwbFourStationPrototype *prototype,
    const UwbFourStationModel *model)
{
    uint64_t total_q32 = 0U;
    uint8_t station;

    for (station = 0U; station < UWB_FOUR_STATION_COUNT; station++) {
        int32_t delta =
            (int32_t)feature_mm[station] -
            (int32_t)prototype->range_mm[station];
        int64_t ratio_q16 =
            ((int64_t)delta * 4294967296LL) /
            (int64_t)model->scale_q16[station];

        total_q32 += (uint64_t)(ratio_q16 * ratio_q16);
    }
    total_q32 = (total_q32 + 128U) >> 8U;
    return (total_q32 > UINT32_MAX) ? UINT32_MAX
                                   : (uint32_t)total_q32;
}

static void insert_neighbor(UwbFourNeighbor *neighbors, uint32_t q,
                            uint16_t index)
{
    uint8_t position;

    for (position = 0U; position < UWB_FOUR_STATION_NEIGHBOR_COUNT;
         position++) {
        if (q < neighbors[position].q_q24) {
            uint8_t move;

            for (move = UWB_FOUR_STATION_NEIGHBOR_COUNT - 1U;
                 move > position; move--) {
                neighbors[move] = neighbors[move - 1U];
            }
            neighbors[position].q_q24 = q;
            neighbors[position].index = index;
            break;
        }
    }
}

static uint32_t integer_sqrt_u32(uint32_t value)
{
    uint32_t result = 0U;
    uint32_t bit = 1UL << 30U;

    while (bit > value) {
        bit >>= 2U;
    }
    while (bit != 0U) {
        if (value >= result + bit) {
            value -= result + bit;
            result = (result >> 1U) + bit;
        } else {
            result >>= 1U;
        }
        bit >>= 2U;
    }
    return result;
}

static int16_t absolute_i16(int16_t value)
{
    return (value < 0) ? (int16_t)-value : value;
}

static int16_t estimate_ridge_angle_x10(
    const uint16_t feature_mm[UWB_FOUR_STATION_COUNT],
    const UwbFourStationModel *model)
{
    int64_t angle_q16 = model->angle_coefficient_q16[0];
    uint8_t station;

    for (station = 0U; station < UWB_FOUR_STATION_COUNT; station++) {
        int32_t delta =
            (int32_t)feature_mm[station] -
            (int32_t)model->angle_mean_mm[station];

        angle_q16 +=
            ((int64_t)model->angle_coefficient_q16[station + 1U] *
             delta) /
            model->angle_scale_mm;
    }
    if (angle_q16 < -45LL * 65536LL) {
        angle_q16 = -45LL * 65536LL;
    } else if (angle_q16 > 45LL * 65536LL) {
        angle_q16 = 45LL * 65536LL;
    }
    return (int16_t)((angle_q16 * 10LL +
                      ((angle_q16 >= 0) ? 32768LL : -32768LL)) /
                     65536LL);
}

static bool estimate_model(
    const UwbFourStationEstimator *estimator,
    const UwbFourStationLinkStats stats[UWB_FOUR_STATION_COUNT],
    UwbFourStationResult *result, uint32_t *nearest_q_out)
{
    UwbFourNeighbor neighbors[UWB_FOUR_STATION_NEIGHBOR_COUNT];
    uint16_t features[UWB_FOUR_STATION_COUNT];
    uint64_t weighted_distance = 0U;
    int64_t weighted_angle = 0;
    uint64_t total_weight = 0U;
    uint16_t minimum_distance = UINT16_MAX;
    uint16_t maximum_distance = 0U;
    uint16_t index;
    uint8_t station;
    uint8_t neighbor_index;

    for (station = 0U; station < UWB_FOUR_STATION_COUNT; station++) {
        features[station] = stats[station].feature_mm;
    }
    for (neighbor_index = 0U;
         neighbor_index < UWB_FOUR_STATION_NEIGHBOR_COUNT;
         neighbor_index++) {
        neighbors[neighbor_index].q_q24 = UINT32_MAX;
        neighbors[neighbor_index].index = 0U;
    }
    for (index = 0U; index < estimator->model->prototype_count; index++) {
        insert_neighbor(
            neighbors,
            normalized_q_q24(features, &estimator->model->prototypes[index],
                             estimator->model),
            index);
    }
    for (neighbor_index = 0U;
         neighbor_index < UWB_FOUR_STATION_NEIGHBOR_COUNT;
         neighbor_index++) {
        const UwbFourStationPrototype *prototype =
            &estimator->model->prototypes[neighbors[neighbor_index].index];
        uint32_t q = (neighbors[neighbor_index].q_q24 <
                      estimator->model->q_floor_q24)
                         ? estimator->model->q_floor_q24
                         : neighbors[neighbor_index].q_q24;
        uint32_t root_q12 = integer_sqrt_u32(q);
        uint32_t weight =
            UWB_FOUR_WEIGHT_NUMERATOR / ((root_q12 == 0U) ? 1U : root_q12);

        total_weight += weight;
        weighted_distance +=
            (uint64_t)weight * prototype->center_distance_mm;
        weighted_angle +=
            (int64_t)weight * prototype->angle_deg_x10;
        if (prototype->center_distance_mm < minimum_distance) {
            minimum_distance = prototype->center_distance_mm;
        }
        if (prototype->center_distance_mm > maximum_distance) {
            maximum_distance = prototype->center_distance_mm;
        }
    }
    if (total_weight == 0U) {
        return false;
    }
    result->center_distance_mm =
        (uint16_t)((weighted_distance + total_weight / 2U) / total_weight);
    if (result->center_distance_mm < estimator->model->minimum_distance_mm) {
        result->center_distance_mm = estimator->model->minimum_distance_mm;
    } else if (result->center_distance_mm >
               estimator->model->maximum_distance_mm) {
        result->center_distance_mm = estimator->model->maximum_distance_mm;
    }
    result->boundary_distance_mm =
        (result->center_distance_mm > 300U)
            ? (uint16_t)(result->center_distance_mm - 300U)
            : 0U;
    result->local_angle_deg_x10 =
        (int16_t)(weighted_angle / (int64_t)total_weight);
    result->angle_deg_x10 =
        estimate_ridge_angle_x10(features, estimator->model);
    result->neighbor_span_mm =
        (uint16_t)(maximum_distance - minimum_distance);
    result->nearest_q_milli =
        (uint16_t)(((uint64_t)neighbors[0].q_q24 * 1000U +
                    UWB_FOUR_Q24_ONE / 2U) /
                   UWB_FOUR_Q24_ONE);
    if (nearest_q_out != NULL) {
        *nearest_q_out = neighbors[0].q_q24;
    }
    {
        int16_t disagreement = absolute_i16(
            (int16_t)(result->angle_deg_x10 -
                      result->local_angle_deg_x10));

        result->angle_confidence =
            (disagreement >= 600)
                ? 0U
                : (uint8_t)(100U -
                            ((uint16_t)disagreement * 100U / 600U));
    }
    return true;
}

static void record_distance(UwbFourStationEstimator *estimator,
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

static bool distance_is_stable(const UwbFourStationEstimator *estimator)
{
    uint16_t minimum;
    uint16_t maximum;
    uint8_t index;

    if (estimator->recent_distance_count < 3U) {
        return false;
    }
    minimum = estimator->recent_distance_mm[0];
    maximum = minimum;
    for (index = 1U; index < 3U; index++) {
        if (estimator->recent_distance_mm[index] < minimum) {
            minimum = estimator->recent_distance_mm[index];
        }
        if (estimator->recent_distance_mm[index] > maximum) {
            maximum = estimator->recent_distance_mm[index];
        }
    }
    return (uint16_t)(maximum - minimum) <= UWB_FOUR_MAX_STABILITY_MM;
}

bool uwb_four_station_estimator_init(UwbFourStationEstimator *estimator,
                                     const UwbFourStationModel *model)
{
    if (estimator == NULL) {
        return false;
    }
    memset(estimator, 0, sizeof(*estimator));
    estimator->model = model;
    estimator->initialized = uwb_four_station_model_is_valid(model);
    return estimator->initialized;
}

bool uwb_four_station_estimator_push(UwbFourStationEstimator *estimator,
                                     uint8_t station,
                                     const UwbFourStationSample *sample)
{
    UwbFourStationHistory *history;

    if ((estimator == NULL) || !estimator->initialized ||
        (sample == NULL) || (station >= UWB_FOUR_STATION_COUNT) ||
        (sample->range_mm < UWB_FOUR_MIN_RANGE_MM) ||
        (sample->range_mm > UWB_FOUR_MAX_RANGE_MM) ||
        (sample->station_address !=
         estimator->model->station_address[station])) {
        if ((estimator != NULL) && (sample != NULL) &&
            (station < UWB_FOUR_STATION_COUNT) &&
            (sample->station_address !=
             estimator->model->station_address[station])) {
            estimator->input_failure_flags |= UWB_FOUR_FAILURE_ADDRESS;
        }
        return false;
    }
    history = &estimator->history[station];
    history->samples[history->write_index] = *sample;
    history->write_index =
        (uint8_t)((history->write_index + 1U) %
                  UWB_FOUR_STATION_HISTORY_CAPACITY);
    if (history->count < UWB_FOUR_STATION_HISTORY_CAPACITY) {
        history->count++;
    } else {
        estimator->input_failure_flags |= UWB_FOUR_FAILURE_OVERFLOW;
    }
    return true;
}

bool uwb_four_station_estimator_update(UwbFourStationEstimator *estimator,
                                       uint32_t now_ms,
                                       UwbFourStationResult *result)
{
    UwbFourStationLinkStats stats[UWB_FOUR_STATION_COUNT];
    UwbFourStationResult next;
    uint32_t nearest_q = UINT32_MAX;
    uint32_t oldest_timestamp = UINT32_MAX;
    uint32_t newest_timestamp = 0U;
    uint8_t station;
    bool ready = true;
    bool high = true;
    bool medium = true;

    if ((estimator == NULL) || (result == NULL) ||
        !estimator->initialized) {
        return false;
    }
    if ((now_ms - estimator->last_update_ms) <
        estimator->model->update_period_ms) {
        *result = estimator->result;
        return estimator->has_result;
    }
    estimator->last_update_ms = now_ms;
    memset(&next, 0, sizeof(next));
    next.model_version = estimator->model->version;
    next.model_bytes = estimator->model->serialized_bytes;
    next.model_crc32 = estimator->model->crc32;
    next.failure_flags = estimator->input_failure_flags;

    for (station = 0U; station < UWB_FOUR_STATION_COUNT; station++) {
        if (!collect_stats(estimator, station, now_ms, &stats[station])) {
            ready = false;
            next.failure_flags |= UWB_FOUR_FAILURE_SAMPLES;
        }
        next.sample_count[station] = stats[station].sample_count;
        next.mad_mm[station] = stats[station].mad_mm;
        next.snr_db[station] = stats[station].snr_db;
        next.feature_mm[station] = stats[station].feature_mm;
        if (stats[station].sample_count >= 3U) {
            next.valid_mask |= (uint8_t)(1U << station);
            if (stats[station].latest_timestamp_ms < oldest_timestamp) {
                oldest_timestamp = stats[station].latest_timestamp_ms;
            }
            if (stats[station].latest_timestamp_ms > newest_timestamp) {
                newest_timestamp = stats[station].latest_timestamp_ms;
            }
        }
    }
    if (ready &&
        (newest_timestamp - oldest_timestamp >
         estimator->model->pair_skew_ms)) {
        ready = false;
        next.failure_flags |= UWB_FOUR_FAILURE_SKEW;
    }
    if (ready && estimate_model(estimator, stats, &next, &nearest_q)) {
        int16_t disagreement = absolute_i16(
            (int16_t)(next.angle_deg_x10 -
                      next.local_angle_deg_x10));

        record_distance(estimator, next.center_distance_mm);
        for (station = 0U; station < UWB_FOUR_STATION_COUNT; station++) {
            high = high &&
                   (stats[station].sample_count >=
                    UWB_FOUR_HIGH_MIN_SAMPLES) &&
                   (stats[station].mad_mm <=
                    UWB_FOUR_HIGH_MAX_MAD_MM);
            medium = medium &&
                     (stats[station].sample_count >=
                      UWB_FOUR_MEDIUM_MIN_SAMPLES) &&
                     (stats[station].mad_mm <=
                      UWB_FOUR_MEDIUM_MAX_MAD_MM);
        }
        high = high &&
               (nearest_q <= estimator->model->high_nearest_q24) &&
               (next.neighbor_span_mm <= UWB_FOUR_HIGH_MAX_SPAN_MM) &&
               distance_is_stable(estimator);
        medium = medium &&
                 (nearest_q <= UWB_FOUR_MEDIUM_NEAREST_Q24) &&
                 (next.neighbor_span_mm <= UWB_FOUR_MEDIUM_MAX_SPAN_MM);
        if (high) {
            next.distance_quality = UWB_FOUR_DISTANCE_HIGH;
            next.distance_valid = true;
            next.auth_distance_valid = true;
        } else if (medium) {
            next.distance_quality = UWB_FOUR_DISTANCE_MEDIUM;
            next.distance_valid = true;
            next.failure_flags |= UWB_FOUR_FAILURE_UNSTABLE;
        } else {
            next.distance_quality = UWB_FOUR_DISTANCE_REJECT;
            /*
             * A rejected estimate remains useful for the requested live
             * distance/angle display. It never receives authorization.
             */
            next.distance_valid = true;
            next.failure_flags |= UWB_FOUR_FAILURE_NEIGHBOR;
        }
        next.angle_valid =
            high &&
            (disagreement <= UWB_FOUR_ANGLE_AUTH_DISAGREEMENT_X10);
        next.angle_auth_valid = next.angle_valid;
        next.updated_ms = now_ms;
        next.age_ms = 0U;
    }

    if (next.distance_valid) {
        if (next.distance_quality != UWB_FOUR_DISTANCE_REJECT) {
            estimator->trusted_result = next;
            estimator->trusted_result_ms = now_ms;
            estimator->has_trusted_result = true;
        }
        estimator->result = next;
        estimator->has_result = true;
    } else if (estimator->has_trusted_result &&
               ((now_ms - estimator->trusted_result_ms) <=
                estimator->model->hold_ms)) {
        next = estimator->trusted_result;
        next.held = true;
        next.auth_distance_valid = false;
        next.angle_valid = false;
        next.angle_auth_valid = false;
        next.failure_flags |= UWB_FOUR_FAILURE_HELD;
        next.age_ms =
            (uint16_t)(now_ms - estimator->trusted_result_ms);
        estimator->result = next;
        estimator->has_result = true;
    } else {
        next.failure_flags |= UWB_FOUR_FAILURE_STALE;
        estimator->result = next;
        estimator->has_result = false;
    }
    *result = estimator->result;
    return estimator->has_result;
}

const UwbFourStationResult *uwb_four_station_estimator_result(
    const UwbFourStationEstimator *estimator)
{
    return ((estimator != NULL) && estimator->has_result)
               ? &estimator->result
               : NULL;
}
