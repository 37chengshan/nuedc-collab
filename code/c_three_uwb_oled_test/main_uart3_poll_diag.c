#include "ti_msp_dl_config.h"

#include "../dimengxing_receiver/oled.h"
#include "uwb_monitor.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define RAW_LINE_CAPACITY 40U

static UwbMonitor g_monitor;
static char g_raw_line[RAW_LINE_CAPACITY];
static uint8_t g_raw_length;
static uint32_t g_line_count;

static void copy_row(char row[17], const char *source, uint8_t offset)
{
    uint8_t index;

    memset(row, ' ', 16U);
    row[16] = '\0';
    for (index = 0U; index < 16U; index++) {
        uint8_t source_index = (uint8_t)(offset + index);
        if ((source_index >= g_raw_length) ||
            (source[source_index] == '\0')) {
            break;
        }
        row[index] = source[source_index];
    }
}

static bool draw_screen(void)
{
    const UwbChannelState *state;
    char row[17];
    char count_row[17];

    state = uwb_monitor_channel(&g_monitor, 1U);
    OLED_ClearBuffer();
    OLED_ShowString(0U, 0U, (u8 *)"UART3 115200", 16U);

    copy_row(row, g_raw_line, 0U);
    OLED_ShowString(0U, 16U, (u8 *)row, 16U);
    copy_row(row, g_raw_line, 16U);
    OLED_ShowString(0U, 32U, (u8 *)row, 16U);

    if (state != NULL) {
        (void)snprintf(count_row, sizeof(count_row), "B:%lu L:%lu %s",
                       (unsigned long)state->received_bytes,
                       (unsigned long)g_line_count,
                       state->valid ? "OK" : "BAD");
    } else {
        (void)snprintf(count_row, sizeof(count_row), "NO STATE");
    }
    OLED_ShowString(0U, 48U, (u8 *)count_row, 16U);
    return OLED_Refresh() == OLED_STATUS_OK;
}

static bool receive_byte(uint8_t byte)
{
    bool line_complete;

    if (byte == '\n') {
        if ((g_raw_length > 0U) &&
            (g_raw_line[g_raw_length - 1U] == '\r')) {
            g_raw_length--;
        }
        g_raw_line[g_raw_length] = '\0';
        g_line_count++;
    } else if (g_raw_length < (RAW_LINE_CAPACITY - 1U)) {
        g_raw_line[g_raw_length++] = (char)byte;
    }

    line_complete = uwb_monitor_push_byte(&g_monitor, 1U, byte);
    if (byte == '\n') {
        return line_complete;
    }
    return false;
}

int main(void)
{
    bool oled_ready;

    SYSCFG_DL_init();
    uwb_monitor_init(&g_monitor);
    memset(g_raw_line, 0, sizeof(g_raw_line));
    g_raw_length = 0U;
    g_line_count = 0U;

    oled_ready = (OLED_Init() == OLED_STATUS_OK);
    if (oled_ready) {
        oled_ready = draw_screen();
    }

    while (1) {
        while (!DL_UART_Main_isRXFIFOEmpty(UWB_CH2_INST)) {
            uint8_t byte = DL_UART_Main_receiveData(UWB_CH2_INST);
            if (receive_byte(byte)) {
                if (oled_ready) {
                    oled_ready = draw_screen();
                }
                g_raw_length = 0U;
                g_raw_line[0] = '\0';
            }
        }
    }
}
