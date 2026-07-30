#ifndef UWB_MONITOR_H
#define UWB_MONITOR_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define UWB_CHANNEL_COUNT 2U
#define UWB_LINE_CAPACITY 48U
#define UWB_FILTER_SAMPLE_COUNT 5U
#define UWB_CHANNEL_LOST_TIMEOUT_MS 500U

typedef enum {
    UWB_CHANNEL_WAIT = 0,
    UWB_CHANNEL_BAD,
    UWB_CHANNEL_OK,
    UWB_CHANNEL_LOST
} UwbChannelStatus;

typedef struct {
    bool valid;
    char address[5];
    uint32_t raw_distance_cm;
    uint32_t distance_cm;
    uint32_t last_frame_ms;
    uint32_t frame_count;
    uint32_t received_bytes;
    uint32_t rejected_lines;
    uint32_t filter_samples[UWB_FILTER_SAMPLE_COUNT];
    uint8_t filter_sample_count;
    uint8_t filter_next_index;
} UwbChannelState;

typedef struct {
    UwbChannelState channels[UWB_CHANNEL_COUNT];
    char lines[UWB_CHANNEL_COUNT][UWB_LINE_CAPACITY];
    uint8_t line_lengths[UWB_CHANNEL_COUNT];
    bool discarding[UWB_CHANNEL_COUNT];
    uint32_t byte_timestamps_ms[UWB_CHANNEL_COUNT];
} UwbMonitor;

void uwb_monitor_init(UwbMonitor *monitor);
bool uwb_monitor_push_byte(UwbMonitor *monitor, uint8_t channel, uint8_t byte);
bool uwb_monitor_push_byte_at(UwbMonitor *monitor, uint8_t channel,
                              uint8_t byte, uint32_t now_ms);
const UwbChannelState *uwb_monitor_channel(const UwbMonitor *monitor,
                                           uint8_t channel);
UwbChannelStatus uwb_monitor_channel_status(const UwbMonitor *monitor,
                                            uint8_t channel,
                                            uint32_t now_ms);
void uwb_monitor_format_row(const UwbMonitor *monitor, uint8_t channel,
                            bool overflow, char *row, size_t row_size);

#endif
