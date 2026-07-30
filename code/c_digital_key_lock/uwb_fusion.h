#ifndef UWB_FUSION_H
#define UWB_FUSION_H

#include "lock_app_config.h"
#include "trilateration.h"

typedef struct {
    bool occupied;
    LockUwbMeasurement measurement;
} LockUwbChannelCache;

typedef struct {
    LockUwbChannelCache channels[LOCK_UWB_CHANNEL_COUNT];
    LockPositionSolution last_solution;
} LockUwbFusion;

void uwb_fusion_init(LockUwbFusion *fusion);
void uwb_fusion_store_measurement(LockUwbFusion *fusion, uint8_t channel,
                                  const LockUwbMeasurement *measurement);
void uwb_fusion_solve(LockUwbFusion *fusion, const LockAppConfig *config,
                      uint32_t now_ms, LockPositionSolution *solution);

#endif
