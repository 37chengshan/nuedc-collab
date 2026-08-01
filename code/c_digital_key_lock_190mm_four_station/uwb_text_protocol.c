#include "uwb_text_protocol.h"

#include <ctype.h>
#include <stdlib.h>
#include <string.h>

static size_t bounded_string_length(const char *text, size_t capacity)
{
    size_t length = 0U;

    while ((length < capacity) && (text[length] != '\0')) {
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

static bool has_compact_uwb_prefix(const char *line)
{
    while (isspace((unsigned char)*line)) {
        line++;
    }
    if (toupper((unsigned char)line[0]) != 'P') {
        return false;
    }
    return (line[1] == ',') || isdigit((unsigned char)line[1]);
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
    if ((*endptr != '\0') || (value > (UINT32_MAX / multiplier))) {
        return false;
    }

    *distance_mm_out = (uint32_t)(value * multiplier);
    return true;
}

static bool key_is_id(const char *key)
{
    return (strcmp(key, "ID") == 0) || (strcmp(key, "ADDR") == 0) ||
           (strcmp(key, "ADDRESS") == 0) || (strcmp(key, "KEY") == 0) ||
           (strcmp(key, "KEYID") == 0);
}

static bool key_is_distance(const char *key)
{
    return (strcmp(key, "DIST") == 0) || (strcmp(key, "DISTANCE") == 0) ||
           (strcmp(key, "DIST_MM") == 0) || (strcmp(key, "RANGE") == 0) ||
           (strcmp(key, "RANGE_MM") == 0) || (strcmp(key, "MM") == 0);
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
    char *token;
    char *fallback_fields[4];
    uint8_t fallback_count = 0U;
    bool have_id = false;
    bool have_distance = false;
    uint16_t key_addr = 0U;
    uint8_t key_id = 0U;
    uint32_t distance_mm = 0U;
    size_t i;

    strncpy(scratch, line, sizeof(scratch) - 1U);
    scratch[sizeof(scratch) - 1U] = '\0';
    for (i = 0U; scratch[i] != '\0'; i++) {
        if ((scratch[i] == ';') || (scratch[i] == '\t') ||
            isspace((unsigned char)scratch[i])) {
            scratch[i] = ',';
        }
    }

    token = strtok(scratch, ",");
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
                    have_id = true;
                } else if (key_is_distance(name) &&
                           parse_distance_mm(field, &distance_mm)) {
                    have_distance = true;
                }
            } else if ((fallback_count < 4U) &&
                       (isxdigit((unsigned char)field[0]) != 0)) {
                fallback_fields[fallback_count++] = field;
            }
        }

        token = strtok(NULL, ",");
    }

    if ((!have_id || !have_distance) && (fallback_count >= 2U) &&
        has_compact_uwb_prefix(line)) {
        if (!have_id) {
            have_id = parse_address(fallback_fields[0], &key_addr);
        }
        if (!have_distance) {
            have_distance =
                parse_distance_mm(fallback_fields[1], &distance_mm);
        }
    }

    if (!have_id || !have_distance) {
        measurement->valid = false;
        return false;
    }

    memset(measurement, 0, sizeof(*measurement));
    measurement->valid = true;
    measurement->key_addr = key_addr;
    key_id = (uint8_t)(key_addr & 0x0FU);
    measurement->key_id = key_id;
    measurement->distance_mm = distance_mm;
    measurement->timestamp_ms = timestamp_ms;
    measurement->raw_length =
        (uint8_t)bounded_string_length(line,
                                       LOCK_UWB_RAW_LINE_CAPACITY - 1U);
    memcpy(measurement->raw_line, line, measurement->raw_length);
    measurement->raw_line[measurement->raw_length] = '\0';
    return true;
}

bool uwb_text_parser_push(UwbTextParser *parser, uint8_t byte,
                          uint32_t timestamp_ms,
                          LockUwbMeasurement *measurement)
{
    if ((byte == '\r') || (byte == '\n')) {
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
