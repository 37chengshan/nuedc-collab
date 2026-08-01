#ifndef UWB_CAPTURE_PARSER_H
#define UWB_CAPTURE_PARSER_H

#include <stdbool.h>
#include <stdint.h>

#define UWB_CAPTURE_LINE_CAPACITY 96U

typedef struct {
    char line[UWB_CAPTURE_LINE_CAPACITY];
    uint8_t length;
    bool overflowed;
} UwbCaptureParser;

void uwb_capture_parser_init(UwbCaptureParser *parser);
bool uwb_capture_parse_distance(const char *line, uint32_t *distance_mm);
bool uwb_capture_parser_push(UwbCaptureParser *parser, uint8_t byte,
                             uint32_t *distance_mm);

#endif
