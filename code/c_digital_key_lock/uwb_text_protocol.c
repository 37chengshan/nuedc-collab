#include "uwb_text_protocol.h"

#include <ctype.h>
#include <stdlib.h>
#include <string.h>

static size_t bounded_string_length(const char *text, size_t limit)
{
    size_t length = 0U;

    while ((length < limit) && (text[length] != '\0')) {
        length++;
    }
    return length;
}

static char *trim_in_place(char *text)
{
    char *end;

    while ((*text != '\0') && isspace((unsigned char)*text)) {
        text++;
    }

    end = text + strlen(text);
    while ((end > text) && isspace((unsigned char)end[-1])) {
        end--;
    }
    *end = '\0';
    return text;
}

static void uppercase_ascii(char *text)
{
    while (*text != '\0') {
        *text = (char)toupper((unsigned char)*text);
        text++;
    }
}

static bool parse_address(const char *text, uint16_t *key_addr_out)
{
    char *endptr;
    unsigned long value;

    while (isspace((unsigned char)*text)) {
        text++;
    }
    if ((text[0] == '0') && ((text[1] == 'x') || (text[1] == 'X'))) {
        text += 2;
    }
    if (!isxdigit((unsigned char)*text)) {
        return false;
    }

    value = strtoul(text, &endptr, 16);
    if (endptr == text) {
        return false;
    }
    while (isspace((unsigned char)*endptr)) {
        endptr++;
    }
    if (*endptr != '\0') {
        return false;
    }

    if (value > UINT16_MAX) {
        return false;
    }

    *key_addr_out = (uint16_t)value;
    return true;
}

static bool parse_distance_mm(const char *text, uint32_t *distance_mm_out)
{
    char *endptr;
    unsigned long value;
    unsigned long multiplier = 1UL;

    while (isspace((unsigned char)*text)) {
        text++;
    }
    if (!isdigit((unsigned char)*text)) {
        return false;
    }

    value = strtoul(text, &endptr, 10);
    while (isspace((unsigned char)*endptr)) {
        endptr++;
    }

    if ((toupper((unsigned char)endptr[0]) == 'C') &&
        (toupper((unsigned char)endptr[1]) == 'M')) {
        multiplier = 10UL;
        endptr += 2;
    } else if ((toupper((unsigned char)endptr[0]) == 'M') &&
               (toupper((unsigned char)endptr[1]) == 'M')) {
        endptr += 2;
    } else if (toupper((unsigned char)endptr[0]) == 'M') {
        multiplier = 1000UL;
        endptr += 1;
    }

    while (isspace((unsigned char)*endptr)) {
        endptr++;
    }
    if ((*endptr != '\0') || (value == 0UL) ||
        (value > (UINT32_MAX / multiplier))) {
        return false;
    }

    *distance_mm_out = (uint32_t)(value * multiplier);
    return true;
}

static bool parse_snr_db(const char *text, int16_t *snr_db_out)
{
    char *endptr;
    long value;

    while (isspace((unsigned char)*text)) {
        text++;
    }
    if ((*text != '+') && (*text != '-') &&
        !isdigit((unsigned char)*text)) {
        return false;
    }

    value = strtol(text, &endptr, 10);
    if (endptr == text) {
        return false;
    }
    while (isspace((unsigned char)*endptr)) {
        endptr++;
    }
    if ((toupper((unsigned char)endptr[0]) == 'D') &&
        (toupper((unsigned char)endptr[1]) == 'B')) {
        endptr += 2;
    }
    while (isspace((unsigned char)*endptr)) {
        endptr++;
    }
    if ((*endptr != '\0') || (value < INT16_MIN) || (value > INT16_MAX)) {
        return false;
    }

    *snr_db_out = (int16_t)value;
    return true;
}

typedef enum {
    COMPACT_FRAME_NONE = 0,
    COMPACT_FRAME_KEY,
    COMPACT_FRAME_STATION
} CompactFrameKind;

static CompactFrameKind compact_frame_kind(const char *field)
{
    if (toupper((unsigned char)field[0]) != 'P') {
        return COMPACT_FRAME_NONE;
    }
    if (field[1] == '\0') {
        return COMPACT_FRAME_KEY;
    }
    if ((field[2] == '\0') && (field[1] >= '0') &&
        (field[1] <= '4')) {
        return COMPACT_FRAME_STATION;
    }
    return COMPACT_FRAME_NONE;
}

static bool key_is_id(const char *key)
{
    return (strcmp(key, "ID") == 0) || (strcmp(key, "ADDR") == 0) ||
           (strcmp(key, "ADDRESS") == 0) || (strcmp(key, "KEY") == 0) ||
           (strcmp(key, "KEYID") == 0) ||
           (strcmp(key, "KEY_ADDR") == 0) ||
           (strcmp(key, "TARGET") == 0) ||
           (strcmp(key, "TARGET_ADDR") == 0);
}

static bool key_is_station(const char *key)
{
    return (strcmp(key, "STATION") == 0) ||
           (strcmp(key, "STATION_ADDR") == 0) ||
           (strcmp(key, "ANCHOR") == 0) ||
           (strcmp(key, "ANCHOR_ADDR") == 0) ||
           (strcmp(key, "NODE") == 0) ||
           (strcmp(key, "NODE_ADDR") == 0);
}

static bool key_is_distance(const char *key)
{
    return (strcmp(key, "DIST") == 0) || (strcmp(key, "DISTANCE") == 0) ||
           (strcmp(key, "DIST_MM") == 0) || (strcmp(key, "RANGE") == 0) ||
           (strcmp(key, "RANGE_MM") == 0) || (strcmp(key, "MM") == 0);
}

static bool key_is_snr(const char *key)
{
    return (strcmp(key, "SNR") == 0) || (strcmp(key, "SNR_DB") == 0);
}

void uwb_text_parser_init(UwbTextParser *parser)
{
    parser->line[0] = '\0';
    parser->length = 0U;
    parser->overflowed = false;
}

bool uwb_text_parse_line(const char *line, uint32_t timestamp_ms,
                         LockUwbMeasurement *measurement)
{
    char scratch[LOCK_UWB_RAW_LINE_CAPACITY];
    char *frame;
    char *token;
    char *fallback_fields[4];
    uint8_t fallback_count = 0U;
    bool have_key_addr = false;
    bool have_station_addr = false;
    bool have_distance = false;
    bool have_snr = false;
    bool first_field = true;
    CompactFrameKind compact_kind = COMPACT_FRAME_NONE;
    uint16_t station_addr = 0U;
    uint16_t key_addr = 0U;
    uint8_t key_id = 0U;
    uint32_t distance_mm = 0U;
    int16_t snr_db = 0;
    size_t i;

    if ((line == NULL) || (measurement == NULL)) {
        return false;
    }
    measurement->valid = false;

    strncpy(scratch, line, sizeof(scratch) - 1U);
    scratch[sizeof(scratch) - 1U] = '\0';
    frame = trim_in_place(scratch);
    if ((toupper((unsigned char)frame[0]) == 'R') &&
        (toupper((unsigned char)frame[1]) == 'E') &&
        (frame[2] == ':')) {
        frame = trim_in_place(frame + 3);
    }
    for (i = 0U; frame[i] != '\0'; i++) {
        if ((frame[i] == ';') || (frame[i] == '\t') ||
            isspace((unsigned char)frame[i])) {
            frame[i] = ',';
        }
    }

    token = strtok(frame, ",");
    while (token != NULL) {
        char *separator;
        char *name;
        char *field = trim_in_place(token);

        if (*field != '\0') {
            separator = strchr(field, '=');
            if (separator == NULL) {
                separator = strchr(field, ':');
            }

            if (separator != NULL) {
                *separator = '\0';
                name = trim_in_place(field);
                field = trim_in_place(separator + 1);
                uppercase_ascii(name);
                if (key_is_id(name) &&
                    parse_address(field, &key_addr)) {
                    have_key_addr = true;
                } else if (key_is_station(name) &&
                           parse_address(field, &station_addr)) {
                    have_station_addr = true;
                } else if (key_is_distance(name) &&
                           parse_distance_mm(field, &distance_mm)) {
                    have_distance = true;
                } else if (key_is_snr(name) &&
                           parse_snr_db(field, &snr_db)) {
                    have_snr = true;
                }
            } else {
                CompactFrameKind field_kind =
                    first_field ? compact_frame_kind(field)
                                : COMPACT_FRAME_NONE;

                if (field_kind != COMPACT_FRAME_NONE) {
                    compact_kind = field_kind;
                } else if ((fallback_count < 4U) &&
                           ((isxdigit((unsigned char)field[0]) != 0) ||
                            (field[0] == '+') ||
                            (field[0] == '-'))) {
                    fallback_fields[fallback_count++] = field;
                }
            }
            first_field = false;
        }

        token = strtok(NULL, ",");
    }

    if ((!have_key_addr && !have_station_addr) &&
        (fallback_count >= 1U)) {
        if (compact_kind == COMPACT_FRAME_STATION) {
            have_station_addr =
                parse_address(fallback_fields[0], &station_addr);
        } else {
            have_key_addr =
                parse_address(fallback_fields[0], &key_addr);
        }
    }
    if (!have_distance && (fallback_count >= 2U)) {
        have_distance =
            parse_distance_mm(fallback_fields[1], &distance_mm);
    }
    if (!have_snr && (fallback_count >= 3U)) {
        have_snr = parse_snr_db(fallback_fields[2], &snr_db);
    }

    if (!have_distance || (!have_key_addr && !have_station_addr)) {
        measurement->valid = false;
        return false;
    }

    memset(measurement, 0, sizeof(*measurement));
    measurement->valid = true;
    measurement->station_addr_valid = have_station_addr;
    measurement->station_addr = station_addr;
    measurement->key_addr_valid = have_key_addr;
    measurement->key_addr = key_addr;
    if (have_key_addr) {
        key_id = (uint8_t)(key_addr & 0x0FU);
    }
    measurement->key_id = key_id;
    measurement->snr_valid = have_snr;
    measurement->snr_db = snr_db;
    measurement->distance_mm = distance_mm;
    measurement->timestamp_ms = timestamp_ms;
    measurement->raw_length =
        (uint8_t)bounded_string_length(
            line, LOCK_UWB_RAW_LINE_CAPACITY - 1U);
    memcpy(measurement->raw_line, line, measurement->raw_length);
    measurement->raw_line[measurement->raw_length] = '\0';
    return true;
}

bool uwb_text_parser_push(UwbTextParser *parser, uint8_t byte,
                          uint32_t timestamp_ms,
                          LockUwbMeasurement *measurement)
{
    if (byte == '\r') {
        return false;
    }

    if (byte == '\n') {
        bool parsed = false;

        if (!parser->overflowed && (parser->length > 0U)) {
            parser->line[parser->length] = '\0';
            parsed = uwb_text_parse_line(parser->line, timestamp_ms,
                                         measurement);
        }
        parser->length = 0U;
        parser->overflowed = false;
        return parsed;
    }

    if (parser->overflowed) {
        return false;
    }

    if ((size_t)parser->length >= (sizeof(parser->line) - 1U)) {
        parser->length = 0U;
        parser->overflowed = true;
        return false;
    }

    parser->line[parser->length++] = (char)byte;
    return false;
}
