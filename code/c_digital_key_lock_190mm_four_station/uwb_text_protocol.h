#ifndef UWB_TEXT_PROTOCOL_H
#define UWB_TEXT_PROTOCOL_H

#include "lock_types.h"

typedef struct {
    char line[LOCK_UWB_RAW_LINE_CAPACITY];
    uint8_t length;
    bool overflowed;
} UwbTextParser;

void uwb_text_parser_init(UwbTextParser *parser);
bool uwb_text_parse_line(const char *line, uint32_t timestamp_ms,
                         LockUwbMeasurement *measurement);
bool uwb_text_parser_push(UwbTextParser *parser, uint8_t byte,
                          uint32_t timestamp_ms,
                          LockUwbMeasurement *measurement);

#endif
