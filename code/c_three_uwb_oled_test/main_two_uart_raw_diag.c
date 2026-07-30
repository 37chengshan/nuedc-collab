#include "ti_msp_dl_config.h"

#include "../dimengxing_receiver/oled.h"
#include "uwb_monitor.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define RAW_TAIL_LENGTH 15U

static UwbMonitor g_monitor;
static char g_raw_tail[UWB_CHANNEL_COUNT][RAW_TAIL_LENGTH + 1U];
static uint8_t g_raw_tail_length[UWB_CHANNEL_COUNT];
static uint32_t g_line_count[UWB_CHANNEL_COUNT];
static uint8_t g_bytes_since_draw;

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

static bool poll_uart(const UART_Regs *instance, uint8_t channel)
{
    bool received = false;

    while (!DL_UART_Main_isRXFIFOEmpty(instance)) {
        uint8_t byte = DL_UART_Main_receiveData(instance);

        push_raw_tail(channel, byte);
        (void)uwb_monitor_push_byte(&g_monitor, channel, byte);
        received = true;
        if (g_bytes_since_draw < 255U) {
            g_bytes_since_draw++;
        }
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

    g_bytes_since_draw = 0U;
    return OLED_Refresh() == OLED_STATUS_OK;
}

int main(void)
{
    bool oled_ready;

    SYSCFG_DL_init();
    uwb_monitor_init(&g_monitor);
    memset(g_raw_tail, 0, sizeof(g_raw_tail));
    memset(g_raw_tail_length, 0, sizeof(g_raw_tail_length));
    memset(g_line_count, 0, sizeof(g_line_count));
    g_bytes_since_draw = 0U;

    oled_ready = (OLED_Init() == OLED_STATUS_OK);
    if (oled_ready) {
        oled_ready = draw_screen();
    }

    while (1) {
        bool received = false;

        received |= poll_uart(UWB_CH1_INST, 0U);
        received |= poll_uart(UWB_CH2_INST, 1U);

        if (oled_ready && received && (g_bytes_since_draw >= 16U)) {
            oled_ready = draw_screen();
        }
    }
}
