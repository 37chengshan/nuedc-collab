#ifndef UWB_TWO_STATION_ESTIMATOR_H
#define UWB_TWO_STATION_ESTIMATOR_H

#include <stdbool.h>
#include <stdint.h>

#define UWB_TWO_STATION_COUNT 2U
#define UWB_TWO_STATION_RIGHT 0U
#define UWB_TWO_STATION_LEFT 1U
#define UWB_TWO_STATION_HISTORY_CAPACITY 24U
#define UWB_TWO_STATION_MAX_PROTOTYPES 64U
#define UWB_TWO_STATION_NEIGHBOR_COUNT 4U
#define UWB_TWO_STATION_INVALID_ANGLE_DEG INT16_MIN
#define UWB_TWO_STATION_EXPECTED_PROTOTYPES 43U
#define UWB_TWO_STATION_MODEL_SERIALIZED_BYTES 384U

#define UWB_TWO_STATION_MODEL_MAGIC 0x32425755UL
#define UWB_TWO_STATION_MODEL_VERSION 0x0100U

typedef enum {
    UWB_DISTANCE_REJECT = 0,
    UWB_DISTANCE_MEDIUM,
    UWB_DISTANCE_HIGH
} UwbDistanceQuality;

enum {
    UWB_TWO_STATION_FAILURE_NONE = 0U,
    UWB_TWO_STATION_FAILURE_MODEL = 1U << 0,
    UWB_TWO_STATION_FAILURE_INSUFFICIENT_SAMPLES = 1U << 1,
    UWB_TWO_STATION_FAILURE_PAIR_SKEW = 1U << 2,
    UWB_TWO_STATION_FAILURE_SNR = 1U << 3,
    UWB_TWO_STATION_FAILURE_MAD = 1U << 4,
    UWB_TWO_STATION_FAILURE_FEATURE_DELTA = 1U << 5,
    UWB_TWO_STATION_FAILURE_MODEL_DISTANCE = 1U << 6,
    UWB_TWO_STATION_FAILURE_NEIGHBOR_SPAN = 1U << 7,
    UWB_TWO_STATION_FAILURE_UNSTABLE = 1U << 8,
    UWB_TWO_STATION_FAILURE_HELD = 1U << 9,
    UWB_TWO_STATION_FAILURE_ADDRESS = 1U << 10,
    UWB_TWO_STATION_FAILURE_STALE = 1U << 11,
    UWB_TWO_STATION_FAILURE_TARGET = 1U << 12,
    UWB_TWO_STATION_FAILURE_BUFFER_OVERFLOW = 1U << 13
};

typedef struct {
    uint16_t right_mm;
    uint16_t left_mm;
    uint16_t distance_mm;
    int8_t angle_deg;
    uint8_t reserved;
} UwbTwoStationPrototype;

typedef struct {
    uint32_t magic;
    uint16_t version;
    uint16_t prototype_count;
    uint16_t serialized_bytes;
    uint16_t station_address[UWB_TWO_STATION_COUNT];
    uint16_t window_ms;
    uint16_t pair_skew_ms;
    uint16_t update_period_ms;
    uint16_t hold_ms;
    uint32_t scale_right_q16;
    uint32_t scale_left_q16;
    uint32_t q_floor_q24;
    uint32_t high_nearest_q24;
    uint16_t minimum_distance_mm;
    uint16_t maximum_distance_mm;
    uint32_t crc32;
    const UwbTwoStationPrototype *prototypes;
} UwbTwoStationModel;

typedef struct {
    uint16_t range_mm;
    uint16_t station_address;
    uint16_t target_address;
    int16_t snr_db;
    uint32_t timestamp_ms;
    bool snr_valid;
    bool target_address_valid;
} UwbTwoStationSample;

typedef struct {
    UwbTwoStationSample samples[UWB_TWO_STATION_HISTORY_CAPACITY];
    uint8_t count;
    uint8_t write_index;
} UwbTwoStationHistory;

typedef struct {
    uint16_t feature_mm;
    uint16_t mad_mm;
    int16_t snr_db;
    uint16_t station_address;
    uint16_t target_address;
    uint32_t latest_timestamp_ms;
    uint8_t sample_count;
    bool snr_valid;
    bool target_address_valid;
} UwbTwoStationLinkStats;

typedef struct {
    bool distance_valid;
    bool auth_distance_valid;
    bool held;
    bool angle_valid;
    bool angle_auth_valid;
    bool target_address_valid;
    UwbDistanceQuality distance_quality;
    uint16_t distance_mm;
    uint16_t target_address;
    int16_t angle_candidate_1_deg;
    int16_t angle_candidate_2_deg;
    uint8_t angle_confidence;
    uint8_t angle_candidate_1_weight;
    uint8_t angle_candidate_2_weight;
    uint8_t angle_candidate_span_deg;
    uint8_t valid_mask;
    uint8_t sample_count[UWB_TWO_STATION_COUNT];
    uint16_t mad_mm[UWB_TWO_STATION_COUNT];
    int16_t snr_db[UWB_TWO_STATION_COUNT];
    uint16_t feature_mm[UWB_TWO_STATION_COUNT];
    uint16_t nearest_q_milli;
    uint16_t neighbor_span_mm;
    uint16_t age_ms;
    uint16_t model_version;
    uint16_t model_bytes;
    uint32_t model_crc32;
    uint32_t failure_flags;
    uint32_t updated_ms;
} UwbTwoStationResult;

typedef struct {
    const UwbTwoStationModel *model;
    UwbTwoStationHistory history[UWB_TWO_STATION_COUNT];
    uint16_t recent_distance_mm[3];
    uint8_t recent_distance_count;
    uint8_t recent_distance_index;
    uint32_t last_update_ms;
    uint32_t input_failure_flags;
    bool initialized;
    bool has_result;
    bool has_trusted_result;
    bool target_context_initialized;
    bool active_target_valid;
    uint16_t active_target_address;
    UwbTwoStationResult result;
    UwbTwoStationResult trusted_result;
    uint32_t trusted_result_ms;
} UwbTwoStationEstimator;

uint32_t uwb_two_station_model_compute_crc32(
    const UwbTwoStationModel *model);
bool uwb_two_station_model_is_valid(const UwbTwoStationModel *model);
bool uwb_two_station_estimator_init(UwbTwoStationEstimator *estimator,
                                    const UwbTwoStationModel *model);
bool uwb_two_station_estimator_push(UwbTwoStationEstimator *estimator,
                                    uint8_t station,
                                    const UwbTwoStationSample *sample);
bool uwb_two_station_estimator_update(UwbTwoStationEstimator *estimator,
                                      uint32_t now_ms,
                                      UwbTwoStationResult *result);
const UwbTwoStationResult *uwb_two_station_estimator_result(
    const UwbTwoStationEstimator *estimator);
void uwb_two_station_estimator_report_failure(
    UwbTwoStationEstimator *estimator, uint32_t failure_flags);

#endif
