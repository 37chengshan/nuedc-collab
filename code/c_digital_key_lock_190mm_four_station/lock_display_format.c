#include "lock_display_format.h"

#include <stdbool.h>
#include <stddef.h>

static void copy_text(char *output, const char *text)
{
    size_t index = 0U;

    while (text[index] != '\0') {
        output[index] = text[index];
        index++;
    }
    output[index] = '\0';
}

void lock_display_format_id4(uint8_t id, char *output)
{
    uint8_t value = (uint8_t)(id & 0x0FU);
    uint8_t bit;

    for (bit = 0U; bit < LOCK_ID_BIT_COUNT; bit++) {
        uint8_t shift = (uint8_t)((LOCK_ID_BIT_COUNT - 1U) - bit);

        output[bit] = ((value & (uint8_t)(1U << shift)) != 0U) ? '1' : '0';
    }
    output[LOCK_ID_BIT_COUNT] = '\0';
}

static char hex_digit(uint8_t value)
{
    return (value < 10U) ? (char)('0' + value)
                         : (char)('A' + (value - 10U));
}

void lock_display_format_address4(uint16_t address, char *output)
{
    output[0] = hex_digit((uint8_t)((address >> 12U) & 0x0FU));
    output[1] = hex_digit((uint8_t)((address >> 8U) & 0x0FU));
    output[2] = hex_digit((uint8_t)((address >> 4U) & 0x0FU));
    output[3] = hex_digit((uint8_t)(address & 0x0FU));
    output[4] = '\0';
}

void lock_display_format_key_id(const LockDisplayModel *model, char *output)
{
    if ((model == NULL) || !model->observed_id_valid) {
        copy_text(output, "----");
        return;
    }

    lock_display_format_id4(model->observed_id, output);
}

void lock_display_format_angle(const LockDisplayModel *model, char *output)
{
    float bearing;
    int rounded;
    unsigned int magnitude;
    size_t index = 0U;

    if ((model == NULL) ||
        (!model->position.angle_valid && !model->position.angle_held)) {
        copy_text(output, "--");
        return;
    }

    bearing = model->position.bearing_deg;
    if ((bearing != bearing) || (bearing < -180.0f) || (bearing > 180.0f)) {
        copy_text(output, "--");
        return;
    }

    rounded =
        (bearing >= 0.0f) ? (int)(bearing + 0.5f) : (int)(bearing - 0.5f);
    output[index++] = (rounded < 0) ? '-' : '+';
    magnitude =
        (rounded < 0) ? (unsigned int)(-rounded) : (unsigned int)rounded;

    if (magnitude >= 100U) {
        output[index++] = (char)('0' + (magnitude / 100U));
        magnitude %= 100U;
        output[index++] = (char)('0' + (magnitude / 10U));
    } else if (magnitude >= 10U) {
        output[index++] = (char)('0' + (magnitude / 10U));
    }
    output[index++] = (char)('0' + (magnitude % 10U));
    output[index++] = ' ';
    output[index++] = 'd';
    output[index++] = 'e';
    output[index++] = 'g';
    output[index] = '\0';
}

void lock_display_format_distance(const LockDisplayModel *model,
                                  char *output)
{
    uint32_t boundary_mm;
    uint32_t tenths;

    if ((model == NULL) || !model->position.valid) {
        copy_text(output, "--.-m");
        return;
    }

    if (model->position.boundary_distance_mm !=
        model->position.boundary_distance_mm) {
        copy_text(output, "--.-m");
        return;
    }
    boundary_mm = (uint32_t)(model->position.boundary_distance_mm + 0.5f);
    tenths = (boundary_mm + 50U) / 100U;
    if (tenths > 99U) {
        tenths = 99U;
    }
    output[0] = (char)('0' + tenths / 10U);
    output[1] = '.';
    output[2] = (char)('0' + tenths % 10U);
    output[3] = 'm';
    output[4] = '\0';
}

static void format_channel_state(const LockDisplayModel *model,
                                 uint8_t channel, char *output)
{
    if ((model == NULL) ||
        ((model->channel_valid_mask & (uint8_t)(1U << channel)) == 0U)) {
        output[0] = '-';
        output[1] = '-';
        return;
    }

    output[0] = 'O';
    output[1] = 'K';
}

void lock_display_format_channels(const LockDisplayModel *model,
                                  char *output)
{
    lock_display_format_channel_pair(model, 0U, output);
}

void lock_display_format_channel_pair(const LockDisplayModel *model,
                                      uint8_t first_channel, char *output)
{
    uint8_t second_channel = (uint8_t)(first_channel + 1U);

    output[0] = (char)('A' + first_channel);
    output[1] = ':';
    format_channel_state(model, first_channel, &output[2]);
    output[4] = ' ';
    output[5] = (char)('A' + second_channel);
    output[6] = ':';
    format_channel_state(model, second_channel, &output[7]);
    output[9] = '\0';
}

const char *lock_display_auth_text(const LockDisplayModel *model)
{
    if ((model == NULL) || !model->observed_id_valid) {
        return "WAIT";
    }

    return model->authorized ? "PASS" : "FAIL";
}

const char *lock_display_zone_text(LockZone zone)
{
    switch (zone) {
    case LOCK_ZONE_OUTSIDE:
        return "OUTSIDE";
    case LOCK_ZONE_APPROACH:
        return "APPROACH";
    case LOCK_ZONE_UNLOCK:
        return "UNLOCK";
    case LOCK_ZONE_BACKSIDE:
        return "BACKSIDE";
    case LOCK_ZONE_INVALID:
    default:
        return "INVALID";
    }
}

const char *lock_display_state_text(LockState state)
{
    return (state == LOCK_STATE_UNLOCKED) ? "OPEN" : "LOCKED";
}

const char *lock_display_footer_text(const LockDisplayModel *model)
{
    if ((model != NULL) && model->monitor_only) {
        return "MONITOR";
    }
    return lock_display_state_text(
        model == NULL ? LOCK_STATE_LOCKED : model->state);
}
