#include "ti_msp_dl_config.h"
#include "delay.h"
#include "oled.h"
#include "../link_protocol.h"
#include <stdbool.h>
#include <stdio.h>

#define RX_RING_SIZE 64U

static volatile uint8_t g_rx_ring[RX_RING_SIZE];
static volatile uint8_t g_rx_head;
static volatile uint8_t g_rx_tail;

void LINK_INST_IRQHandler(void)
{
    if (DL_UART_Main_getPendingInterrupt(LINK_INST) == DL_UART_MAIN_IIDX_RX) {
        while (!DL_UART_Main_isRXFIFOEmpty(LINK_INST)) {
            uint8_t next = (uint8_t)((g_rx_head + 1U) & (RX_RING_SIZE - 1U));
            uint8_t byte = (uint8_t)DL_UART_Main_receiveData(LINK_INST);
            if (next != g_rx_tail) {
                g_rx_ring[g_rx_head] = byte;
                g_rx_head = next;
            }
        }
    }
}

static bool uart_read_byte(uint8_t *byte)
{
    if (g_rx_tail == g_rx_head) return false;
    *byte = g_rx_ring[g_rx_tail];
    g_rx_tail = (uint8_t)((g_rx_tail + 1U) & (RX_RING_SIZE - 1U));
    return true;
}

static void uart_send_frame(const uint8_t *frame)
{
    uint8_t i;
    for (i = 0U; i < LINK_FRAME_SIZE; i++) {
        DL_UART_Main_transmitDataBlocking(LINK_INST, frame[i]);
    }
    while (DL_UART_Main_isBusy(LINK_INST)) {
    }
}

int main(void)
{
    char text[24];
    uint8_t byte;
    uint8_t rx_frame[LINK_FRAME_SIZE];
    uint8_t ack_frame[LINK_FRAME_SIZE];
    uint8_t address;
    uint8_t sequence;
    uint16_t adc_raw;
    uint16_t millivolts;
    bool oled_ready;
    LinkParser parser = {{0U}, 0U};

    SYSCFG_DL_init();
    g_rx_head = 0U;
    g_rx_tail = 0U;
    NVIC_ClearPendingIRQ(LINK_INST_INT_IRQN);
    NVIC_EnableIRQ(LINK_INST_INT_IRQN);

    oled_ready = (OLED_Init() == OLED_STATUS_OK);
    if (oled_ready) {
        OLED_ClearBuffer();
        OLED_ShowString(0, 0, (u8 *)"ADDR:-- LINK:--", 16);
        oled_ready = (OLED_Refresh() == OLED_STATUS_OK);
    }

    while (1) {
        while (uart_read_byte(&byte)) {
            if (link_parser_push(&parser, byte, rx_frame) &&
                rx_frame[3] == LINK_TYPE_DATA) {
                sequence = rx_frame[4];
                address = rx_frame[5] & 0x0FU;
                adc_raw = link_frame_adc_raw(rx_frame);
                millivolts = link_frame_millivolts(rx_frame);

                link_build_frame(ack_frame, LINK_TYPE_ACK, sequence, address,
                                 adc_raw, millivolts, 0U);
                uart_send_frame(ack_frame);

                if (oled_ready) {
                    OLED_ClearBuffer();
                    snprintf(text, sizeof(text), "ADDR:%02u LINK:OK", address);
                    OLED_ShowString(0, 0, (u8 *)text, 16);
                    snprintf(text, sizeof(text), "RAW:%4u", (unsigned int)adc_raw);
                    OLED_ShowString(0, 16, (u8 *)text, 16);
                    snprintf(text, sizeof(text), "V:%u.%03uV", millivolts / 1000U,
                             millivolts % 1000U);
                    OLED_ShowString(0, 32, (u8 *)text, 16);
                    snprintf(text, sizeof(text), "SEQ:%3u", sequence);
                    OLED_ShowString(0, 48, (u8 *)text, 16);
                    oled_ready = (OLED_Refresh() == OLED_STATUS_OK);
                }
            }
        }
    }
}
