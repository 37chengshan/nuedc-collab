#ifndef UWB_POSITION_H
#define UWB_POSITION_H

#include "uwb_monitor.h"

#include <stdbool.h>
#include <stdint.h>

#define UWB_POSITION_SYNC_WINDOW_MS 200U
#define UWB_SCREEN_LINE_COUNT 4U
#define UWB_SCREEN_LINE_SIZE 17U

typedef enum {
    UWB_POSITION_WAIT = 0,
    UWB_POSITION_BAD,
    UWB_POSITION_LOST,
    UWB_POSITION_SYNC,
    UWB_POSITION_ADDRESS,
    UWB_POSITION_GEOMETRY,
    UWB_POSITION_OK
} UwbPositionStatus;

typedef struct {
    UwbPositionStatus status;
    char address[5];
    float x_mm;
    float y_mm;
    uint32_t radial_cm;
    int32_t angle_deg;
} UwbPositionResult;

bool uwb_position_solve(const UwbMonitor *monitor, uint32_t now_ms,
                        UwbPositionResult *result);
void uwb_position_format_screen(
    const UwbMonitor *monitor, uint32_t now_ms,
    char lines[UWB_SCREEN_LINE_COUNT][UWB_SCREEN_LINE_SIZE]);

#endif
