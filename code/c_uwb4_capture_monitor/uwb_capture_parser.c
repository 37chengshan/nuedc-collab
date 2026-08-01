#include "uwb_capture_parser.h"

#include <ctype.h>
#include <stdlib.h>
#include <string.h>

static bool equals_ignore_case(const char *left, const char *right)
{
    while ((*left != '\0') && (*right != '\0')) {
        if (toupper((unsigned char)*left) !=
            toupper((unsigned char)*right)) {
            return false;
        }
        left++;
        right++;
    }
    return (*left == '\0') && (*right == '\0');
}

static bool parse_number_with_unit(const char *text, bool require_unit,
                                   uint32_t *distance_mm)
{
    char *end;
    unsigned long value;
    unsigned long multiplier = 1UL;
    bool has_unit = false;

    while (isspace((unsigned char)*text)) {
        text++;
    }
    if (!isdigit((unsigned char)*text)) {
        return false;
    }
    value = strtoul(text, &end, 10);
    while (isspace((unsigned char)*end)) {
        end++;
    }
    if ((toupper((unsigned char)end[0]) == 'C') &&
        (toupper((unsigned char)end[1]) == 'M')) {
        multiplier = 10UL;
        end += 2;
        has_unit = true;
    } else if ((toupper((unsigned char)end[0]) == 'M') &&
               (toupper((unsigned char)end[1]) == 'M')) {
        end += 2;
        has_unit = true;
    } else if (toupper((unsigned char)end[0]) == 'M') {
        multiplier = 1000UL;
        end++;
        has_unit = true;
    }
    while (isspace((unsigned char)*end)) {
        end++;
    }
    if ((*end != '\0') || (require_unit && !has_unit) ||
        (value > (UINT32_MAX / multiplier))) {
        return false;
    }
    *distance_mm = (uint32_t)(value * multiplier);
    return true;
}

bool uwb_capture_parse_distance(const char *line, uint32_t *distance_mm)
{
    char scratch[UWB_CAPTURE_LINE_CAPACITY];
    char *token;

    if ((line == NULL) || (distance_mm == NULL)) {
        return false;
    }
    strncpy(scratch, line, sizeof(scratch) - 1U);
    scratch[sizeof(scratch) - 1U] = '\0';

    token = strtok(scratch, ",;\t ");
    while (token != NULL) {
        char *separator = strchr(token, '=');
        bool distance_key = false;
        const char *value = token;

        if (separator == NULL) {
            separator = strchr(token, ':');
        }
        if (separator != NULL) {
            *separator = '\0';
            value = separator + 1;
            distance_key =
                equals_ignore_case(token, "DIST") ||
                equals_ignore_case(token, "DISTANCE") ||
                equals_ignore_case(token, "RANGE") ||
                equals_ignore_case(token, "DIST_MM");
        }
        if ((distance_key &&
             parse_number_with_unit(value, false, distance_mm)) ||
            ((!distance_key) &&
             parse_number_with_unit(value, true, distance_mm))) {
            return true;
        }
        token = strtok(NULL, ",;\t ");
    }
    return false;
}

void uwb_capture_parser_init(UwbCaptureParser *parser)
{
    memset(parser, 0, sizeof(*parser));
}

bool uwb_capture_parser_push(UwbCaptureParser *parser, uint8_t byte,
                             uint32_t *distance_mm)
{
    if (byte == '\r') {
        return false;
    }
    if (byte == '\n') {
        bool parsed = false;

        if (!parser->overflowed && (parser->length > 0U)) {
            parser->line[parser->length] = '\0';
            parsed =
                uwb_capture_parse_distance(parser->line, distance_mm);
        }
        parser->length = 0U;
        parser->overflowed = false;
        return parsed;
    }
    if (parser->overflowed) {
        return false;
    }
    if (parser->length >= (UWB_CAPTURE_LINE_CAPACITY - 1U)) {
        parser->length = 0U;
        parser->overflowed = true;
        return false;
    }
    parser->line[parser->length++] = (char)byte;
    return false;
}
