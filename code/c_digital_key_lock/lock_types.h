#ifndef LOCK_TYPES_H
#define LOCK_TYPES_H

#include <stdbool.h>
#include <stdint.h>

#define LOCK_UWB_CHANNEL_COUNT 2U
#define LOCK_UWB_RAW_LINE_CAPACITY 96U
#define LOCK_ID_BIT_COUNT 4U

typedef struct {
    float x_mm;
    float y_mm;
} LockPoint2f;

typedef struct {
    float x_mm;
    float y_mm;
} LockAnchor2d;

typedef struct {
    bool valid;
    bool station_addr_valid;
    bool key_addr_valid;
    uint16_t station_addr;
    uint16_t key_addr;
    uint8_t key_id;
    bool snr_valid;
    int16_t snr_db;
    uint32_t distance_mm;
    uint32_t timestamp_ms;
    uint8_t raw_length;
    char raw_line[LOCK_UWB_RAW_LINE_CAPACITY];
} LockUwbMeasurement;

typedef enum {
    LOCK_LOCALIZATION_NONE = 0,
    LOCK_LOCALIZATION_HOLD,
    LOCK_LOCALIZATION_TWO_ANCHOR,
    LOCK_LOCALIZATION_THREE_ANCHOR,
    LOCK_LOCALIZATION_TWO_STATION_EMPIRICAL
} LockLocalizationMode;

typedef enum {
    LOCK_DISTANCE_REJECT = 0,
    LOCK_DISTANCE_MEDIUM,
    LOCK_DISTANCE_HIGH
} LockDistanceQuality;

typedef struct {
    bool valid;
    bool auth_distance_valid;
    bool held;
    bool angle_valid;
    bool angle_auth_valid;
    bool key_id_valid;
    uint16_t key_addr;
    uint8_t key_id;
    uint8_t valid_mask;
    uint8_t anchor_count;
    LockDistanceQuality distance_quality;
    uint32_t updated_ms;
    float x_mm;
    float y_mm;
    float radius_from_origin_mm;
    float radial_mm;
    float bearing_deg;
    float residual_mm;
    int16_t angle_candidate_1_deg;
    int16_t angle_candidate_2_deg;
    uint8_t angle_confidence;
    uint8_t angle_candidate_1_weight;
    uint8_t angle_candidate_2_weight;
    uint8_t angle_candidate_span_deg;
    uint8_t sample_count[LOCK_UWB_CHANNEL_COUNT];
    uint16_t mad_mm[LOCK_UWB_CHANNEL_COUNT];
    int16_t snr_db[LOCK_UWB_CHANNEL_COUNT];
    uint16_t age_ms;
    uint16_t model_version;
    uint16_t model_bytes;
    uint32_t model_crc32;
    uint32_t failure_flags;
    LockLocalizationMode mode;
} LockPositionSolution;

typedef enum {
    LOCK_ZONE_INVALID = 0,
    LOCK_ZONE_OUTSIDE,
    LOCK_ZONE_APPROACH,
    LOCK_ZONE_UNLOCK,
    LOCK_ZONE_BACKSIDE
} LockZone;

typedef enum {
    LOCK_STATE_LOCKED = 0,
    LOCK_STATE_WELCOME,
    LOCK_STATE_UNLOCKED,
    LOCK_STATE_DENIED
} LockState;

typedef struct {
    LockZone zone;
    LockState state;
    bool authorized;
    bool unlock_output;
    bool welcome_output;
    bool green_led;
    bool red_led;
    bool buzzer_alarm;
} LockOutputSnapshot;

typedef struct {
    uint8_t expected_id;
    uint8_t observed_id;
    bool observed_id_valid;
    uint8_t channel_valid_mask;
    uint32_t now_ms;
    LockZone zone;
    LockState state;
    bool authorized;
    LockPositionSolution position;
} LockDisplayModel;

#endif
