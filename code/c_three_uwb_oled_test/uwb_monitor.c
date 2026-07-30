#include "uwb_monitor.h"

#include <stdio.h>
#include <string.h>

static bool is_hex(char value)
{
    return ((value >= '0') && (value <= '9')) ||
           ((value >= 'A') && (value <= 'F')) ||
           ((value >= 'a') && (value <= 'f'));
}

static char upper_hex(char value)
{
    if ((value >= 'a') && (value <= 'f')) {
        return (char)(value - ('a' - 'A'));
    }
    return value;
}

static uint32_t median_distance(const UwbChannelState *state)
{
    uint32_t sorted[UWB_FILTER_SAMPLE_COUNT];
    uint8_t count = state->filter_sample_count;
    uint8_t i;
    uint8_t j;

    for (i = 0U; i < count; i++) {
        sorted[i] = state->filter_samples[i];
    }

    for (i = 1U; i < count; i++) {
        uint32_t value = sorted[i];

        j = i;
        while ((j > 0U) && (sorted[j - 1U] > value)) {
            sorted[j] = sorted[j - 1U];
            j--;
        }
        sorted[j] = value;
    }

    if ((count & 1U) != 0U) {
        return sorted[count / 2U];
    }
    return (sorted[(count / 2U) - 1U] + sorted[count / 2U]) / 2U;
}

static void accept_distance(UwbChannelState *state, const char address[5],
                            uint32_t distance_cm, uint32_t now_ms)
{
    if (state->valid && (memcmp(state->address, address, 4U) != 0)) {
        state->filter_sample_count = 0U;
        state->filter_next_index = 0U;
    }

    memcpy(state->address, address, 5U);
    state->raw_distance_cm = distance_cm;
    state->filter_samples[state->filter_next_index] = distance_cm;
    state->filter_next_index =
        (uint8_t)((state->filter_next_index + 1U) % UWB_FILTER_SAMPLE_COUNT);
    if (state->filter_sample_count < UWB_FILTER_SAMPLE_COUNT) {
        state->filter_sample_count++;
    }
    state->distance_cm =
        (state->filter_sample_count < UWB_FILTER_SAMPLE_COUNT)
            ? distance_cm
            : median_distance(state);
    state->last_frame_ms = now_ms;
    state->frame_count++;
    state->valid = true;
}

static bool parse_line(const char *line, uint8_t length,
                       UwbChannelState *state, uint32_t now_ms)
{
    uint8_t index;
    uint8_t address_index;
    uint8_t payload_end;
    uint32_t distance = 0U;
    bool has_digit = false;
    char address[5];

    if ((length >= 3U) && (line[0] == 'r') && (line[1] == 'e') &&
        (line[2] == ':')) {
        line += 3;
        length = (uint8_t)(length - 3U);
    }

    if ((length < 10U) || (line[0] != 'P')) {
        return false;
    }

    if (line[1] == ',') {
        address_index = 2U;
    } else if ((length >= 11U) && (line[1] >= '0') &&
               (line[1] <= '9') && (line[2] == ',')) {
        address_index = 3U;
    } else {
        return false;
    }

    for (index = 0U; index < 4U; index++) {
        if (!is_hex(line[address_index + index])) {
            return false;
        }
    }

    index = (uint8_t)(address_index + 4U);
    if ((index >= length) || (line[index] != ',')) {
        return false;
    }

    index++;
    while ((index < length) && (line[index] >= '0') &&
           (line[index] <= '9')) {
        uint32_t digit = (uint32_t)(line[index] - '0');
        if (distance > 429496728U) {
            return false;
        }
        distance = (distance * 10U) + digit;
        has_digit = true;
        index++;
    }

    if (!has_digit || ((uint8_t)(index + 2U) > length) ||
        (line[index] != 'c') || (line[index + 1U] != 'm')) {
        return false;
    }

    payload_end = (uint8_t)(index + 2U);
    if (payload_end < length) {
        bool has_snr_digit = false;

        if (line[payload_end] != ',') {
            return false;
        }
        index = (uint8_t)(payload_end + 1U);
        if ((index < length) && (line[index] == '-')) {
            index++;
        }
        while ((index < length) && (line[index] >= '0') &&
               (line[index] <= '9')) {
            has_snr_digit = true;
            index++;
        }
        if (!has_snr_digit || ((uint8_t)(index + 2U) != length) ||
            (line[index] != 'd') || (line[index + 1U] != 'B')) {
            return false;
        }
    }

    for (index = 0U; index < 4U; index++) {
        address[index] = upper_hex(line[address_index + index]);
    }
    address[4] = '\0';
    accept_distance(state, address, distance, now_ms);
    return true;
}

static bool buffer_is_re_prefix(const char *line, uint8_t length)
{
    return (length == 3U) && (line[0] == 'r') && (line[1] == 'e') &&
           (line[2] == ':');
}

static bool buffer_has_suffix(const char *line, uint8_t length,
                              char first, char second)
{
    return (length >= 2U) && (line[length - 2U] == first) &&
           (line[length - 1U] == second);
}

static bool buffer_is_tag_frame(const char *line, uint8_t length)
{
    uint8_t payload_index = 0U;

    if ((length >= 3U) && (line[0] == 'r') && (line[1] == 'e') &&
        (line[2] == ':')) {
        payload_index = 3U;
    }

    return ((uint8_t)(payload_index + 2U) <= length) &&
           (line[payload_index] == 'P') &&
           (line[payload_index + 1U] == ',');
}

static bool finish_buffer(UwbMonitor *monitor, uint8_t channel,
                          bool count_rejection)
{
    uint8_t length = monitor->line_lengths[channel];
    bool parsed = false;

    if (!monitor->discarding[channel] && (length > 0U)) {
        parsed = parse_line(monitor->lines[channel], length,
                            &monitor->channels[channel],
                            monitor->byte_timestamps_ms[channel]);
    }
    if (!parsed && count_rejection &&
        ((length > 0U) || monitor->discarding[channel])) {
        monitor->channels[channel].rejected_lines++;
    }

    monitor->line_lengths[channel] = 0U;
    monitor->discarding[channel] = false;
    return parsed;
}

void uwb_monitor_init(UwbMonitor *monitor)
{
    if (monitor != NULL) {
        memset(monitor, 0, sizeof(*monitor));
    }
}

bool uwb_monitor_push_byte(UwbMonitor *monitor, uint8_t channel, uint8_t byte)
{
    return uwb_monitor_push_byte_at(monitor, channel, byte, 0U);
}

bool uwb_monitor_push_byte_at(UwbMonitor *monitor, uint8_t channel,
                              uint8_t byte, uint32_t now_ms)
{
    uint8_t length;

    if ((monitor == NULL) || (channel >= UWB_CHANNEL_COUNT)) {
        return false;
    }

    monitor->channels[channel].received_bytes++;
    monitor->byte_timestamps_ms[channel] = now_ms;

    if ((byte == '\r') || (byte == '\n')) {
        length = monitor->line_lengths[channel];
        if ((length == 0U) && !monitor->discarding[channel]) {
            return false;
        }
        (void)finish_buffer(monitor, channel, true);
        return true;
    }

    if (monitor->discarding[channel]) {
        if (byte == 'P') {
            monitor->discarding[channel] = false;
            monitor->lines[channel][0] = 'P';
            monitor->line_lengths[channel] = 1U;
        }
        return false;
    }

    length = monitor->line_lengths[channel];
    if ((byte == 'P') && (length > 0U) &&
        !buffer_is_re_prefix(monitor->lines[channel], length)) {
        bool parsed = finish_buffer(monitor, channel, true);

        monitor->lines[channel][0] = 'P';
        monitor->line_lengths[channel] = 1U;
        return parsed;
    }

    if (length >= (UWB_LINE_CAPACITY - 1U)) {
        monitor->line_lengths[channel] = 0U;
        monitor->discarding[channel] = true;
        return false;
    }

    monitor->lines[channel][length] = (char)byte;
    length = (uint8_t)(length + 1U);
    monitor->line_lengths[channel] = length;

    if (buffer_has_suffix(monitor->lines[channel], length, 'd', 'B') ||
        (buffer_is_tag_frame(monitor->lines[channel], length) &&
         buffer_has_suffix(monitor->lines[channel], length, 'c', 'm'))) {
        return finish_buffer(monitor, channel, true);
    }

    return false;
}

const UwbChannelState *uwb_monitor_channel(const UwbMonitor *monitor,
                                           uint8_t channel)
{
    if ((monitor == NULL) || (channel >= UWB_CHANNEL_COUNT)) {
        return NULL;
    }
    return &monitor->channels[channel];
}

UwbChannelStatus uwb_monitor_channel_status(const UwbMonitor *monitor,
                                            uint8_t channel,
                                            uint32_t now_ms)
{
    const UwbChannelState *state = uwb_monitor_channel(monitor, channel);

    if (state == NULL) {
        return UWB_CHANNEL_BAD;
    }
    if (!state->valid) {
        return (state->received_bytes == 0U) ? UWB_CHANNEL_WAIT
                                             : UWB_CHANNEL_BAD;
    }
    if ((now_ms - state->last_frame_ms) > UWB_CHANNEL_LOST_TIMEOUT_MS) {
        return UWB_CHANNEL_LOST;
    }
    return UWB_CHANNEL_OK;
}

void uwb_monitor_format_row(const UwbMonitor *monitor, uint8_t channel,
                            bool overflow, char *row, size_t row_size)
{
    const UwbChannelState *state;

    if ((row == NULL) || (row_size == 0U)) {
        return;
    }

    row[0] = '\0';
    state = uwb_monitor_channel(monitor, channel);
    if (state == NULL) {
        return;
    }

    if (overflow) {
        (void)snprintf(row, row_size, "%u ---- ---- OVF",
                       (unsigned int)(channel + 1U));
    } else if (state->valid) {
        unsigned long distance = (unsigned long)state->distance_cm;
        if (distance > 9999UL) {
            distance = 9999UL;
        }
        (void)snprintf(row, row_size, "%u %s %4lu OK",
                       (unsigned int)(channel + 1U), state->address, distance);
    } else if (state->received_bytes != 0U) {
        unsigned long received = (unsigned long)state->received_bytes;
        if (received > 9999UL) {
            received = 9999UL;
        }
        (void)snprintf(row, row_size, "%u ---- %4lu BAD",
                       (unsigned int)(channel + 1U), received);
    } else {
        (void)snprintf(row, row_size, "%u ---- --- WAIT",
                       (unsigned int)(channel + 1U));
    }
}
