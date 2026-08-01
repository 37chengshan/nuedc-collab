#ifndef LOCK_HW_H
#define LOCK_HW_H

#include "lock_types.h"

#include <stdbool.h>
#include <stdint.h>

void lock_hw_init(void);
uint32_t lock_hw_millis(void);
bool lock_hw_uart_channel_read_byte(uint8_t channel, uint8_t *byte);
bool lock_hw_uart_channel_take_overflow(uint8_t channel);
uint8_t lock_hw_read_id_inputs_low_active(void);
void lock_hw_apply_outputs(const LockOutputSnapshot *outputs);
void lock_hw_present_display(const LockDisplayModel *display);
void lock_hw_idle(void);

#endif
