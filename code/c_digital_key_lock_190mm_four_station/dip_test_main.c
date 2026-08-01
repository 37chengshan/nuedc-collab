#include "ti_msp_dl_config.h"

#include "lock_display_ui.h"
#include "lock_hw.h"

#include <string.h>

/*
 * Dedicated four-way DIP diagnostic firmware.
 *
 * Wiring (active low, the other side of every switch goes to GND):
 *   A / bit0 = PA28
 *   B / bit1 = PA31
 *   C / bit2 = PA13
 *   D / bit3 = PA16
 *
 * Screen:
 *   DIP SET = decoded bit3..bit0
 *   TAG ID  = legacy PB0/PB1/PB2/PB3 probe value
 *   A/B/C/D = each raw active-low switch state, shown as 000 or 001
 *
 * The buzzer, relay, and all indicator LEDs remain inactive.
 */
int main(void)
{
    LockDisplayModel display;
    LockOutputSnapshot outputs;
    uint8_t heartbeat = 0U;
    const uint32_t dip_mask =
        SET_ID_INPUTS_SET_ID_BIT0_PIN |
        SET_ID_INPUTS_SET_ID_BIT1_PIN |
        SET_ID_INPUTS_SET_ID_BIT2_PIN |
        SET_ID_INPUTS_SET_ID_BIT3_PIN;
    const uint32_t legacy_mask =
        DIP_LEGACY_PROBE_PB0_PIN |
        DIP_LEGACY_PROBE_PB1_PIN |
        DIP_LEGACY_PROBE_PB2_PIN |
        DIP_LEGACY_PROBE_PB3_PIN;

    SYSCFG_DL_init();
    lock_hw_init();

    /*
     * Re-assert the four pins as GPIO inputs after every other peripheral
     * has initialized. This also guarantees that none of them remains in
     * output mode because of stale generated/build artifacts.
     */
    DL_GPIO_disableOutput(SET_ID_INPUTS_PORT, dip_mask);
    DL_GPIO_disableOutput(DIP_LEGACY_PROBE_PORT, legacy_mask);
    DL_GPIO_initDigitalInputFeatures(
        SET_ID_INPUTS_SET_ID_BIT0_IOMUX, DL_GPIO_INVERSION_DISABLE,
        DL_GPIO_RESISTOR_PULL_UP, DL_GPIO_HYSTERESIS_ENABLE,
        DL_GPIO_WAKEUP_DISABLE);
    DL_GPIO_initDigitalInputFeatures(
        SET_ID_INPUTS_SET_ID_BIT1_IOMUX, DL_GPIO_INVERSION_DISABLE,
        DL_GPIO_RESISTOR_PULL_UP, DL_GPIO_HYSTERESIS_ENABLE,
        DL_GPIO_WAKEUP_DISABLE);
    DL_GPIO_initDigitalInputFeatures(
        SET_ID_INPUTS_SET_ID_BIT2_IOMUX, DL_GPIO_INVERSION_DISABLE,
        DL_GPIO_RESISTOR_PULL_UP, DL_GPIO_HYSTERESIS_ENABLE,
        DL_GPIO_WAKEUP_DISABLE);
    DL_GPIO_initDigitalInputFeatures(
        SET_ID_INPUTS_SET_ID_BIT3_IOMUX, DL_GPIO_INVERSION_DISABLE,
        DL_GPIO_RESISTOR_PULL_UP, DL_GPIO_HYSTERESIS_ENABLE,
        DL_GPIO_WAKEUP_DISABLE);
    DL_GPIO_initDigitalInputFeatures(
        DIP_LEGACY_PROBE_PB0_IOMUX, DL_GPIO_INVERSION_DISABLE,
        DL_GPIO_RESISTOR_PULL_UP, DL_GPIO_HYSTERESIS_ENABLE,
        DL_GPIO_WAKEUP_DISABLE);
    DL_GPIO_initDigitalInputFeatures(
        DIP_LEGACY_PROBE_PB1_IOMUX, DL_GPIO_INVERSION_DISABLE,
        DL_GPIO_RESISTOR_PULL_UP, DL_GPIO_HYSTERESIS_ENABLE,
        DL_GPIO_WAKEUP_DISABLE);
    DL_GPIO_initDigitalInputFeatures(
        DIP_LEGACY_PROBE_PB2_IOMUX, DL_GPIO_INVERSION_DISABLE,
        DL_GPIO_RESISTOR_PULL_UP, DL_GPIO_HYSTERESIS_ENABLE,
        DL_GPIO_WAKEUP_DISABLE);
    DL_GPIO_initDigitalInputFeatures(
        DIP_LEGACY_PROBE_PB3_IOMUX, DL_GPIO_INVERSION_DISABLE,
        DL_GPIO_RESISTOR_PULL_UP, DL_GPIO_HYSTERESIS_ENABLE,
        DL_GPIO_WAKEUP_DISABLE);

    memset(&display, 0, sizeof(display));
    memset(&outputs, 0, sizeof(outputs));
    display.monitor_only = true;
    display.state = LOCK_STATE_LOCKED;
    display.zone = LOCK_ZONE_INVALID;
    display.channel_valid_mask = 0x0FU;
    display.observed_id_valid = true;
    display.authorized = true;

    /* Explicitly hold every actuator inactive throughout this test. */
    lock_hw_apply_outputs(&outputs);

    while (1) {
        uint8_t bit;
        uint8_t raw_bits = 0U;
        uint8_t legacy_bits = 0U;
        uint32_t pins = SET_ID_INPUTS_PORT->DIN31_0;
        uint32_t legacy_pins = DIP_LEGACY_PROBE_PORT->DIN31_0;

        if ((pins & SET_ID_INPUTS_SET_ID_BIT0_PIN) == 0U) {
            raw_bits |= 0x01U;
        }
        if ((pins & SET_ID_INPUTS_SET_ID_BIT1_PIN) == 0U) {
            raw_bits |= 0x02U;
        }
        if ((pins & SET_ID_INPUTS_SET_ID_BIT2_PIN) == 0U) {
            raw_bits |= 0x04U;
        }
        if ((pins & SET_ID_INPUTS_SET_ID_BIT3_PIN) == 0U) {
            raw_bits |= 0x08U;
        }
        if ((legacy_pins & DIP_LEGACY_PROBE_PB0_PIN) == 0U) {
            legacy_bits |= 0x01U;
        }
        if ((legacy_pins & DIP_LEGACY_PROBE_PB1_PIN) == 0U) {
            legacy_bits |= 0x02U;
        }
        if ((legacy_pins & DIP_LEGACY_PROBE_PB2_PIN) == 0U) {
            legacy_bits |= 0x04U;
        }
        if ((legacy_pins & DIP_LEGACY_PROBE_PB3_PIN) == 0U) {
            legacy_bits |= 0x08U;
        }
        display.expected_id = raw_bits;
        display.observed_id = legacy_bits;
        display.expected_address = (uint16_t)raw_bits;
        display.observed_address = (uint16_t)legacy_bits;
        display.authorized = (raw_bits == legacy_bits);

        /*
         * Deliberately do not use lock_hw_millis() here. Advancing by one
         * complete UI period forces a redraw even if SysTick is not firing.
         */
        display.now_ms += LOCK_DISPLAY_UI_REFRESH_MS;
        display.position.valid = true;
        display.position.boundary_distance_mm = (float)heartbeat * 10.0f;
        display.position.angle_valid = true;
        display.position.bearing_deg = (float)heartbeat;

        for (bit = 0U; bit < LOCK_ID_BIT_COUNT; bit++) {
            display.channel_distance_mm[bit] =
                ((raw_bits & (uint8_t)(1U << bit)) != 0U) ? 10U : 0U;
        }

        lock_hw_present_display(&display);
        heartbeat = (uint8_t)((heartbeat + 1U) & 0x0FU);
        delay_cycles(CPUCLK_FREQ / 5U);
    }
}
