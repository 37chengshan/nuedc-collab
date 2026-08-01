#include "id_input.h"

#include "lock_app_config.h"

#include <string.h>

void id_input_init(LockIdInput *input, LockIdInputBackend backend)
{
    memset(input, 0, sizeof(*input));
    input->backend = backend;
}

void id_input_process(LockIdInput *input, uint8_t raw_low_active_bits,
                      uint32_t now_ms)
{
    uint8_t sanitized = (uint8_t)(raw_low_active_bits & 0x0FU);
    uint8_t bit;

    if (input->backend == LOCK_ID_INPUT_DIRECT_BITS) {
        if (!input->direct_initialized) {
            input->logical_value = sanitized;
            input->stable_raw_bits = sanitized;
            input->last_raw_bits = sanitized;
            input->direct_initialized = true;
            return;
        }

        for (bit = 0U; bit < LOCK_ID_BIT_COUNT; bit++) {
            uint8_t mask = (uint8_t)(1U << bit);
            bool raw_on = (sanitized & mask) != 0U;
            bool last_on = (input->last_raw_bits & mask) != 0U;
            bool stable_on = (input->stable_raw_bits & mask) != 0U;

            if (raw_on != last_on) {
                input->last_raw_bits ^= mask;
                input->change_started_ms[bit] = now_ms;
                continue;
            }
            if (raw_on == stable_on) {
                continue;
            }
            if ((now_ms - input->change_started_ms[bit]) <
                LOCK_ID_INPUT_DEBOUNCE_MS) {
                continue;
            }

            if (raw_on) {
                input->stable_raw_bits |= mask;
                input->logical_value |= mask;
            } else {
                input->stable_raw_bits &= (uint8_t)(~mask);
                input->logical_value &= (uint8_t)(~mask);
            }
        }
        return;
    }

    for (bit = 0U; bit < LOCK_ID_BIT_COUNT; bit++) {
        uint8_t mask = (uint8_t)(1U << bit);
        bool raw_pressed = (sanitized & mask) != 0U;
        bool last_pressed = (input->last_raw_bits & mask) != 0U;
        bool stable_pressed = (input->stable_raw_bits & mask) != 0U;

        if (raw_pressed != last_pressed) {
            input->last_raw_bits ^= mask;
            input->change_started_ms[bit] = now_ms;
            continue;
        }

        if (raw_pressed == stable_pressed) {
            continue;
        }

        if ((now_ms - input->change_started_ms[bit]) <
            LOCK_ID_INPUT_DEBOUNCE_MS) {
            continue;
        }

        if (raw_pressed) {
            input->stable_raw_bits |= mask;
            input->logical_value ^= mask;
        } else {
            input->stable_raw_bits &= (uint8_t)(~mask);
        }
    }
}

uint8_t id_input_get_value(const LockIdInput *input)
{
    return (uint8_t)(input->logical_value & 0x0FU);
}
