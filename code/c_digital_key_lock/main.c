#include "ti_msp_dl_config.h"

#include "lock_app.h"
#include "lock_hw.h"

#ifndef LOCK_FIRMWARE_LEVEL
#define LOCK_FIRMWARE_LEVEL 4
#endif

#if (LOCK_FIRMWARE_LEVEL < 2) || (LOCK_FIRMWARE_LEVEL > 4)
#error "LOCK_FIRMWARE_LEVEL must be 2, 3, or 4"
#endif

int main(void)
{
    LockApp app;

    SYSCFG_DL_init();
    lock_hw_init();
    lock_app_init(&app, LOCK_ID_INPUT_DIRECT_BITS);

    while (1) {
        uint8_t channel;
        uint8_t byte;
        uint32_t now_ms = lock_hw_millis();
        bool had_uart_work = false;

        for (channel = 0U; channel < LOCK_UWB_CHANNEL_COUNT; channel++) {
            while (lock_hw_uart_channel_read_byte(channel, &byte)) {
                lock_app_process_uart_byte(&app, channel, byte, now_ms);
                had_uart_work = true;
            }
        }

        uint8_t raw_id_bits = 0U;

#if LOCK_FIRMWARE_LEVEL >= 3
        raw_id_bits = lock_hw_read_id_inputs_low_active();
#endif
        lock_app_update(&app, now_ms, raw_id_bits);
#if LOCK_FIRMWARE_LEVEL >= 4
        lock_hw_apply_outputs(lock_app_outputs(&app));
#endif
        lock_hw_present_display(lock_app_display(&app));

        if (!had_uart_work) {
            lock_hw_idle();
        }
    }
}
