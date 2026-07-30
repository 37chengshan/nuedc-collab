#include "uwb_calibration.h"

#include <limits.h>
#include <stddef.h>

/*
 * 标定完成前保持恒等映射。后续根据统一基准下采集的多距离数据，
 * 分别修改两路 scale_permille 和 offset_mm。
 */
const UwbDistanceCalibration
    g_uwb_channel_calibration[UWB_CHANNEL_COUNT] = {
        {1000U, 0},
        {1000U, 0},
    };

uint32_t uwb_calibration_apply_mm(
    uint32_t raw_distance_cm,
    const UwbDistanceCalibration *calibration)
{
    uint32_t scale = UWB_CALIBRATION_SCALE_BASE;
    int32_t offset_mm = 0;
    int64_t corrected_mm;

    if (calibration != NULL) {
        if (calibration->scale_permille != 0U) {
            scale = calibration->scale_permille;
        }
        offset_mm = calibration->offset_mm;
    }

    corrected_mm =
        (((int64_t)raw_distance_cm * 10LL * (int64_t)scale) +
         (UWB_CALIBRATION_SCALE_BASE / 2U)) /
            UWB_CALIBRATION_SCALE_BASE +
        offset_mm;

    if (corrected_mm <= 0LL) {
        return 0U;
    }
    if (corrected_mm > (int64_t)UINT32_MAX) {
        return UINT32_MAX;
    }
    return (uint32_t)corrected_mm;
}

uint32_t uwb_calibration_apply_channel_mm(uint8_t channel,
                                          uint32_t raw_distance_cm)
{
    if (channel >= UWB_CHANNEL_COUNT) {
        return raw_distance_cm * 10U;
    }
    return uwb_calibration_apply_mm(
        raw_distance_cm, &g_uwb_channel_calibration[channel]);
}
