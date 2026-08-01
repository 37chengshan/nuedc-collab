#ifndef UWB_FOUR_STATION_ESTIMATOR_H
#define UWB_FOUR_STATION_ESTIMATOR_H

#include <stdbool.h>
#include <stdint.h>

#define UWB_FOUR_STATION_COUNT 4U
#define UWB_FOUR_STATION_HISTORY_CAPACITY 24U
#define UWB_FOUR_STATION_NEIGHBOR_COUNT 3U
#define UWB_FOUR_STATION_EXPECTED_PROTOTYPES 27U
#define UWB_FOUR_STATION_MODEL_SERIALIZED_BYTES 408U

#define UWB_FOUR_STATION_MODEL_MAGIC 0x34535755UL
#define UWB_FOUR_STATION_MODEL_VERSION 0x0100U

typedef enum {
    UWB_FOUR_DISTANCE_REJECT = 0,
    UWB_FOUR_DISTANCE_MEDIUM,
    UWB_FOUR_DISTANCE_HIGH
} UwbFourDistanceQuality;

enum {
    UWB_FOUR_FAILURE_NONE = 0U,
    UWB_FOUR_FAILURE_MODEL = 1U << 0,
    UWB_FOUR_FAILURE_SAMPLES = 1U << 1,
    UWB_FOUR_FAILURE_SKEW = 1U << 2,
    UWB_FOUR_FAILURE_MAD = 1U << 3,
    UWB_FOUR_FAILURE_NEIGHBOR = 1U << 4,
    UWB_FOUR_FAILURE_UNSTABLE = 1U << 5,
    UWB_FOUR_FAILURE_STALE = 1U << 6,
    UWB_FOUR_FAILURE_ADDRESS = 1U << 7,
    UWB_FOUR_FAILURE_OVERFLOW = 1U << 8,
    UWB_FOUR_FAILURE_HELD = 1U << 9
};

typedef struct {
    uint16_t range_mm[UWB_FOUR_STATION_COUNT];
    uint16_t center_distance_mm;
    int16_t angle_deg_x10;
} UwbFourStationPrototype;

typedef struct {
    uint32_t magic;
    uint16_t version;
    uint16_t prototype_count;
    uint16_t serialized_bytes;
    uint16_t station_address[UWB_FOUR_STATION_COUNT];
    uint16_t window_ms;
    uint16_t pair_skew_ms;
    uint16_t update_period_ms;
    uint16_t hold_ms;
    uint32_t scale_q16[UWB_FOUR_STATION_COUNT];
    uint32_t q_floor_q24;
    uint32_t high_nearest_q24;
    uint16_t minimum_distance_mm;
    uint16_t maximum_distance_mm;
    uint16_t angle_mean_mm[UWB_FOUR_STATION_COUNT];
    int32_t angle_coefficient_q16[UWB_FOUR_STATION_COUNT + 1U];
    uint16_t angle_scale_mm;
    uint32_t crc32;
    const UwbFourStationPrototype *prototypes;
} UwbFourStationModel;

typedef struct {
    uint16_t range_mm;
    uint16_t station_address;
    uint16_t target_address;
    int16_t snr_db;
    uint32_t timestamp_ms;
    bool snr_valid;
    bool target_address_valid;
} UwbFourStationSample;

typedef struct {
    UwbFourStationSample samples[UWB_FOUR_STATION_HISTORY_CAPACITY];
    uint8_t count;
    uint8_t write_index;
} UwbFourStationHistory;

typedef struct {
    uint16_t feature_mm;
    uint16_t mad_mm;
    int16_t snr_db;
    uint32_t latest_timestamp_ms;
    uint8_t sample_count;
    bool snr_valid;
} UwbFourStationLinkStats;

typedef struct {
    bool distance_valid;
    bool auth_distance_valid;
    bool held;
    bool angle_valid;
    bool angle_auth_valid;
    UwbFourDistanceQuality distance_quality;
    uint16_t center_distance_mm;
    uint16_t boundary_distance_mm;
    int16_t angle_deg_x10;
    int16_t local_angle_deg_x10;
    uint8_t angle_confidence;
    uint8_t valid_mask;
    uint8_t sample_count[UWB_FOUR_STATION_COUNT];
    uint16_t mad_mm[UWB_FOUR_STATION_COUNT];
    int16_t snr_db[UWB_FOUR_STATION_COUNT];
    uint16_t feature_mm[UWB_FOUR_STATION_COUNT];
    uint16_t nearest_q_milli;
    uint16_t neighbor_span_mm;
    uint16_t age_ms;
    uint16_t model_version;
    uint16_t model_bytes;
    uint32_t model_crc32;
    uint32_t failure_flags;
    uint32_t updated_ms;
} UwbFourStationResult;

typedef struct {
    const UwbFourStationModel *model;
    UwbFourStationHistory history[UWB_FOUR_STATION_COUNT];
    uint16_t recent_distance_mm[3];
    uint8_t recent_distance_count;
    uint8_t recent_distance_index;
    uint32_t last_update_ms;
    uint32_t input_failure_flags;
    bool initialized;
    bool has_result;
    bool has_trusted_result;
    UwbFourStationResult result;
    UwbFourStationResult trusted_result;
    uint32_t trusted_result_ms;
} UwbFourStationEstimator;

uint32_t uwb_four_station_model_compute_crc32(
    const UwbFourStationModel *model);
bool uwb_four_station_model_is_valid(const UwbFourStationModel *model);
bool uwb_four_station_estimator_init(UwbFourStationEstimator *estimator,
                                     const UwbFourStationModel *model);
bool uwb_four_station_estimator_push(UwbFourStationEstimator *estimator,
                                     uint8_t station,
                                     const UwbFourStationSample *sample);
bool uwb_four_station_estimator_update(UwbFourStationEstimator *estimator,
                                       uint32_t now_ms,
                                       UwbFourStationResult *result);
const UwbFourStationResult *uwb_four_station_estimator_result(
    const UwbFourStationEstimator *estimator);

#endif
