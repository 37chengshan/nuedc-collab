#include "uwb_capture_parser.h"

#include <stdio.h>

static unsigned int assertions;

#define CHECK(condition)                                                       \
    do {                                                                       \
        assertions++;                                                          \
        if (!(condition)) {                                                    \
            fprintf(stderr, "%s:%d failed: %s\n", __FILE__, __LINE__,        \
                    #condition);                                               \
            return 1;                                                          \
        }                                                                      \
    } while (0)

int main(void)
{
    UwbCaptureParser parser;
    uint32_t distance = 0U;
    const char *frame = "P0,0100,195cm,19dB\r\n";
    const char *cursor;

    CHECK(uwb_capture_parse_distance(
        "P0,0100,195cm,19dB", &distance));
    CHECK(distance == 1950U);
    CHECK(uwb_capture_parse_distance(
        "ID=000A,DIST=1234", &distance));
    CHECK(distance == 1234U);
    CHECK(uwb_capture_parse_distance(
        "ADDR:000A,RANGE:2m", &distance));
    CHECK(distance == 2000U);
    CHECK(!uwb_capture_parse_distance("P0,0100,19dB", &distance));

    uwb_capture_parser_init(&parser);
    for (cursor = frame; *cursor != '\0'; cursor++) {
        if (uwb_capture_parser_push(
                &parser, (uint8_t)*cursor, &distance)) {
            CHECK(distance == 1950U);
        }
    }
    CHECK(parser.length == 0U);

    printf("%u assertions, 0 failures\n", assertions);
    return 0;
}
