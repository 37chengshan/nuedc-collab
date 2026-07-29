#ifndef LINK_PROTOCOL_H
#define LINK_PROTOCOL_H

#include <stdbool.h>
#include <stdint.h>

#define LINK_FRAME_SIZE 12U
#define LINK_FRAME_HEAD0 0xAAU
#define LINK_FRAME_HEAD1 0x55U
#define LINK_PROTOCOL_VERSION 0x01U
#define LINK_TYPE_DATA 0x01U
#define LINK_TYPE_ACK 0x02U

typedef struct {
    uint8_t bytes[LINK_FRAME_SIZE];
    uint8_t index;
} LinkParser;

static inline uint8_t link_crc8(const uint8_t *data, uint8_t length)
{
    uint8_t crc = 0U;
    uint8_t i;
    uint8_t bit;
    for (i = 0U; i < length; i++) {
        crc ^= data[i];
        for (bit = 0U; bit < 8U; bit++) {
            crc = (crc & 0x80U) ? (uint8_t)((crc << 1U) ^ 0x07U)
                                : (uint8_t)(crc << 1U);
        }
    }
    return crc;
}

static inline void link_build_frame(uint8_t *frame, uint8_t type, uint8_t sequence,
                                    uint8_t address, uint16_t adc_raw,
                                    uint16_t millivolts, uint8_t flags)
{
    frame[0] = LINK_FRAME_HEAD0;
    frame[1] = LINK_FRAME_HEAD1;
    frame[2] = LINK_PROTOCOL_VERSION;
    frame[3] = type;
    frame[4] = sequence;
    frame[5] = (uint8_t)(address & 0x0FU);
    frame[6] = (uint8_t)(adc_raw & 0xFFU);
    frame[7] = (uint8_t)(adc_raw >> 8U);
    frame[8] = (uint8_t)(millivolts & 0xFFU);
    frame[9] = (uint8_t)(millivolts >> 8U);
    frame[10] = flags;
    frame[11] = link_crc8(&frame[2], 9U);
}

static inline bool link_parser_push(LinkParser *parser, uint8_t byte,
                                    uint8_t *frame_out)
{
    uint8_t i;
    if (parser->index == 0U) {
        if (byte == LINK_FRAME_HEAD0) parser->bytes[parser->index++] = byte;
        return false;
    }
    if (parser->index == 1U && byte != LINK_FRAME_HEAD1) {
        parser->index = (byte == LINK_FRAME_HEAD0) ? 1U : 0U;
        parser->bytes[0] = byte;
        return false;
    }
    parser->bytes[parser->index++] = byte;
    if (parser->index < LINK_FRAME_SIZE) return false;
    parser->index = 0U;
    if (parser->bytes[2] != LINK_PROTOCOL_VERSION ||
        parser->bytes[11] != link_crc8(&parser->bytes[2], 9U)) return false;
    for (i = 0U; i < LINK_FRAME_SIZE; i++) frame_out[i] = parser->bytes[i];
    return true;
}

static inline uint16_t link_frame_adc_raw(const uint8_t *frame)
{
    return (uint16_t)frame[6] | ((uint16_t)frame[7] << 8U);
}

static inline uint16_t link_frame_millivolts(const uint8_t *frame)
{
    return (uint16_t)frame[8] | ((uint16_t)frame[9] << 8U);
}

#endif
