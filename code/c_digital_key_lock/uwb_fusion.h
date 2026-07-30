#ifndef UWB_FUSION_H
#define UWB_FUSION_H

#include "calibration_model.h"
#include "lock_app_config.h"
#include "trilateration.h"

typedef struct {
    bool occupied;
    LockUwbMeasurement measurement;
} LockUwbChannelCache;

typedef struct {
    bool initialized;
    uint32_t timestamp_ms;
    float state[4];
    float covariance[4][4];
} LockKalman2d;

typedef struct {
    LockUwbChannelCache channels[LOCK_UWB_CHANNEL_COUNT];
    LockPositionSolution last_solution;
    LockKalman2d kalman;
    const CalibrationModelV1 *calibration_model;
} LockUwbFusion;

void uwb_fusion_init(LockUwbFusion *fusion);
void uwb_fusion_init_with_model(LockUwbFusion *fusion,
                                const CalibrationModelV1 *model);
void uwb_fusion_store_measurement(LockUwbFusion *fusion, uint8_t channel,
                                  const LockUwbMeasurement *measurement);
void uwb_fusion_solve(LockUwbFusion *fusion, const LockAppConfig *config,
                      uint32_t now_ms, LockPositionSolution *solution);

#endif
