#ifndef EMPIRICAL_MODEL_H
#define EMPIRICAL_MODEL_H

#include <stdbool.h>
#include <stdint.h>

#define EMPIRICAL_MODEL_V1_MAGIC 0x314D5045UL
#define EMPIRICAL_MODEL_V1_VERSION 0x0101U
#define EMPIRICAL_MODEL_MAX_PROTOTYPES 96U
#define EMPIRICAL_MODEL_MAX_NEIGHBORS 8U
#define EMPIRICAL_MODEL_MAX_PRIMARY_KNOTS 16U

#define EMPIRICAL_PROTOTYPE_ANGLE_VALID 0x01U

typedef struct {
    uint16_t distance1_mm;
    uint16_t distance2_mm;
    uint16_t radial_mm;
    int16_t bearing_cdeg;
    uint8_t flags;
    uint8_t reserved;
} EmpiricalPrototypeV1;

typedef struct {
    uint16_t measured_mm;
    uint16_t radial_mm;
} EmpiricalRangeKnotV1;

typedef struct {
    uint32_t magic;
    uint16_t version;
    uint16_t prototype_count;
    uint8_t distance_neighbor_count;
    uint8_t angle_neighbor_count;
    uint8_t primary_knot_count;
    uint8_t reserved;
    float distance1_scale_mm;
    float distance2_scale_mm;
    float distance_knn_blend;
    float known_prototype_radius;
    float angle_max_neighbor_distance;
    float angle_max_spread_deg;
    const EmpiricalPrototypeV1 *prototypes;
    const EmpiricalRangeKnotV1 *primary_knots;
    uint32_t crc32;
} EmpiricalModelV1;

typedef enum {
    EMPIRICAL_MODEL_OK = 0,
    EMPIRICAL_MODEL_NULL_ERROR,
    EMPIRICAL_MODEL_MAGIC_ERROR,
    EMPIRICAL_MODEL_VERSION_ERROR,
    EMPIRICAL_MODEL_COUNT_ERROR,
    EMPIRICAL_MODEL_PARAMETER_ERROR,
    EMPIRICAL_MODEL_CRC_ERROR
} EmpiricalModelStatus;

typedef struct {
    bool valid;
    bool angle_available;
    bool angle_valid;
    float distance_mm;
    float bearing_deg;
    float distance_confidence;
    float angle_confidence;
} EmpiricalEstimate;

uint32_t empirical_model_compute_crc(const EmpiricalModelV1 *model);
void empirical_model_refresh_crc(EmpiricalModelV1 *model);
EmpiricalModelStatus empirical_model_validate(const EmpiricalModelV1 *model);
bool empirical_model_predict(const EmpiricalModelV1 *model,
                             uint16_t distance1_mm,
                             uint16_t distance2_mm,
                             EmpiricalEstimate *estimate);

#endif
