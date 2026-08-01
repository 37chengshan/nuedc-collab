#include "monitor_display.h"
#include "ti_msp_dl_config.h"
#include "uwb_capture_parser.h"

#include <stdbool.h>
#include <stdint.h>

#define DISPLAY_PERIOD_MS 500U
#define OK_GROWTH_PERIODS 3U
#define LOST_TIMEOUT_MS 3000U
#define RX_RING_SIZE 128U
#define RX_RING_MASK (RX_RING_SIZE - 1U)

static volatile uint32_t g_millis;
static volatile uint32_t g_byte_count[UWB_MONITOR_CHANNEL_COUNT];
static volatile uint8_t
    g_rx_ring[UWB_MONITOR_CHANNEL_COUNT][RX_RING_SIZE];
static volatile uint8_t g_rx_head[UWB_MONITOR_CHANNEL_COUNT];
static volatile uint8_t g_rx_tail[UWB_MONITOR_CHANNEL_COUNT];

void SysTick_Handler(void)
{
    g_millis++;
}

static void capture_uart_bytes(uint8_t channel, UART_Regs *uart)
{
    (void)DL_UART_Main_getPendingInterrupt(uart);
    while (!DL_UART_Main_isRXFIFOEmpty(uart)) {
        uint8_t byte = (uint8_t)DL_UART_Main_receiveData(uart);
        uint8_t next =
            (uint8_t)((g_rx_head[channel] + 1U) & RX_RING_MASK);

        g_byte_count[channel]++;
        if (next != g_rx_tail[channel]) {
            g_rx_ring[channel][g_rx_head[channel]] = byte;
            g_rx_head[channel] = next;
        }
    }
}

void UWB1_INST_IRQHandler(void)
{
    capture_uart_bytes(0U, UWB1_INST);
}

void UWB2_INST_IRQHandler(void)
{
    capture_uart_bytes(1U, UWB2_INST);
}

void UWB3_INST_IRQHandler(void)
{
    capture_uart_bytes(2U, UWB3_INST);
}

void UWB4_INST_IRQHandler(void)
{
    capture_uart_bytes(3U, UWB4_INST);
}

static bool read_ring_byte(uint8_t channel, uint8_t *byte)
{
    if (g_rx_tail[channel] == g_rx_head[channel]) {
        return false;
    }
    *byte = g_rx_ring[channel][g_rx_tail[channel]];
    g_rx_tail[channel] =
        (uint8_t)((g_rx_tail[channel] + 1U) & RX_RING_MASK);
    return true;
}

static void drain_uart(UART_Regs *uart)
{
    while (!DL_UART_Main_isRXFIFOEmpty(uart)) {
        (void)DL_UART_Main_receiveData(uart);
    }
}

int main(void)
{
    static UART_Regs *const uarts[UWB_MONITOR_CHANNEL_COUNT] = {
        UWB1_INST, UWB2_INST, UWB3_INST, UWB4_INST};
    static const IRQn_Type irqs[UWB_MONITOR_CHANNEL_COUNT] = {
        UWB1_INST_INT_IRQN, UWB2_INST_INT_IRQN,
        UWB3_INST_INT_IRQN, UWB4_INST_INT_IRQN};
    uint32_t previous_count[UWB_MONITOR_CHANNEL_COUNT] = {0U};
    uint32_t last_growth_ms[UWB_MONITOR_CHANNEL_COUNT] = {0U};
    uint8_t growth_periods[UWB_MONITOR_CHANNEL_COUNT] = {0U};
    UwbCaptureParser parsers[UWB_MONITOR_CHANNEL_COUNT];
    UwbMonitorSnapshot snapshot = {0};
    uint32_t next_display_ms = 0U;
    uint8_t channel;

    SYSCFG_DL_init();
    (void)SysTick_Config(CPUCLK_FREQ / 1000U);

    for (channel = 0U; channel < UWB_MONITOR_CHANNEL_COUNT; channel++) {
        g_byte_count[channel] = 0U;
        g_rx_head[channel] = 0U;
        g_rx_tail[channel] = 0U;
        uwb_capture_parser_init(&parsers[channel]);
        drain_uart(uarts[channel]);
        NVIC_ClearPendingIRQ(irqs[channel]);
        NVIC_EnableIRQ(irqs[channel]);
    }

    monitor_display_init();
    monitor_display_present(&snapshot);

    while (1) {
        uint32_t now_ms = g_millis;

        for (channel = 0U; channel < UWB_MONITOR_CHANNEL_COUNT; channel++) {
            uint8_t byte;

            while (read_ring_byte(channel, &byte)) {
                uint32_t distance_mm;

                if (uwb_capture_parser_push(
                        &parsers[channel], byte, &distance_mm)) {
                    snapshot.distance_mm[channel] = distance_mm;
                    snapshot.distance_valid[channel] = true;
                }
            }
        }

        if ((int32_t)(now_ms - next_display_ms) >= 0) {
            next_display_ms = now_ms + DISPLAY_PERIOD_MS;

            for (channel = 0U; channel < UWB_MONITOR_CHANNEL_COUNT;
                 channel++) {
                uint32_t count = g_byte_count[channel];

                snapshot.byte_count[channel] = count;
                if (count > previous_count[channel]) {
                    if (growth_periods[channel] < OK_GROWTH_PERIODS) {
                        growth_periods[channel]++;
                    }
                    last_growth_ms[channel] = now_ms;
                    snapshot.status[channel] =
                        (growth_periods[channel] >= OK_GROWTH_PERIODS)
                            ? UWB_MONITOR_OK
                            : UWB_MONITOR_RX;
                } else if (count == 0U) {
                    growth_periods[channel] = 0U;
                    snapshot.status[channel] = UWB_MONITOR_WAIT;
                } else if ((now_ms - last_growth_ms[channel]) >=
                           LOST_TIMEOUT_MS) {
                    growth_periods[channel] = 0U;
                    snapshot.status[channel] = UWB_MONITOR_LOST;
                } else {
                    snapshot.status[channel] = UWB_MONITOR_RX;
                }
                previous_count[channel] = count;
            }

            monitor_display_present(&snapshot);
        }

        __WFI();
    }
}
