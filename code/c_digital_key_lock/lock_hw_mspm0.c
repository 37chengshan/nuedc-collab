#include "lock_hw.h"

#include "ti_msp_dl_config.h"

#define RX_RING_SIZE 128U
#define RX_RING_MASK (RX_RING_SIZE - 1U)
#define HARDWARE_UWB_CHANNEL_COUNT 2U

static volatile uint8_t
    g_rx_ring[HARDWARE_UWB_CHANNEL_COUNT][RX_RING_SIZE];
static volatile uint8_t g_rx_head[HARDWARE_UWB_CHANNEL_COUNT];
static volatile uint8_t g_rx_tail[HARDWARE_UWB_CHANNEL_COUNT];
static volatile uint32_t g_millis;
static LockOutputSnapshot g_last_outputs;
static LockDisplayModel g_last_display;

void SysTick_Handler(void)
{
    g_millis++;
}

static void capture_uart(uint8_t channel, UART_Regs *instance)
{
    if (DL_UART_Main_getPendingInterrupt(instance) ==
        DL_UART_MAIN_IIDX_RX) {
        while (!DL_UART_Main_isRXFIFOEmpty(instance)) {
            uint8_t byte = (uint8_t)DL_UART_Main_receiveData(instance);
            uint8_t next =
                (uint8_t)((g_rx_head[channel] + 1U) & RX_RING_MASK);

            if (next != g_rx_tail[channel]) {
                g_rx_ring[channel][g_rx_head[channel]] = byte;
                g_rx_head[channel] = next;
            }
        }
    }
}

void UWB_CH1_INST_IRQHandler(void)
{
    capture_uart(0U, UWB_CH1_INST);
}

void UWB_CH2_INST_IRQHandler(void)
{
    capture_uart(1U, UWB_CH2_INST);
}

void lock_hw_init(void)
{
    uint8_t channel;

    for (channel = 0U; channel < HARDWARE_UWB_CHANNEL_COUNT; channel++) {
        g_rx_head[channel] = 0U;
        g_rx_tail[channel] = 0U;
    }
    g_millis = 0U;
    g_last_outputs = (LockOutputSnapshot){0};
    g_last_display = (LockDisplayModel){0};

    (void)SysTick_Config(CPUCLK_FREQ / 1000U);
    NVIC_ClearPendingIRQ(UWB_CH1_INST_INT_IRQN);
    NVIC_ClearPendingIRQ(UWB_CH2_INST_INT_IRQN);
    NVIC_EnableIRQ(UWB_CH1_INST_INT_IRQN);
    NVIC_EnableIRQ(UWB_CH2_INST_INT_IRQN);
}

uint32_t lock_hw_millis(void)
{
    return g_millis;
}

bool lock_hw_uart_channel_read_byte(uint8_t channel, uint8_t *byte)
{
    if ((channel >= HARDWARE_UWB_CHANNEL_COUNT) || (byte == NULL) ||
        (g_rx_tail[channel] == g_rx_head[channel])) {
        return false;
    }

    *byte = g_rx_ring[channel][g_rx_tail[channel]];
    g_rx_tail[channel] =
        (uint8_t)((g_rx_tail[channel] + 1U) & RX_RING_MASK);
    return true;
}

uint8_t lock_hw_read_id_inputs_low_active(void)
{
    return 0U;
}

void lock_hw_apply_outputs(const LockOutputSnapshot *outputs)
{
    g_last_outputs = *outputs;
}

void lock_hw_present_display(const LockDisplayModel *display)
{
    g_last_display = *display;
}

void lock_hw_idle(void)
{
    __WFE();
}
