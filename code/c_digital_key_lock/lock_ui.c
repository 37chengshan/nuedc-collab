#include "lock_ui.h"

#include <stddef.h>
#include <string.h>

typedef struct {
    char *line;
    size_t length;
} LockUiWriter;

static void writer_init(LockUiWriter *writer, char *line)
{
    writer->line = line;
    writer->length = 0U;
    line[0] = '\0';
}

static void writer_append_char(LockUiWriter *writer, char value)
{
    if (writer->length >= (LOCK_UI_LINE_CAPACITY - 1U)) {
        return;
    }
    writer->line[writer->length++] = value;
    writer->line[writer->length] = '\0';
}

static void writer_append_text(LockUiWriter *writer, const char *value)
{
    while (*value != '\0') {
        writer_append_char(writer, *value++);
    }
}

static void writer_append_u32(LockUiWriter *writer, uint32_t value)
{
    char reversed[10];
    size_t count = 0U;

    do {
        reversed[count++] = (char)('0' + (value % 10U));
        value /= 10U;
    } while ((value != 0U) && (count < sizeof(reversed)));

    while (count > 0U) {
        writer_append_char(writer, reversed[--count]);
    }
}

static void writer_append_two_digits(LockUiWriter *writer, uint8_t value)
{
    uint8_t limited = (value > 99U) ? 99U : value;

    writer_append_char(writer, (char)('0' + (limited / 10U)));
    writer_append_char(writer, (char)('0' + (limited % 10U)));
}

static void writer_append_nibble_binary(LockUiWriter *writer, uint8_t value)
{
    int8_t bit;

    for (bit = 3; bit >= 0; bit--) {
        writer_append_char(
            writer, ((value & (uint8_t)(1U << bit)) != 0U) ? '1' : '0');
    }
}

static char nibble_hex(uint8_t value)
{
    value &= 0x0FU;
    return (value < 10U) ? (char)('0' + value)
                         : (char)('A' + (value - 10U));
}

static bool angle_candidate_is_displayable(int16_t angle_deg)
{
    return (angle_deg >= -99) && (angle_deg <= 99);
}

static void writer_append_signed_angle(LockUiWriter *writer,
                                       int16_t angle_deg)
{
    int32_t magnitude = angle_deg;

    if (magnitude < 0) {
        writer_append_char(writer, '-');
        magnitude = -magnitude;
    } else {
        writer_append_char(writer, '+');
    }
    writer_append_u32(writer, (uint32_t)magnitude);
}

LockUiPairStatus lock_ui_pair_status(const LockDisplayModel *display)
{
    if ((display == NULL) || !display->observed_id_valid) {
        return LOCK_UI_PAIR_NONE;
    }
    return ((display->observed_id & 0x0FU) ==
            (display->expected_id & 0x0FU))
               ? LOCK_UI_PAIR_MATCH
               : LOCK_UI_PAIR_FAIL;
}

void lock_ui_format(const LockDisplayModel *display, LockUiText *text)
{
    LockUiWriter writer;
    LockUiPairStatus pair_status;
    uint8_t expected_id;
    uint8_t observed_id;
    uint32_t distance_mm;
    char quality;

    if ((display == NULL) || (text == NULL)) {
        return;
    }

    memset(text, 0, sizeof(*text));
    expected_id = (uint8_t)(display->expected_id & 0x0FU);
    observed_id = (uint8_t)(display->observed_id & 0x0FU);
    pair_status = lock_ui_pair_status(display);

    writer_init(&writer, text->lines[0]);
    writer_append_text(&writer, "KEY LOCK");

    writer_init(&writer, text->lines[1]);
    writer_append_text(&writer, "SET 0X");
    writer_append_char(&writer, nibble_hex(expected_id));

    writer_init(&writer, text->lines[2]);
    writer_append_text(&writer, "SET ");
    writer_append_nibble_binary(&writer, expected_id);

    writer_init(&writer, text->lines[3]);
    if (display->observed_id_valid) {
        writer_append_text(&writer, "RX  0X");
        writer_append_char(&writer, nibble_hex(observed_id));
    } else {
        writer_append_text(&writer, "RX  ----");
    }

    writer_init(&writer, text->lines[4]);
    writer_append_text(&writer, "RX  ");
    if (display->observed_id_valid) {
        writer_append_nibble_binary(&writer, observed_id);
    } else {
        writer_append_text(&writer, "----");
    }

    writer_init(&writer, text->lines[5]);
    if (pair_status == LOCK_UI_PAIR_MATCH) {
        writer_append_text(&writer, "PAIR MATCH");
    } else if (pair_status == LOCK_UI_PAIR_FAIL) {
        writer_append_text(&writer, "PAIR FAIL");
    } else {
        writer_append_text(&writer, "PAIR NONE");
    }

    writer_init(&writer, text->lines[6]);
    writer_append_text(&writer, "D ");
    if (display->position.valid) {
        if (display->position.radial_mm <= 0.0f) {
            distance_mm = 0U;
        } else if (display->position.radial_mm >= 9999.0f) {
            distance_mm = 9999U;
        } else {
            distance_mm =
                (uint32_t)(display->position.radial_mm + 0.5f);
        }
        writer_append_u32(&writer, distance_mm);
    } else {
        writer_append_text(&writer, "----");
    }
    writer_append_char(&writer, ' ');
    if (display->position.held) {
        quality = '*';
    } else if (display->position.distance_quality ==
               LOCK_DISTANCE_HIGH) {
        quality = 'H';
    } else if (display->position.distance_quality ==
               LOCK_DISTANCE_MEDIUM) {
        quality = 'M';
    } else {
        quality = 'R';
    }
    writer_append_char(&writer, quality);

    writer_init(&writer, text->lines[7]);
    switch (display->state) {
    case LOCK_STATE_UNLOCKED:
        writer_append_text(&writer, "LOCK OPEN");
        break;
    case LOCK_STATE_WELCOME:
        writer_append_text(&writer, "LOCK WAIT");
        break;
    case LOCK_STATE_DENIED:
        writer_append_text(&writer, "LOCK DENY");
        break;
    case LOCK_STATE_LOCKED:
    default:
        writer_append_text(&writer, "LOCK SAFE");
        break;
    }

    writer_init(&writer, text->lines[8]);
    writer_append_text(&writer, "U R");
    writer_append_two_digits(
        &writer, display->position.sample_count[0]);
    writer_append_text(&writer, " L");
    writer_append_two_digits(
        &writer, display->position.sample_count[1]);

    writer_init(&writer, text->lines[9]);
    writer_append_text(&writer, "A ");
    if ((display->position.angle_confidence > 0U) &&
        angle_candidate_is_displayable(
            display->position.angle_candidate_1_deg) &&
        angle_candidate_is_displayable(
            display->position.angle_candidate_2_deg)) {
        writer_append_signed_angle(
            &writer, display->position.angle_candidate_1_deg);
        writer_append_char(&writer, '/');
        writer_append_signed_angle(
            &writer, display->position.angle_candidate_2_deg);
    } else {
        writer_append_text(&writer, "---/---");
    }
}
