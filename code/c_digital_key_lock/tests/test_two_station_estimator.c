#include "two_station_model_data.h"
#include "uwb_two_station_estimator.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static unsigned int g_assertions;

#define TEST_ASSERT(condition)                                                  \
    do {                                                                        \
        g_assertions++;                                                         \
        if (!(condition)) {                                                     \
            fprintf(stderr, "%s:%d: assertion failed: %s\n", __FILE__,        \
                    __LINE__, #condition);                                     \
            return false;                                                       \
        }                                                                       \
    } while (0)

static UwbTwoStationSample make_sample(uint16_t range_mm,
                                       uint16_t station_address,
                                       bool target_address_valid,
                                       uint16_t target_address,
                                       int16_t snr_db,
                                       uint32_t timestamp_ms)
{
    UwbTwoStationSample sample;

    memset(&sample, 0, sizeof(sample));
    sample.range_mm = range_mm;
    sample.station_address = station_address;
    sample.target_address_valid = target_address_valid;
    sample.target_address = target_address;
    sample.snr_db = snr_db;
    sample.timestamp_ms = timestamp_ms;
    sample.snr_valid = true;
    return sample;
}

static uint16_t absolute_difference_u16(uint16_t first, uint16_t second)
{
    return (first >= second) ? (uint16_t)(first - second)
                             : (uint16_t)(second - first);
}

static bool push_station_ranges(UwbTwoStationEstimator *estimator,
                                uint8_t station, const uint16_t *ranges,
                                uint8_t count, int16_t snr_db,
                                uint32_t first_timestamp_ms,
                                uint32_t timestamp_step_ms)
{
    uint8_t index;

    for (index = 0U; index < count; index++) {
        UwbTwoStationSample sample = make_sample(
            ranges[index], estimator->model->station_address[station],
            true, 0x0A01U, snr_db,
            first_timestamp_ms +
                ((uint32_t)index * timestamp_step_ms));

        if (!uwb_two_station_estimator_push(estimator, station, &sample)) {
            return false;
        }
    }
    return true;
}

static bool push_constant_station(UwbTwoStationEstimator *estimator,
                                  uint8_t station, uint16_t range_mm,
                                  uint8_t count, int16_t snr_db,
                                  uint32_t first_timestamp_ms,
                                  uint32_t timestamp_step_ms)
{
    uint8_t index;

    for (index = 0U; index < count; index++) {
        UwbTwoStationSample sample = make_sample(
            range_mm, estimator->model->station_address[station],
            true, 0x0A01U, snr_db,
            first_timestamp_ms +
                ((uint32_t)index * timestamp_step_ms));

        if (!uwb_two_station_estimator_push(estimator, station, &sample)) {
            return false;
        }
    }
    return true;
}

static bool push_constant_pairs(UwbTwoStationEstimator *estimator,
                                uint16_t right_mm, uint16_t left_mm,
                                uint8_t count, int16_t left_snr_db,
                                uint32_t first_timestamp_ms,
                                uint32_t timestamp_step_ms)
{
    return push_constant_station(
               estimator, UWB_TWO_STATION_RIGHT, right_mm, count, 0,
               first_timestamp_ms, timestamp_step_ms) &&
           push_constant_station(
               estimator, UWB_TWO_STATION_LEFT, left_mm, count, left_snr_db,
               first_timestamp_ms, timestamp_step_ms);
}

static bool push_constant_station_without_snr(
    UwbTwoStationEstimator *estimator, uint8_t station,
    uint16_t range_mm, uint8_t count, bool target_address_valid,
    uint32_t first_timestamp_ms, uint32_t timestamp_step_ms)
{
    uint8_t index;

    for (index = 0U; index < count; index++) {
        UwbTwoStationSample sample = make_sample(
            range_mm, estimator->model->station_address[station],
            target_address_valid, 0x0A01U, 0,
            first_timestamp_ms +
                ((uint32_t)index * timestamp_step_ms));

        sample.snr_valid = false;
        if (!uwb_two_station_estimator_push(estimator, station, &sample)) {
            return false;
        }
    }
    return true;
}

static bool push_constant_pairs_without_snr(
    UwbTwoStationEstimator *estimator, uint16_t right_mm,
    uint16_t left_mm, uint8_t count, bool target_address_valid,
    uint32_t first_timestamp_ms, uint32_t timestamp_step_ms)
{
    return push_constant_station_without_snr(
               estimator, UWB_TWO_STATION_RIGHT, right_mm, count,
               target_address_valid, first_timestamp_ms,
               timestamp_step_ms) &&
           push_constant_station_without_snr(
               estimator, UWB_TWO_STATION_LEFT, left_mm, count,
               target_address_valid, first_timestamp_ms,
               timestamp_step_ms);
}

static bool push_pair(UwbTwoStationEstimator *estimator, uint16_t right_mm,
                      uint16_t left_mm, int16_t left_snr_db,
                      uint32_t timestamp_ms)
{
    return push_constant_pairs(estimator, right_mm, left_mm, 1U, left_snr_db,
                               timestamp_ms, 0U);
}

static bool run_three_stable_windows(UwbTwoStationEstimator *estimator,
                                     uint16_t right_mm, uint16_t left_mm,
                                     UwbTwoStationResult *result)
{
    if (!uwb_two_station_estimator_init(
            estimator, &g_two_station_model_20260731)) {
        return false;
    }
    if (!push_constant_pairs(estimator, right_mm, left_mm, 6U, 0, 100U,
                             20U) ||
        !uwb_two_station_estimator_update(estimator, 200U, result)) {
        return false;
    }
    if (!push_pair(estimator, right_mm, left_mm, 0, 300U) ||
        !uwb_two_station_estimator_update(estimator, 300U, result)) {
        return false;
    }
    if (!push_pair(estimator, right_mm, left_mm, 0, 400U)) {
        return false;
    }
    return uwb_two_station_estimator_update(estimator, 400U, result);
}

static bool test_model_crc_accepts_real_table_and_rejects_damage(void)
{
    UwbTwoStationEstimator estimator;
    UwbTwoStationModel damaged = g_two_station_model_20260731;
    UwbTwoStationResult result;

    TEST_ASSERT(g_two_station_model_20260731.prototype_count == 43U);
    TEST_ASSERT(g_two_station_model_20260731.serialized_bytes == 384U);
    TEST_ASSERT(g_two_station_model_20260731.crc32 == 0x91F6EF14UL);
    TEST_ASSERT(uwb_two_station_model_compute_crc32(
                    &g_two_station_model_20260731) ==
                g_two_station_model_20260731.crc32);
    TEST_ASSERT(
        uwb_two_station_model_is_valid(&g_two_station_model_20260731));
    TEST_ASSERT(uwb_two_station_estimator_init(
        &estimator, &g_two_station_model_20260731));

    damaged.window_ms = (uint16_t)(damaged.window_ms - 1U);
    TEST_ASSERT(uwb_two_station_model_compute_crc32(&damaged) !=
                damaged.crc32);
    TEST_ASSERT(!uwb_two_station_model_is_valid(&damaged));
    TEST_ASSERT(!uwb_two_station_estimator_init(&estimator, &damaged));
    TEST_ASSERT(
        uwb_two_station_estimator_update(&estimator, 0U, &result));
    TEST_ASSERT((result.failure_flags &
                 UWB_TWO_STATION_FAILURE_MODEL) != 0U);

    damaged = g_two_station_model_20260731;
    damaged.serialized_bytes = 383U;
    TEST_ASSERT(uwb_two_station_model_compute_crc32(&damaged) == 0U);
    TEST_ASSERT(!uwb_two_station_model_is_valid(&damaged));

    damaged = g_two_station_model_20260731;
    damaged.prototype_count = 42U;
    TEST_ASSERT(uwb_two_station_model_compute_crc32(&damaged) == 0U);
    TEST_ASSERT(!uwb_two_station_model_is_valid(&damaged));

    damaged = g_two_station_model_20260731;
    damaged.version = (uint16_t)(damaged.version + 1U);
    TEST_ASSERT(!uwb_two_station_model_is_valid(&damaged));

    damaged = g_two_station_model_20260731;
    damaged.crc32 ^= 1UL;
    TEST_ASSERT(!uwb_two_station_model_is_valid(&damaged));
    return true;
}

static bool test_lower3_ignores_large_positive_tail(void)
{
    static const uint16_t right_ranges[] = {
        2700U, 2010U, 2000U, 2600U, 2020U,
    };
    static const uint16_t left_ranges[] = {
        2800U, 2037U, 2027U, 2700U, 2047U,
    };
    UwbTwoStationEstimator estimator;
    UwbTwoStationResult result;

    TEST_ASSERT(uwb_two_station_estimator_init(
        &estimator, &g_two_station_model_20260731));
    TEST_ASSERT(push_station_ranges(
        &estimator, UWB_TWO_STATION_RIGHT, right_ranges, 5U, 0, 100U, 10U));
    TEST_ASSERT(push_station_ranges(
        &estimator, UWB_TWO_STATION_LEFT, left_ranges, 5U, 0, 100U, 10U));
    TEST_ASSERT(
        uwb_two_station_estimator_update(&estimator, 140U, &result));

    TEST_ASSERT(result.sample_count[UWB_TWO_STATION_RIGHT] == 5U);
    TEST_ASSERT(result.sample_count[UWB_TWO_STATION_LEFT] == 5U);
    TEST_ASSERT(result.feature_mm[UWB_TWO_STATION_RIGHT] == 2010U);
    TEST_ASSERT(result.feature_mm[UWB_TWO_STATION_LEFT] == 2037U);
    TEST_ASSERT(result.mad_mm[UWB_TWO_STATION_RIGHT] == 20U);
    TEST_ASSERT(result.mad_mm[UWB_TWO_STATION_LEFT] == 20U);
    TEST_ASSERT(result.distance_mm == 2000U);
    return true;
}

static bool test_real_table_4nn_near_dense_2m_prototype(void)
{
    UwbTwoStationEstimator estimator;
    UwbTwoStationResult result;

    TEST_ASSERT(uwb_two_station_estimator_init(
        &estimator, &g_two_station_model_20260731));
    TEST_ASSERT(push_constant_pairs(
        &estimator, 2110U, 2087U, 6U, 0, 100U, 20U));
    TEST_ASSERT(
        uwb_two_station_estimator_update(&estimator, 200U, &result));

    TEST_ASSERT(result.distance_mm == 2000U);
    TEST_ASSERT(result.neighbor_span_mm == 0U);
    TEST_ASSERT(result.nearest_q_milli >= 1U);
    TEST_ASSERT(result.nearest_q_milli <= 3U);
    TEST_ASSERT(result.distance_quality == UWB_DISTANCE_MEDIUM);
    return true;
}

static bool test_high_requires_three_consecutive_stable_windows(void)
{
    UwbTwoStationEstimator estimator;
    UwbTwoStationResult result;

    TEST_ASSERT(uwb_two_station_estimator_init(
        &estimator, &g_two_station_model_20260731));
    TEST_ASSERT(push_constant_pairs(
        &estimator, 2010U, 2037U, 6U, 0, 100U, 20U));

    TEST_ASSERT(
        uwb_two_station_estimator_update(&estimator, 200U, &result));
    TEST_ASSERT(result.distance_quality == UWB_DISTANCE_MEDIUM);
    TEST_ASSERT(result.distance_valid);
    TEST_ASSERT(!result.auth_distance_valid);
    TEST_ASSERT((result.failure_flags &
                 UWB_TWO_STATION_FAILURE_UNSTABLE) != 0U);

    TEST_ASSERT(push_pair(&estimator, 2010U, 2037U, 0, 300U));
    TEST_ASSERT(
        uwb_two_station_estimator_update(&estimator, 300U, &result));
    TEST_ASSERT(result.distance_quality == UWB_DISTANCE_MEDIUM);
    TEST_ASSERT(!result.auth_distance_valid);

    TEST_ASSERT(push_pair(&estimator, 2010U, 2037U, 0, 400U));
    TEST_ASSERT(
        uwb_two_station_estimator_update(&estimator, 400U, &result));
    TEST_ASSERT(result.distance_quality == UWB_DISTANCE_HIGH);
    TEST_ASSERT(result.distance_valid);
    TEST_ASSERT(result.auth_distance_valid);
    TEST_ASSERT(!result.held);
    return true;
}

static bool test_medium_distance_never_authorizes(void)
{
    UwbTwoStationEstimator estimator;
    UwbTwoStationResult result;

    TEST_ASSERT(uwb_two_station_estimator_init(
        &estimator, &g_two_station_model_20260731));
    TEST_ASSERT(push_constant_pairs(
        &estimator, 2010U, 2037U, 5U, 0, 100U, 10U));
    TEST_ASSERT(
        uwb_two_station_estimator_update(&estimator, 140U, &result));

    TEST_ASSERT(result.distance_quality == UWB_DISTANCE_MEDIUM);
    TEST_ASSERT(result.distance_valid);
    TEST_ASSERT(!result.auth_distance_valid);
    TEST_ASSERT(!result.held);
    return true;
}

static bool test_reject_holds_display_through_500ms_then_expires(void)
{
    UwbTwoStationEstimator estimator;
    UwbTwoStationResult result;

    TEST_ASSERT(run_three_stable_windows(
        &estimator, 2010U, 2037U, &result));
    TEST_ASSERT(result.distance_quality == UWB_DISTANCE_HIGH);
    TEST_ASSERT(result.auth_distance_valid);

    TEST_ASSERT(push_constant_station(
        &estimator, UWB_TWO_STATION_RIGHT, 2010U, 1U, 0, 600U, 0U));
    TEST_ASSERT(
        uwb_two_station_estimator_update(&estimator, 600U, &result));
    TEST_ASSERT(result.distance_quality == UWB_DISTANCE_REJECT);
    TEST_ASSERT(result.distance_valid);
    TEST_ASSERT(!result.auth_distance_valid);
    TEST_ASSERT(result.held);
    TEST_ASSERT(result.age_ms == 200U);
    TEST_ASSERT((result.failure_flags &
                 UWB_TWO_STATION_FAILURE_PAIR_SKEW) != 0U);
    TEST_ASSERT((result.failure_flags &
                 UWB_TWO_STATION_FAILURE_HELD) != 0U);

    TEST_ASSERT(
        uwb_two_station_estimator_update(&estimator, 900U, &result));
    TEST_ASSERT(result.distance_quality == UWB_DISTANCE_REJECT);
    TEST_ASSERT(result.distance_valid);
    TEST_ASSERT(result.held);
    TEST_ASSERT(result.age_ms == 500U);

    TEST_ASSERT(
        uwb_two_station_estimator_update(&estimator, 1000U, &result));
    TEST_ASSERT(result.distance_quality == UWB_DISTANCE_REJECT);
    TEST_ASSERT(!result.distance_valid);
    TEST_ASSERT(!result.auth_distance_valid);
    TEST_ASSERT(!result.held);
    TEST_ASSERT((result.failure_flags &
                 UWB_TWO_STATION_FAILURE_STALE) != 0U);
    return true;
}

static bool test_address_mismatch_is_rejected_and_reported(void)
{
    UwbTwoStationEstimator estimator;
    UwbTwoStationResult result;
    UwbTwoStationSample sample;

    TEST_ASSERT(uwb_two_station_estimator_init(
        &estimator, &g_two_station_model_20260731));
    sample = make_sample(
        2010U, 0x0101U, true, 0x0A01U, 0, 100U);
    TEST_ASSERT(!uwb_two_station_estimator_push(
        &estimator, UWB_TWO_STATION_RIGHT, &sample));
    TEST_ASSERT(
        estimator.history[UWB_TWO_STATION_RIGHT].count == 0U);
    TEST_ASSERT(
        uwb_two_station_estimator_update(&estimator, 100U, &result));
    TEST_ASSERT((result.failure_flags &
                 UWB_TWO_STATION_FAILURE_ADDRESS) != 0U);
    TEST_ASSERT((result.failure_flags &
                 UWB_TWO_STATION_FAILURE_INSUFFICIENT_SAMPLES) != 0U);
    return true;
}

static bool test_target_mismatch_resets_history_and_reports_failure(void)
{
    UwbTwoStationEstimator estimator;
    UwbTwoStationResult result;
    UwbTwoStationSample right;
    UwbTwoStationSample left;

    TEST_ASSERT(uwb_two_station_estimator_init(
        &estimator, &g_two_station_model_20260731));
    right = make_sample(
        2010U,
        g_two_station_model_20260731
            .station_address[UWB_TWO_STATION_RIGHT],
        true, 0x0A01U, 0, 100U);
    left = make_sample(
        2037U,
        g_two_station_model_20260731
            .station_address[UWB_TWO_STATION_LEFT],
        true, 0x0A02U, 0, 101U);

    TEST_ASSERT(uwb_two_station_estimator_push(
        &estimator, UWB_TWO_STATION_RIGHT, &right));
    TEST_ASSERT(estimator.history[UWB_TWO_STATION_RIGHT].count == 1U);
    TEST_ASSERT(uwb_two_station_estimator_push(
        &estimator, UWB_TWO_STATION_LEFT, &left));
    TEST_ASSERT(estimator.history[UWB_TWO_STATION_RIGHT].count == 0U);
    TEST_ASSERT(estimator.history[UWB_TWO_STATION_LEFT].count == 1U);
    TEST_ASSERT(
        uwb_two_station_estimator_update(&estimator, 101U, &result));
    TEST_ASSERT((result.failure_flags &
                 UWB_TWO_STATION_FAILURE_TARGET) != 0U);
    TEST_ASSERT((result.failure_flags &
                 UWB_TWO_STATION_FAILURE_INSUFFICIENT_SAMPLES) != 0U);
    TEST_ASSERT(!result.distance_valid);
    TEST_ASSERT(!result.auth_distance_valid);
    return true;
}

static bool test_pair_skew_over_120ms_is_rejected(void)
{
    UwbTwoStationEstimator estimator;
    UwbTwoStationResult result;

    TEST_ASSERT(uwb_two_station_estimator_init(
        &estimator, &g_two_station_model_20260731));
    TEST_ASSERT(push_constant_station(
        &estimator, UWB_TWO_STATION_RIGHT, 2010U, 3U, 0, 100U, 125U));
    TEST_ASSERT(push_constant_station(
        &estimator, UWB_TWO_STATION_LEFT, 2037U, 3U, 0, 100U, 50U));
    TEST_ASSERT(
        uwb_two_station_estimator_update(&estimator, 350U, &result));

    TEST_ASSERT(result.distance_quality == UWB_DISTANCE_REJECT);
    TEST_ASSERT(!result.distance_valid);
    TEST_ASSERT((result.failure_flags &
                 UWB_TWO_STATION_FAILURE_PAIR_SKEW) != 0U);
    return true;
}

static bool test_left_snr_below_negative_threshold_is_rejected(void)
{
    UwbTwoStationEstimator estimator;
    UwbTwoStationResult result;

    TEST_ASSERT(uwb_two_station_estimator_init(
        &estimator, &g_two_station_model_20260731));
    TEST_ASSERT(push_constant_pairs(
        &estimator, 2010U, 2037U, 6U, -7, 100U, 20U));
    TEST_ASSERT(
        uwb_two_station_estimator_update(&estimator, 200U, &result));

    TEST_ASSERT(result.snr_db[UWB_TWO_STATION_LEFT] == -7);
    TEST_ASSERT(result.distance_quality == UWB_DISTANCE_REJECT);
    TEST_ASSERT(!result.distance_valid);
    TEST_ASSERT(!result.auth_distance_valid);
    TEST_ASSERT((result.failure_flags &
                 UWB_TWO_STATION_FAILURE_SNR) != 0U);
    return true;
}

static bool test_official_no_snr_profile_requires_shared_target(void)
{
    UwbTwoStationEstimator estimator;
    UwbTwoStationResult result;

    TEST_ASSERT(uwb_two_station_estimator_init(
        &estimator, &g_two_station_model_20260731));
    TEST_ASSERT(push_constant_pairs_without_snr(
        &estimator, 2010U, 2037U, 6U, true, 100U, 20U));
    TEST_ASSERT(
        uwb_two_station_estimator_update(&estimator, 200U, &result));
    TEST_ASSERT(result.target_address_valid);
    TEST_ASSERT(result.target_address == 0x0A01U);
    TEST_ASSERT(result.distance_quality == UWB_DISTANCE_MEDIUM);
    TEST_ASSERT(result.distance_valid);
    TEST_ASSERT(!result.auth_distance_valid);
    TEST_ASSERT((result.failure_flags &
                 UWB_TWO_STATION_FAILURE_SNR) == 0U);

    TEST_ASSERT(push_constant_pairs_without_snr(
        &estimator, 2010U, 2037U, 1U, true, 300U, 0U));
    TEST_ASSERT(
        uwb_two_station_estimator_update(&estimator, 300U, &result));
    TEST_ASSERT(result.distance_quality == UWB_DISTANCE_MEDIUM);
    TEST_ASSERT(!result.auth_distance_valid);

    TEST_ASSERT(push_constant_pairs_without_snr(
        &estimator, 2010U, 2037U, 1U, true, 400U, 0U));
    TEST_ASSERT(
        uwb_two_station_estimator_update(&estimator, 400U, &result));
    TEST_ASSERT(result.distance_quality == UWB_DISTANCE_HIGH);
    TEST_ASSERT(result.distance_valid);
    TEST_ASSERT(result.auth_distance_valid);

    TEST_ASSERT(uwb_two_station_estimator_init(
        &estimator, &g_two_station_model_20260731));
    TEST_ASSERT(push_constant_pairs_without_snr(
        &estimator, 2010U, 2037U, 6U, false, 100U, 20U));
    TEST_ASSERT(
        uwb_two_station_estimator_update(&estimator, 200U, &result));
    TEST_ASSERT(!result.target_address_valid);
    TEST_ASSERT(result.distance_quality == UWB_DISTANCE_REJECT);
    TEST_ASSERT(!result.distance_valid);
    TEST_ASSERT(!result.auth_distance_valid);
    TEST_ASSERT((result.failure_flags &
                 UWB_TWO_STATION_FAILURE_SNR) != 0U);
    return true;
}

static bool test_angle_reports_two_diagnostic_buckets_but_never_valid(void)
{
    UwbTwoStationEstimator estimator;
    UwbTwoStationResult result;

    TEST_ASSERT(uwb_two_station_estimator_init(
        &estimator, &g_two_station_model_20260731));
    TEST_ASSERT(push_constant_pairs(
        &estimator, 2010U, 2037U, 6U, 0, 100U, 20U));
    TEST_ASSERT(
        uwb_two_station_estimator_update(&estimator, 200U, &result));

    TEST_ASSERT(result.angle_candidate_1_deg == 0);
    TEST_ASSERT(result.angle_candidate_2_deg !=
                UWB_TWO_STATION_INVALID_ANGLE_DEG);
    TEST_ASSERT(result.angle_candidate_1_deg !=
                result.angle_candidate_2_deg);
    TEST_ASSERT(result.angle_confidence > 0U);
    TEST_ASSERT(result.angle_confidence < 100U);
    TEST_ASSERT(result.angle_candidate_1_weight ==
                result.angle_confidence);
    TEST_ASSERT(result.angle_candidate_2_weight > 0U);
    TEST_ASSERT(result.angle_candidate_span_deg > 0U);
    TEST_ASSERT(!result.angle_valid);
    TEST_ASSERT(!result.angle_auth_valid);
    return true;
}

static bool test_2m_minus15_plus40_alias_keeps_angle_untrusted(void)
{
    UwbTwoStationEstimator minus15_estimator;
    UwbTwoStationEstimator plus40_estimator;
    UwbTwoStationResult minus15;
    UwbTwoStationResult plus40;

    TEST_ASSERT(run_three_stable_windows(
        &minus15_estimator, 1803U, 2002U, &minus15));
    TEST_ASSERT(run_three_stable_windows(
        &plus40_estimator, 1837U, 2020U, &plus40));

    TEST_ASSERT(minus15.distance_quality == UWB_DISTANCE_HIGH);
    TEST_ASSERT(plus40.distance_quality == UWB_DISTANCE_HIGH);
    TEST_ASSERT(minus15.auth_distance_valid);
    TEST_ASSERT(plus40.auth_distance_valid);
    TEST_ASSERT(minus15.distance_mm >= 1950U);
    TEST_ASSERT(minus15.distance_mm <= 2000U);
    TEST_ASSERT(plus40.distance_mm >= 1950U);
    TEST_ASSERT(plus40.distance_mm <= 2000U);
    TEST_ASSERT(absolute_difference_u16(minus15.distance_mm,
                                        plus40.distance_mm) <= 20U);
    TEST_ASSERT((uint16_t)(plus40.feature_mm[UWB_TWO_STATION_RIGHT] -
                           minus15.feature_mm[UWB_TWO_STATION_RIGHT]) ==
                34U);
    TEST_ASSERT((uint16_t)(plus40.feature_mm[UWB_TWO_STATION_LEFT] -
                           minus15.feature_mm[UWB_TWO_STATION_LEFT]) ==
                18U);
    TEST_ASSERT(minus15.angle_candidate_1_deg == -15);
    TEST_ASSERT(plus40.angle_candidate_1_deg == 45);
    TEST_ASSERT(!minus15.angle_valid);
    TEST_ASSERT(!plus40.angle_valid);
    TEST_ASSERT(!minus15.angle_auth_valid);
    TEST_ASSERT(!plus40.angle_auth_valid);
    return true;
}

typedef bool (*TestFunction)(void);

typedef struct {
    const char *name;
    TestFunction function;
} TestCase;

int main(void)
{
    static const TestCase tests[] = {
        {"model CRC accepts real table and rejects damage",
         test_model_crc_accepts_real_table_and_rejects_damage},
        {"lower-3 ignores large positive tail",
         test_lower3_ignores_large_positive_tail},
        {"real-table 4NN near dense 2 m prototype",
         test_real_table_4nn_near_dense_2m_prototype},
        {"HIGH requires three consecutive stable windows",
         test_high_requires_three_consecutive_stable_windows},
        {"MEDIUM distance never authorizes",
         test_medium_distance_never_authorizes},
        {"REJECT holds display through 500 ms then expires",
         test_reject_holds_display_through_500ms_then_expires},
        {"address mismatch is rejected and reported",
         test_address_mismatch_is_rejected_and_reported},
        {"target mismatch resets history and is reported",
         test_target_mismatch_resets_history_and_reports_failure},
        {"pair skew over 120 ms is rejected",
         test_pair_skew_over_120ms_is_rejected},
        {"negative left SNR is rejected",
         test_left_snr_below_negative_threshold_is_rejected},
        {"official no-SNR profile requires one shared target",
         test_official_no_snr_profile_requires_shared_target},
        {"angle reports two diagnostic buckets but stays invalid",
         test_angle_reports_two_diagnostic_buckets_but_never_valid},
        {"2 m -15/+40 alias keeps angle untrusted",
         test_2m_minus15_plus40_alias_keeps_angle_untrusted},
    };
    size_t index;
    unsigned int failures = 0U;

    for (index = 0U; index < (sizeof(tests) / sizeof(tests[0])); index++) {
        if (tests[index].function()) {
            printf("PASS %s\n", tests[index].name);
        } else {
            printf("FAIL %s\n", tests[index].name);
            failures++;
        }
    }

    printf("%u assertions, %u failures\n", g_assertions, failures);
    return (failures == 0U) ? 0 : 1;
}
