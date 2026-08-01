#ifndef MONITOR_DISPLAY_H
#define MONITOR_DISPLAY_H

#include <stdint.h>

#define UWB_MONITOR_CHANNEL_COUNT 4U

typedef enum {
    UWB_MONITOR_WAIT = 0,
    UWB_MONITOR_RX,
    UWB_MONITOR_OK,
    UWB_MONITOR_LOST
} UwbMonitorStatus;

typedef struct {
    uint32_t byte_count[UWB_MONITOR_CHANNEL_COUNT];
    UwbMonitorStatus status[UWB_MONITOR_CHANNEL_COUNT];
} UwbMonitorSnapshot;

void monitor_display_init(void);
void monitor_display_present(const UwbMonitorSnapshot *snapshot);

#endif
