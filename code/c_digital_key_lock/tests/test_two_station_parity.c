#include "two_station_model_data.h"
#include "uwb_two_station_estimator.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef struct {
    double q;
    uint16_t index;
} ReferenceNeighbor;

static unsigned int g_assertions;
static unsigned int g_vectors;
static double g_max_error_mm;

#define TEST_ASSERT(condition)                                                  \
    do {                                                                        \
        g_assertions++;                                                         \
        if (!(condition)) {                                                     \
            fprintf(stderr, "%s:%d: assertion failed: %s\n", __FILE__,        \
                    __LINE__, #condition);                                     \
            return false;                                                       \
        }                                                                       \
    } while (0)

static double absolute_double(double value)
{
    return (value < 0.0) ? -value : value;
}

static void insert_reference_neighbor(ReferenceNeighbor *neighbors,
                                      double q, uint16_t index)
{
    uint8_t position;

    for (position = 0U; position < UWB_TWO_STATION_NEIGHBOR_COUNT;
         position++) {
        if (q < neighbors[position].q) {
            uint8_t move;

            for (move = UWB_TWO_STATION_NEIGHBOR_COUNT - 1U;
                 move > position; move--) {
                neighbors[move] = neighbors[move - 1U];
            }
            neighbors[position].q = q;
            neighbors[position].index = index;
            break;
        }
    }
}

static void reference_estimate(uint16_t right_mm, uint16_t left_mm,
                               double *distance_mm,
                               double *nearest_q,
                               uint16_t *neighbor_span_mm)
{
    const UwbTwoStationModel *model =
        &g_two_station_model_20260731;
    ReferenceNeighbor neighbors[UWB_TWO_STATION_NEIGHBOR_COUNT];
    double scale_right =
        (double)model->scale_right_q16 / 65536.0;
    double scale_left =
        (double)model->scale_left_q16 / 65536.0;
    double q_floor =
        (double)model->q_floor_q24 / 16777216.0;
    double weighted_distance = 0.0;
    double total_weight = 0.0;
    uint16_t minimum_distance = UINT16_MAX;
    uint16_t maximum_distance = 0U;
    uint16_t prototype_index;
    uint8_t neighbor_index;

    for (neighbor_index = 0U;
         neighbor_index < UWB_TWO_STATION_NEIGHBOR_COUNT;
         neighbor_index++) {
        neighbors[neighbor_index].q = 1.0e30;
        neighbors[neighbor_index].index = 0U;
    }

    for (prototype_index = 0U;
         prototype_index < model->prototype_count;
         prototype_index++) {
        const UwbTwoStationPrototype *prototype =
            &model->prototypes[prototype_index];
        double right_delta =
            (double)right_mm - (double)prototype->right_mm;
        double left_delta =
            (double)left_mm - (double)prototype->left_mm;
        double q =
            (right_delta / scale_right) *
                (right_delta / scale_right) +
            (left_delta / scale_left) *
                (left_delta / scale_left);

        insert_reference_neighbor(
            neighbors, q, prototype_index);
    }

    for (neighbor_index = 0U;
         neighbor_index < UWB_TWO_STATION_NEIGHBOR_COUNT;
         neighbor_index++) {
        const UwbTwoStationPrototype *prototype =
            &model->prototypes[neighbors[neighbor_index].index];
        double denominator =
            (neighbors[neighbor_index].q < q_floor)
                ? q_floor
                : neighbors[neighbor_index].q;
        double weight = 1.0 / denominator;

        weighted_distance +=
            weight * (double)prototype->distance_mm;
        total_weight += weight;
        if (prototype->distance_mm < minimum_distance) {
            minimum_distance = prototype->distance_mm;
        }
        if (prototype->distance_mm > maximum_distance) {
            maximum_distance = prototype->distance_mm;
        }
    }

    *distance_mm = weighted_distance / total_weight;
    if (*distance_mm < model->minimum_distance_mm) {
        *distance_mm = model->minimum_distance_mm;
    } else if (*distance_mm > model->maximum_distance_mm) {
        *distance_mm = model->maximum_distance_mm;
    }
    *nearest_q = neighbors[0].q;
    *neighbor_span_mm =
        (uint16_t)(maximum_distance - minimum_distance);
}

static bool push_pair(UwbTwoStationEstimator *estimator,
                      uint16_t right_mm, uint16_t left_mm,
                      uint32_t timestamp_ms)
{
    UwbTwoStationSample right;
    UwbTwoStationSample left;

    memset(&right, 0, sizeof(right));
    memset(&left, 0, sizeof(left));
    right.range_mm = right_mm;
    right.station_address =
        estimator->model->station_address[UWB_TWO_STATION_RIGHT];
    right.target_address_valid = true;
    right.target_address = 0x0A01U;
    right.snr_valid = true;
    right.snr_db = 0;
    right.timestamp_ms = timestamp_ms;
    left.range_mm = left_mm;
    left.station_address =
        estimator->model->station_address[UWB_TWO_STATION_LEFT];
    left.target_address_valid = true;
    left.target_address = 0x0A01U;
    left.snr_valid = true;
    left.snr_db = 0;
    left.timestamp_ms = timestamp_ms;

    return uwb_two_station_estimator_push(
               estimator, UWB_TWO_STATION_RIGHT, &right) &&
           uwb_two_station_estimator_push(
               estimator, UWB_TWO_STATION_LEFT, &left);
}

static bool evaluate_vector(uint16_t right_mm, uint16_t left_mm)
{
    UwbTwoStationEstimator estimator;
    UwbTwoStationResult result;
    double reference_distance;
    double nearest_q;
    double distance_error;
    uint16_t neighbor_span;
    uint16_t feature_delta =
        (right_mm >= left_mm) ? (uint16_t)(right_mm - left_mm)
                              : (uint16_t)(left_mm - right_mm);
    UwbDistanceQuality reference_quality;
    uint8_t index;

    reference_estimate(
        right_mm, left_mm, &reference_distance, &nearest_q,
        &neighbor_span);
    if ((absolute_double(nearest_q - 0.4) < 0.002) ||
        (feature_delta == 300U) || (feature_delta == 500U)) {
        return true;
    }

    TEST_ASSERT(uwb_two_station_estimator_init(
        &estimator, &g_two_station_model_20260731));
    for (index = 0U; index < 6U; index++) {
        TEST_ASSERT(push_pair(
            &estimator, right_mm, left_mm,
            100U + ((uint32_t)index * 20U)));
    }
    TEST_ASSERT(
        uwb_two_station_estimator_update(&estimator, 200U, &result));
    TEST_ASSERT(push_pair(&estimator, right_mm, left_mm, 300U));
    TEST_ASSERT(
        uwb_two_station_estimator_update(&estimator, 300U, &result));
    TEST_ASSERT(push_pair(&estimator, right_mm, left_mm, 400U));
    TEST_ASSERT(
        uwb_two_station_estimator_update(&estimator, 400U, &result));

    if ((feature_delta <= 300U) && (nearest_q <= 0.4) &&
        (neighbor_span <= 400U)) {
        reference_quality = UWB_DISTANCE_HIGH;
    } else if ((feature_delta <= 500U) &&
               (neighbor_span <= 400U)) {
        reference_quality = UWB_DISTANCE_MEDIUM;
    } else {
        reference_quality = UWB_DISTANCE_REJECT;
    }

    distance_error = absolute_double(
        (double)result.distance_mm - reference_distance);
    if (distance_error > g_max_error_mm) {
        g_max_error_mm = distance_error;
    }
    g_vectors++;
    TEST_ASSERT(distance_error <= 3.0);
    TEST_ASSERT(result.distance_quality == reference_quality);
    TEST_ASSERT(
        result.auth_distance_valid ==
        (reference_quality == UWB_DISTANCE_HIGH));
    TEST_ASSERT(!result.angle_valid);
    TEST_ASSERT(!result.angle_auth_valid);
    return true;
}

static bool test_dense_working_domain_parity(void)
{
    uint16_t right_mm;

    for (right_mm = 650U; right_mm <= 4600U;
         right_mm = (uint16_t)(right_mm + 113U)) {
        uint16_t left_mm;

        for (left_mm = 650U; left_mm <= 4600U;
             left_mm = (uint16_t)(left_mm + 127U)) {
            if (!evaluate_vector(right_mm, left_mm)) {
                return false;
            }
        }
    }
    TEST_ASSERT(g_vectors >= 1000U);
    return true;
}

int main(void)
{
    bool passed = test_dense_working_domain_parity();

    if (passed) {
        printf("PASS dense fixed-point/offline parity\n");
    } else {
        printf("FAIL dense fixed-point/offline parity\n");
    }
    printf("%u vectors, max error %.3f mm, %u assertions\n",
           g_vectors, g_max_error_mm, g_assertions);
    return passed ? 0 : 1;
}
