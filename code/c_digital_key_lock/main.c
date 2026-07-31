#include "ti_msp_dl_config.h"

#include "lock_app.h"
#include "lock_hw.h"

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

        lock_app_update(&app, now_ms, lock_hw_read_id_inputs_low_active());
        lock_hw_apply_outputs(lock_app_outputs(&app));
        if (lock_app_should_present_display(&app, now_ms)) {
            lock_hw_present_display(lock_app_display(&app));
        }

        if (!had_uart_work) {
            lock_hw_idle();
        }
    }
}
