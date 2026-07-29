#include "ti_msp_dl_config.h"
#include "delay.h"
#include "oled.h"
#include "../link_protocol.h"
#include <stdbool.h>
#include <stdio.h>

#define ACK_POLL_WINDOWS 80U
#define ACK_POLL_INTERVAL_MS 5U

static volatile bool g_adc_ready;

void ADC_INPUT_INST_IRQHandler(void)
{
    if (DL_ADC12_getPendingInterrupt(ADC_INPUT_INST) ==
        DL_ADC12_IIDX_MEM0_RESULT_LOADED) {
        g_adc_ready = true;
    }
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

static bool wait_for_ack(LinkParser *parser, uint8_t sequence)
{
    uint8_t frame[LINK_FRAME_SIZE];
    uint8_t window;

    for (window = 0U; window < ACK_POLL_WINDOWS; window++) {
        while (!DL_UART_Main_isRXFIFOEmpty(LINK_INST)) {
            uint8_t byte = (uint8_t)DL_UART_Main_receiveData(LINK_INST);
            if (link_parser_push(parser, byte, frame) &&
                frame[3] == LINK_TYPE_ACK && frame[4] == sequence) {
                return true;
            }
        }
        delay_ms(ACK_POLL_INTERVAL_MS);
    }
    return false;
}

static uint8_t read_address(void)
{
    uint8_t address = 0U;
    uint32_t pins = DL_GPIO_readPins(ADDRESS_PORT,
        ADDRESS_BIT0_PIN | ADDRESS_BIT1_PIN |
        ADDRESS_BIT2_PIN | ADDRESS_BIT3_PIN);
    if ((pins & ADDRESS_BIT0_PIN) == 0U) address |= 0x01U;
    if ((pins & ADDRESS_BIT1_PIN) == 0U) address |= 0x02U;
    if ((pins & ADDRESS_BIT2_PIN) == 0U) address |= 0x04U;
    if ((pins & ADDRESS_BIT3_PIN) == 0U) address |= 0x08U;
    return address;
}

int main(void)
{
    char text[24];
    uint8_t tx_frame[LINK_FRAME_SIZE];
    uint8_t sequence = 0U;
    uint8_t address;
    uint8_t display_address = 0U;
    uint8_t display_sequence = 0U;
    uint16_t adc_raw;
    uint16_t millivolts;
    uint16_t display_adc_raw = 0U;
    uint16_t display_millivolts = 0U;
    bool link_ok;
    bool oled_ready;
    LinkParser parser = {{0U}, 0U};

    SYSCFG_DL_init();
    oled_ready = (OLED_Init() == OLED_STATUS_OK);
    g_adc_ready = false;
    NVIC_EnableIRQ(ADC_INPUT_INST_INT_IRQN);

    while (1) {
        DL_ADC12_startConversion(ADC_INPUT_INST);
        while (!g_adc_ready) __WFE();
        adc_raw = DL_ADC12_getMemResult(ADC_INPUT_INST, DL_ADC12_MEM_IDX_0);
        g_adc_ready = false;
        DL_ADC12_enableConversions(ADC_INPUT_INST);

        millivolts = (uint16_t)(((uint32_t)adc_raw * 3300U + 2047U) / 4095U);
        address = read_address();
        sequence++;
        link_build_frame(tx_frame, LINK_TYPE_DATA, sequence, address,
                         adc_raw, millivolts, 0U);
        uart_send_frame(tx_frame);
        link_ok = wait_for_ack(&parser, sequence);

        /* Only publish a frame after receiver 2 confirms the same sequence. */
        if (link_ok) {
            display_address = address;
            display_sequence = sequence;
            display_adc_raw = adc_raw;
            display_millivolts = millivolts;
        }

        if (oled_ready) {
            OLED_ClearBuffer();
            snprintf(text, sizeof(text), "ADDR:%02u LINK:%s", display_address,
                     link_ok ? "OK" : "--");
            OLED_ShowString(0, 0, (u8 *)text, 16);
            snprintf(text, sizeof(text), "RAW:%4u",
                     (unsigned int)display_adc_raw);
            OLED_ShowString(0, 16, (u8 *)text, 16);
            snprintf(text, sizeof(text), "V:%u.%03uV",
                     display_millivolts / 1000U,
                     display_millivolts % 1000U);
            OLED_ShowString(0, 32, (u8 *)text, 16);
            snprintf(text, sizeof(text), "SEQ:%3u", display_sequence);
            OLED_ShowString(0, 48, (u8 *)text, 16);
            oled_ready = (OLED_Refresh() == OLED_STATUS_OK);
        }
        delay_ms(200);
    }
}
