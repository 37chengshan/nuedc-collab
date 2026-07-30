#include "ti_msp_dl_config.h"

#include "../dimengxing_receiver/oled.h"
#include "uwb_monitor.h"
#include "uwb_position.h"

#include <stdbool.h>
#include <stdint.h>

#define UART_RX_RING_SIZE 128U
#define UART_RX_RING_MASK (UART_RX_RING_SIZE - 1U)
#define OLED_UPDATE_INTERVAL_MS 100U

typedef struct {
    volatile uint8_t data[UART_RX_RING_SIZE];
    volatile uint32_t timestamps_ms[UART_RX_RING_SIZE];
    volatile uint8_t head;
    volatile uint8_t tail;
    volatile bool overflow;
} UartRxRing;

static UwbMonitor g_monitor;
static UartRxRing g_rx_rings[UWB_CHANNEL_COUNT];
static volatile uint32_t g_millis;

void SysTick_Handler(void)
{
    g_millis++;
}

static void capture_uart(const UART_Regs *instance, UartRxRing *ring)
{
    while (!DL_UART_Main_isRXFIFOEmpty(instance)) {
        uint8_t byte = DL_UART_Main_receiveData(instance);
        uint8_t head = ring->head;
        uint8_t next = (uint8_t)((head + 1U) & UART_RX_RING_MASK);

        if (next != ring->tail) {
            ring->data[head] = byte;
            ring->timestamps_ms[head] = g_millis;
            ring->head = next;
        } else {
            ring->overflow = true;
        }
    }
}

void UWB_CH1_INST_IRQHandler(void)
{
    capture_uart(UWB_CH1_INST, &g_rx_rings[0]);
}

void UWB_CH2_INST_IRQHandler(void)
{
    capture_uart(UWB_CH2_INST, &g_rx_rings[1]);
}

static bool drain_uart_ring(uint8_t channel)
{
    UartRxRing *ring = &g_rx_rings[channel];
    bool frame_complete = false;

    while (ring->tail != ring->head) {
        uint8_t tail = ring->tail;
        uint8_t byte = ring->data[tail];
        uint32_t timestamp_ms = ring->timestamps_ms[tail];

        ring->tail = (uint8_t)((tail + 1U) & UART_RX_RING_MASK);
        if (uwb_monitor_push_byte_at(&g_monitor, channel, byte,
                                     timestamp_ms)) {
            frame_complete = true;
        }
    }

    return frame_complete;
}

static bool draw_screen(uint32_t now_ms)
{
    char lines[UWB_SCREEN_LINE_COUNT][UWB_SCREEN_LINE_SIZE];
    uint8_t line;

    uwb_position_format_screen(&g_monitor, now_ms, lines);
    OLED_ClearBuffer();
    for (line = 0U; line < UWB_SCREEN_LINE_COUNT; line++) {
        OLED_ShowString(0U, (u8)(16U * line), (u8 *)lines[line], 16U);
    }
    return OLED_Refresh() == OLED_STATUS_OK;
}

int main(void)
{
    bool oled_ready;
    uint32_t last_oled_update_ms = 0U;

    SYSCFG_DL_init();
    uwb_monitor_init(&g_monitor);
    g_millis = 0U;
    (void)SysTick_Config(CPUCLK_FREQ / 1000U);

    NVIC_ClearPendingIRQ(UWB_CH1_INST_INT_IRQN);
    NVIC_ClearPendingIRQ(UWB_CH2_INST_INT_IRQN);
    NVIC_EnableIRQ(UWB_CH1_INST_INT_IRQN);
    NVIC_EnableIRQ(UWB_CH2_INST_INT_IRQN);

    oled_ready = (OLED_Init() == OLED_STATUS_OK);
    if (oled_ready) {
        oled_ready = draw_screen(g_millis);
    }

    while (1) {
        uint32_t now_ms = g_millis;

        (void)drain_uart_ring(0U);
        (void)drain_uart_ring(1U);

        if (oled_ready &&
            ((now_ms - last_oled_update_ms) >= OLED_UPDATE_INTERVAL_MS)) {
            oled_ready = draw_screen(now_ms);
            last_oled_update_ms = now_ms;
        }
    }
}
