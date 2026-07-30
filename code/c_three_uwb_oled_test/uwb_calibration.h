#ifndef UWB_CALIBRATION_H
#define UWB_CALIBRATION_H

#include "uwb_monitor.h"

#include <stdint.h>

#define UWB_CALIBRATION_SCALE_BASE 1000U

typedef struct {
    uint16_t scale_permille;
    int32_t offset_mm;
} UwbDistanceCalibration;

extern const UwbDistanceCalibration
    g_uwb_channel_calibration[UWB_CHANNEL_COUNT];

uint32_t uwb_calibration_apply_mm(
    uint32_t raw_distance_cm,
    const UwbDistanceCalibration *calibration);
uint32_t uwb_calibration_apply_channel_mm(uint8_t channel,
                                          uint32_t raw_distance_cm);

#endif
