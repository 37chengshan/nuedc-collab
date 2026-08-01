#ifndef UWB_FUSION_H
#define UWB_FUSION_H

#include "calibration_model.h"
#include "empirical_model.h"
#include "lock_app_config.h"
#include "uwb_four_station_estimator.h"

typedef struct {
    bool occupied;
    LockUwbMeasurement measurement;
} LockUwbChannelCache;

typedef struct {
    UwbFourStationEstimator estimator;
    LockUwbChannelCache channels[LOCK_UWB_CHANNEL_COUNT];
    LockUwbMeasurement latest_measurement[LOCK_UWB_CHANNEL_COUNT];
    bool latest_valid[LOCK_UWB_CHANNEL_COUNT];
    LockPositionSolution last_solution;
} LockUwbFusion;

void uwb_fusion_init(LockUwbFusion *fusion);
void uwb_fusion_init_with_model(LockUwbFusion *fusion,
                                const CalibrationModelV1 *model);
void uwb_fusion_init_with_models(LockUwbFusion *fusion,
                                 const CalibrationModelV1 *calibration_model,
                                 const EmpiricalModelV1 *empirical_model);
void uwb_fusion_store_measurement(LockUwbFusion *fusion, uint8_t channel,
                                  const LockUwbMeasurement *measurement);
void uwb_fusion_solve(LockUwbFusion *fusion, const LockAppConfig *config,
                      uint32_t now_ms, LockPositionSolution *solution);

#endif
