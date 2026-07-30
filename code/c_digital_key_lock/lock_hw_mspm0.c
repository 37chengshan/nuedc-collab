#include "lock_hw.h"

#include "ti_msp_dl_config.h"

#define RX_RING_SIZE 128U
#define RX_RING_MASK (RX_RING_SIZE - 1U)

static volatile uint8_t g_rx_ring[RX_RING_SIZE];
static volatile uint8_t g_rx_head;
static volatile uint8_t g_rx_tail;
static volatile uint32_t g_millis;
static LockOutputSnapshot g_last_outputs;
static LockDisplayModel g_last_display;

void SysTick_Handler(void)
{
    g_millis++;
}

void UWB_SMOKE_INST_IRQHandler(void)
{
    if (DL_UART_Main_getPendingInterrupt(UWB_SMOKE_INST) ==
        DL_UART_MAIN_IIDX_RX) {
        while (!DL_UART_Main_isRXFIFOEmpty(UWB_SMOKE_INST)) {
            uint8_t byte = (uint8_t)DL_UART_Main_receiveData(UWB_SMOKE_INST);
            uint8_t next = (uint8_t)((g_rx_head + 1U) & RX_RING_MASK);

            if (next != g_rx_tail) {
                g_rx_ring[g_rx_head] = byte;
                g_rx_head = next;
            }
        }
    }
}

void lock_hw_init(void)
{
    g_rx_head = 0U;
    g_rx_tail = 0U;
    g_millis = 0U;
    g_last_outputs = (LockOutputSnapshot){0};
    g_last_display = (LockDisplayModel){0};

    (void)SysTick_Config(CPUCLK_FREQ / 1000U);
    NVIC_ClearPendingIRQ(UWB_SMOKE_INST_INT_IRQN);
    NVIC_EnableIRQ(UWB_SMOKE_INST_INT_IRQN);
}

uint32_t lock_hw_millis(void)
{
    return g_millis;
}

bool lock_hw_uart_channel_read_byte(uint8_t channel, uint8_t *byte)
{
    if ((channel != 0U) || (g_rx_tail == g_rx_head)) {
        return false;
    }

    *byte = g_rx_ring[g_rx_tail];
    g_rx_tail = (uint8_t)((g_rx_tail + 1U) & RX_RING_MASK);
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
