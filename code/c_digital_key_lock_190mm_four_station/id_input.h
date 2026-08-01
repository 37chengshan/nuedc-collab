#ifndef ID_INPUT_H
#define ID_INPUT_H

#include "lock_types.h"

typedef enum {
    LOCK_ID_INPUT_TOGGLE_BUTTONS = 0,
    LOCK_ID_INPUT_DIRECT_BITS
} LockIdInputBackend;

typedef struct {
    LockIdInputBackend backend;
    uint8_t logical_value;
    uint8_t stable_raw_bits;
    uint8_t last_raw_bits;
    uint32_t change_started_ms[LOCK_ID_BIT_COUNT];
} LockIdInput;

void id_input_init(LockIdInput *input, LockIdInputBackend backend);
void id_input_process(LockIdInput *input, uint8_t raw_low_active_bits,
                      uint32_t now_ms);
uint8_t id_input_get_value(const LockIdInput *input);

#endif
