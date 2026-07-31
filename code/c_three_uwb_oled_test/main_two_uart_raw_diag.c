#include "ti_msp_dl_config.h"

#include "../dimengxing_receiver/oled.h"
#include "oled_recovery.h"
#include "uwb_monitor.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define RAW_TAIL_LENGTH 15U
#define UART_RX_RING_SIZE 128U
#define UART_RX_RING_MASK (UART_RX_RING_SIZE - 1U)
#define OLED_DIAG_UPDATE_INTERVAL_MS 500U

typedef struct {
    volatile uint8_t data[UART_RX_RING_SIZE];
    volatile uint8_t head;
    volatile uint8_t tail;
    volatile bool overflow;
} UartRxRing;

static UwbMonitor g_monitor;
static UartRxRing g_rx_rings[UWB_CHANNEL_COUNT];
static char g_raw_tail[UWB_CHANNEL_COUNT][RAW_TAIL_LENGTH + 1U];
static uint8_t g_raw_tail_length[UWB_CHANNEL_COUNT];
static uint32_t g_line_count[UWB_CHANNEL_COUNT];
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

static void push_raw_tail(uint8_t channel, uint8_t byte)
{
    uint8_t length;

    if ((byte == '\r') || (byte == '\n')) {
        if (g_raw_tail_length[channel] > 0U) {
            g_line_count[channel]++;
        }
        return;
    }

    if ((byte < 32U) || (byte > 126U)) {
        byte = (uint8_t)'.';
    }

    length = g_raw_tail_length[channel];
    if (length < RAW_TAIL_LENGTH) {
        g_raw_tail[channel][length] = (char)byte;
        g_raw_tail_length[channel] = (uint8_t)(length + 1U);
    } else {
        memmove(g_raw_tail[channel], &g_raw_tail[channel][1],
                RAW_TAIL_LENGTH - 1U);
        g_raw_tail[channel][RAW_TAIL_LENGTH - 1U] = (char)byte;
    }
    g_raw_tail[channel][g_raw_tail_length[channel]] = '\0';
}

static bool drain_uart_ring(uint8_t channel)
{
    UartRxRing *ring = &g_rx_rings[channel];
    bool received = false;

    while (ring->tail != ring->head) {
        uint8_t tail = ring->tail;
        uint8_t byte = ring->data[tail];

        ring->tail = (uint8_t)((tail + 1U) & UART_RX_RING_MASK);
        push_raw_tail(channel, byte);
        (void)uwb_monitor_push_byte(&g_monitor, channel, byte);
        received = true;
    }

    return received;
}

static char channel_status(uint8_t channel)
{
    const UwbChannelState *state = uwb_monitor_channel(&g_monitor, channel);

    if (state == NULL) {
        return '?';
    }
    if (state->valid) {
        return 'O';
    }
    if (state->received_bytes > 0U) {
        return 'B';
    }
    return 'W';
}

static bool draw_screen(void)
{
    const UwbChannelState *state1 = uwb_monitor_channel(&g_monitor, 0U);
    const UwbChannelState *state2 = uwb_monitor_channel(&g_monitor, 1U);
    char row[17];

    OLED_ClearBuffer();

    (void)snprintf(row, sizeof(row), "B1:%lu B2:%lu",
                   (unsigned long)(state1->received_bytes % 10000U),
                   (unsigned long)(state2->received_bytes % 10000U));
    OLED_ShowString(0U, 0U, (u8 *)row, 16U);

    (void)snprintf(row, sizeof(row), "1%s", g_raw_tail[0]);
    OLED_ShowString(0U, 16U, (u8 *)row, 16U);

    (void)snprintf(row, sizeof(row), "2%s", g_raw_tail[1]);
    OLED_ShowString(0U, 32U, (u8 *)row, 16U);

    (void)snprintf(row, sizeof(row), "S:1%c 2%c L:%lu/%lu",
                   channel_status(0U), channel_status(1U),
                   (unsigned long)(g_line_count[0] % 100U),
                   (unsigned long)(g_line_count[1] % 100U));
    OLED_ShowString(0U, 48U, (u8 *)row, 16U);

    return OLED_Refresh() == OLED_STATUS_OK;
}

int main(void)
{
    bool oled_initialized;
    OledRecoveryState oled_recovery;
    uint32_t last_oled_update_ms = 0U;

    SYSCFG_DL_init();
    uwb_monitor_init(&g_monitor);
    memset(g_rx_rings, 0, sizeof(g_rx_rings));
    memset(g_raw_tail, 0, sizeof(g_raw_tail));
    memset(g_raw_tail_length, 0, sizeof(g_raw_tail_length));
    memset(g_line_count, 0, sizeof(g_line_count));
    g_millis = 0U;
    (void)SysTick_Config(CPUCLK_FREQ / 1000U);

    NVIC_ClearPendingIRQ(UWB_CH1_INST_INT_IRQN);
    NVIC_ClearPendingIRQ(UWB_CH2_INST_INT_IRQN);
    NVIC_EnableIRQ(UWB_CH1_INST_INT_IRQN);
    NVIC_EnableIRQ(UWB_CH2_INST_INT_IRQN);

    oled_initialized = (OLED_Init() == OLED_STATUS_OK);
    oled_recovery_init(&oled_recovery, oled_initialized, g_millis);
    if (oled_initialized) {
        oled_recovery_record_refresh(
            &oled_recovery, draw_screen(), g_millis);
    }
    last_oled_update_ms = g_millis;

    while (1) {
        uint32_t now_ms = g_millis;

        (void)drain_uart_ring(0U);
        (void)drain_uart_ring(1U);

        if (oled_recovery_is_ready(&oled_recovery) &&
            ((now_ms - last_oled_update_ms) >=
             OLED_DIAG_UPDATE_INTERVAL_MS)) {
            oled_recovery_record_refresh(
                &oled_recovery, draw_screen(), now_ms);
            last_oled_update_ms = now_ms;
        } else if (oled_recovery_reinit_due(&oled_recovery, now_ms)) {
            SYSCFG_DL_OLED_init();
            oled_initialized = (OLED_Init() == OLED_STATUS_OK);
            oled_recovery_record_reinit(
                &oled_recovery, oled_initialized, now_ms);
            if (oled_initialized) {
                oled_recovery_record_refresh(
                    &oled_recovery, draw_screen(), g_millis);
                last_oled_update_ms = g_millis;
            }
        }
    }
}
