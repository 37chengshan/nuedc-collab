#include "uwb_position.h"

#include "uwb_calibration.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#define UWB_ANCHOR_1_X_MM (-125.0f)
#define UWB_ANCHOR_1_Y_MM (40.0f)
#define UWB_ANCHOR_2_X_MM (125.0f)
#define UWB_ANCHOR_2_Y_MM (40.0f)
#define UWB_RADIAL_ZERO_MM (300.0f)
#define UWB_RAD_TO_DEG (57.29577951308232f)

static uint32_t absolute_difference(uint32_t first, uint32_t second)
{
    return (first >= second) ? (first - second) : (second - first);
}

static int32_t round_signed(float value)
{
    return (value >= 0.0f) ? (int32_t)(value + 0.5f)
                           : (int32_t)(value - 0.5f);
}

static UwbPositionStatus combined_channel_status(UwbChannelStatus first,
                                                 UwbChannelStatus second)
{
    if ((first == UWB_CHANNEL_LOST) || (second == UWB_CHANNEL_LOST)) {
        return UWB_POSITION_LOST;
    }
    if ((first == UWB_CHANNEL_BAD) || (second == UWB_CHANNEL_BAD)) {
        return UWB_POSITION_BAD;
    }
    return UWB_POSITION_WAIT;
}

bool uwb_position_solve(const UwbMonitor *monitor, uint32_t now_ms,
                        UwbPositionResult *result)
{
    const UwbChannelState *first;
    const UwbChannelState *second;
    UwbChannelStatus first_status;
    UwbChannelStatus second_status;
    float dx = UWB_ANCHOR_2_X_MM - UWB_ANCHOR_1_X_MM;
    float dy = UWB_ANCHOR_2_Y_MM - UWB_ANCHOR_1_Y_MM;
    float baseline = sqrtf((dx * dx) + (dy * dy));
    float first_distance;
    float second_distance;
    float along;
    float height_squared;
    float height;
    float radial_mm;

    if (result == NULL) {
        return false;
    }
    memset(result, 0, sizeof(*result));

    first = uwb_monitor_channel(monitor, 0U);
    second = uwb_monitor_channel(monitor, 1U);
    first_status = uwb_monitor_channel_status(monitor, 0U, now_ms);
    second_status = uwb_monitor_channel_status(monitor, 1U, now_ms);

    if ((first_status != UWB_CHANNEL_OK) ||
        (second_status != UWB_CHANNEL_OK)) {
        result->status =
            combined_channel_status(first_status, second_status);
        return false;
    }

    if (absolute_difference(first->last_frame_ms, second->last_frame_ms) >
        UWB_POSITION_SYNC_WINDOW_MS) {
        result->status = UWB_POSITION_SYNC;
        return false;
    }

    if (first->address[3] != second->address[3]) {
        result->status = UWB_POSITION_ADDRESS;
        return false;
    }

    first_distance =
        (float)uwb_calibration_apply_channel_mm(0U, first->distance_cm);
    second_distance =
        (float)uwb_calibration_apply_channel_mm(1U, second->distance_cm);
    along = ((first_distance * first_distance) -
             (second_distance * second_distance) +
             (baseline * baseline)) /
            (2.0f * baseline);
    height_squared =
        (first_distance * first_distance) - (along * along);
    if (height_squared < -1.0f) {
        result->status = UWB_POSITION_GEOMETRY;
        return false;
    }
    if (height_squared < 0.0f) {
        height_squared = 0.0f;
    }
    height = sqrtf(height_squared);

    result->x_mm = UWB_ANCHOR_1_X_MM + (along * dx / baseline) -
                   (height * dy / baseline);
    result->y_mm = UWB_ANCHOR_1_Y_MM + (along * dy / baseline) +
                   (height * dx / baseline);
    radial_mm =
        sqrtf((result->x_mm * result->x_mm) +
              (result->y_mm * result->y_mm)) -
        UWB_RADIAL_ZERO_MM;
    if (radial_mm < 0.0f) {
        radial_mm = 0.0f;
    }

    result->radial_cm = (uint32_t)((radial_mm + 5.0f) / 10.0f);
    result->angle_deg =
        round_signed(atan2f(result->x_mm, result->y_mm) * UWB_RAD_TO_DEG);
    memcpy(result->address, first->address, sizeof(result->address));
    result->status = UWB_POSITION_OK;
    return true;
}

static const char *channel_status_text(UwbChannelStatus status)
{
    switch (status) {
        case UWB_CHANNEL_BAD:
            return "BAD";
        case UWB_CHANNEL_LOST:
            return "LOST";
        case UWB_CHANNEL_OK:
            return "OK";
        case UWB_CHANNEL_WAIT:
        default:
            return "WAIT";
    }
}

static void format_channel_field(const UwbMonitor *monitor, uint8_t channel,
                                 uint32_t now_ms, char field[8])
{
    const UwbChannelState *state = uwb_monitor_channel(monitor, channel);
    UwbChannelStatus status =
        uwb_monitor_channel_status(monitor, channel, now_ms);

    if ((state != NULL) && (status == UWB_CHANNEL_OK)) {
        unsigned long distance =
            (unsigned long)((uwb_calibration_apply_channel_mm(
                                 channel, state->distance_cm) +
                             5U) /
                            10U);

        if (distance > 9999UL) {
            distance = 9999UL;
        }
        (void)snprintf(field, 8U, "D%c:%4lu",
                       (char)('1' + channel), distance);
    } else {
        (void)snprintf(field, 8U, "D%c:%s",
                       (char)('1' + channel),
                       channel_status_text(status));
    }
}

static const char *position_status_text(UwbPositionStatus status)
{
    switch (status) {
        case UWB_POSITION_BAD:
            return "BAD";
        case UWB_POSITION_LOST:
            return "LOST";
        case UWB_POSITION_SYNC:
            return "SYNC";
        case UWB_POSITION_ADDRESS:
            return "ADDR";
        case UWB_POSITION_GEOMETRY:
            return "GEOM";
        case UWB_POSITION_OK:
            return "OK";
        case UWB_POSITION_WAIT:
        default:
            return "WAIT";
    }
}

void uwb_position_format_screen(
    const UwbMonitor *monitor, uint32_t now_ms,
    char lines[UWB_SCREEN_LINE_COUNT][UWB_SCREEN_LINE_SIZE])
{
    UwbPositionResult result;
    char first_field[8];
    char second_field[8];
    bool valid;

    format_channel_field(monitor, 0U, now_ms, first_field);
    format_channel_field(monitor, 1U, now_ms, second_field);
    (void)snprintf(lines[0], UWB_SCREEN_LINE_SIZE, "%s %s",
                   first_field, second_field);

    valid = uwb_position_solve(monitor, now_ms, &result);
    if (valid) {
        unsigned long radial = (unsigned long)result.radial_cm;
        long angle = (long)result.angle_deg;

        if (radial > 9999UL) {
            radial = 9999UL;
        }
        (void)snprintf(lines[1], UWB_SCREEN_LINE_SIZE,
                       "R :%4lucm", radial);
        (void)snprintf(lines[2], UWB_SCREEN_LINE_SIZE,
                       "A :%+4lddeg", angle);
        (void)snprintf(lines[3], UWB_SCREEN_LINE_SIZE,
                       "%s POS:OK", result.address);
    } else {
        (void)snprintf(lines[1], UWB_SCREEN_LINE_SIZE, "R :----cm");
        (void)snprintf(lines[2], UWB_SCREEN_LINE_SIZE, "A :----deg");
        (void)snprintf(lines[3], UWB_SCREEN_LINE_SIZE,
                       "---- POS:%s", position_status_text(result.status));
    }
}
