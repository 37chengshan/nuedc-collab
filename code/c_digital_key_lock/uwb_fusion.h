#ifndef UWB_FUSION_H
#define UWB_FUSION_H

#include "lock_app_config.h"
#include "uwb_two_station_estimator.h"

typedef struct {
    UwbTwoStationEstimator estimator;
    LockUwbMeasurement latest_measurement[LOCK_UWB_CHANNEL_COUNT];
    bool latest_valid[LOCK_UWB_CHANNEL_COUNT];
    LockPositionSolution last_solution;
} LockUwbFusion;

void uwb_fusion_init(LockUwbFusion *fusion);
void uwb_fusion_store_measurement(LockUwbFusion *fusion, uint8_t channel,
                                  const LockUwbMeasurement *measurement);
void uwb_fusion_solve(LockUwbFusion *fusion, const LockAppConfig *config,
                      uint32_t now_ms, LockPositionSolution *solution);
void uwb_fusion_report_failure(LockUwbFusion *fusion,
                               uint32_t failure_flags);

#endif
