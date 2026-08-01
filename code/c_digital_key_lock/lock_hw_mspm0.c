#include "lock_hw.h"

#include "st7735.h"
#include "ti_msp_dl_config.h"

#define RX_RING_SIZE 512U
#define RX_RING_MASK (RX_RING_SIZE - 1U)
#define WELCOME_BEEP_MS 80U
#define UNLOCK_BEEP_MS 150U
#define DENIED_BEEP_MS 100U

static volatile uint8_t
    g_rx_ring[LOCK_UWB_CHANNEL_COUNT][RX_RING_SIZE];
static volatile uint16_t g_rx_head[LOCK_UWB_CHANNEL_COUNT];
static volatile uint16_t g_rx_tail[LOCK_UWB_CHANNEL_COUNT];
static volatile bool g_rx_overflow[LOCK_UWB_CHANNEL_COUNT];
static volatile uint32_t g_millis;
static LockOutputSnapshot g_last_outputs;
static LockDisplayModel g_last_display;
static LockState g_last_state;
static uint32_t g_buzzer_until_ms;
static bool g_display_presented;

void SysTick_Handler(void)
{
    g_millis++;
}

static void lock_hw_uart_rx_irq(uint8_t channel, UART_Regs *uart)
{
    if (DL_UART_Main_getPendingInterrupt(uart) ==
        DL_UART_MAIN_IIDX_RX) {
        while (!DL_UART_Main_isRXFIFOEmpty(uart)) {
            uint8_t byte = (uint8_t)DL_UART_Main_receiveData(uart);
            uint16_t next =
                (uint16_t)((g_rx_head[channel] + 1U) & RX_RING_MASK);

            if (next != g_rx_tail[channel]) {
                g_rx_ring[channel][g_rx_head[channel]] = byte;
                g_rx_head[channel] = next;
            } else {
                g_rx_overflow[channel] = true;
            }
        }
    }
}

void UWB_RIGHT_INST_IRQHandler(void)
{
    lock_hw_uart_rx_irq(0U, UWB_RIGHT_INST);
}

void UWB_LEFT_INST_IRQHandler(void)
{
    lock_hw_uart_rx_irq(1U, UWB_LEFT_INST);
}

static void lock_hw_drain_uart(UART_Regs *uart)
{
    while (!DL_UART_Main_isRXFIFOEmpty(uart)) {
        (void)DL_UART_Main_receiveData(uart);
    }
}

static bool lock_hw_time_before(uint32_t now_ms, uint32_t deadline_ms)
{
    return ((int32_t)(deadline_ms - now_ms) > 0);
}

void lock_hw_init(void)
{
    uint8_t channel;

    for (channel = 0U; channel < LOCK_UWB_CHANNEL_COUNT; channel++) {
        g_rx_head[channel] = 0U;
        g_rx_tail[channel] = 0U;
        g_rx_overflow[channel] = false;
    }
    g_millis = 0U;
    g_last_outputs = (LockOutputSnapshot){0};
    g_last_outputs.state = LOCK_STATE_LOCKED;
    g_last_display = (LockDisplayModel){0};
    g_last_state = LOCK_STATE_LOCKED;
    g_buzzer_until_ms = 0U;
    g_display_presented = false;

    (void)SysTick_Config(CPUCLK_FREQ / 1000U);

    DL_GPIO_clearPins(
        LOCK_OUTPUTS_A_PORT,
        LOCK_OUTPUTS_A_RED_LED_PIN |
        LOCK_OUTPUTS_A_GREEN_LED_PIN |
            LOCK_OUTPUTS_A_WELCOME_LED_PIN);
    /*
     * The installed active buzzer board is low-level active. Keep PA12
     * high from the first application instruction so idle/boot is quiet.
     */
    DL_GPIO_setPins(
        LOCK_OUTPUTS_A_PORT, LOCK_OUTPUTS_A_BUZZER_PIN);
    DL_GPIO_clearPins(
        LOCK_OUTPUTS_B_PORT, LOCK_OUTPUTS_B_LOCK_DRIVE_PIN);

    st7735_init();

    lock_hw_drain_uart(UWB_RIGHT_INST);
    lock_hw_drain_uart(UWB_LEFT_INST);
    NVIC_ClearPendingIRQ(UWB_RIGHT_INST_INT_IRQN);
    NVIC_ClearPendingIRQ(UWB_LEFT_INST_INT_IRQN);
    NVIC_EnableIRQ(UWB_RIGHT_INST_INT_IRQN);
    NVIC_EnableIRQ(UWB_LEFT_INST_INT_IRQN);
}

uint32_t lock_hw_millis(void)
{
    return g_millis;
}

bool lock_hw_uart_channel_read_byte(uint8_t channel, uint8_t *byte)
{
    if ((byte == NULL) || (channel >= LOCK_UWB_CHANNEL_COUNT) ||
        (g_rx_tail[channel] == g_rx_head[channel])) {
        return false;
    }

    *byte = g_rx_ring[channel][g_rx_tail[channel]];
    g_rx_tail[channel] =
        (uint16_t)((g_rx_tail[channel] + 1U) & RX_RING_MASK);
    return true;
}

bool lock_hw_uart_channel_take_overflow(uint8_t channel)
{
    bool overflowed;
    uint32_t primask;

    if (channel >= LOCK_UWB_CHANNEL_COUNT) {
        return false;
    }

    primask = __get_PRIMASK();
    __disable_irq();
    overflowed = g_rx_overflow[channel];
    g_rx_overflow[channel] = false;
    if (primask == 0U) {
        __enable_irq();
    }
    return overflowed;
}

uint8_t lock_hw_read_id_inputs_low_active(void)
{
    uint32_t pins = DL_GPIO_readPins(
        DIP_SWITCHES_PORT,
        DIP_SWITCHES_BIT0_PIN |
            DIP_SWITCHES_BIT1_PIN |
            DIP_SWITCHES_BIT2_PIN |
            DIP_SWITCHES_BIT3_PIN);
    uint8_t logical_value = 0U;

    if ((pins & DIP_SWITCHES_BIT0_PIN) == 0U) {
        logical_value |= 0x01U;
    }
    if ((pins & DIP_SWITCHES_BIT1_PIN) == 0U) {
        logical_value |= 0x02U;
    }
    if ((pins & DIP_SWITCHES_BIT2_PIN) == 0U) {
        logical_value |= 0x04U;
    }
    if ((pins & DIP_SWITCHES_BIT3_PIN) == 0U) {
        logical_value |= 0x08U;
    }
    return logical_value;
}

void lock_hw_apply_outputs(const LockOutputSnapshot *outputs)
{
    uint32_t now_ms;
    uint32_t set_a = 0U;
    uint32_t clear_a = 0U;
    bool buzzer_on;

    if (outputs == NULL) {
        return;
    }

    now_ms = g_millis;
    if (outputs->state != g_last_state) {
        if (outputs->state == LOCK_STATE_WELCOME) {
            g_buzzer_until_ms = now_ms + WELCOME_BEEP_MS;
        } else if (outputs->state == LOCK_STATE_UNLOCKED) {
            g_buzzer_until_ms = now_ms + UNLOCK_BEEP_MS;
        } else if (outputs->state == LOCK_STATE_DENIED) {
            g_buzzer_until_ms = now_ms + DENIED_BEEP_MS;
        }
        g_last_state = outputs->state;
    }

    if (outputs->red_led) {
        set_a |= LOCK_OUTPUTS_A_RED_LED_PIN;
    } else {
        clear_a |= LOCK_OUTPUTS_A_RED_LED_PIN;
    }
    if (outputs->green_led) {
        set_a |= LOCK_OUTPUTS_A_GREEN_LED_PIN;
    } else {
        clear_a |= LOCK_OUTPUTS_A_GREEN_LED_PIN;
    }
    if (outputs->welcome_output) {
        set_a |= LOCK_OUTPUTS_A_WELCOME_LED_PIN;
    } else {
        clear_a |= LOCK_OUTPUTS_A_WELCOME_LED_PIN;
    }

    buzzer_on =
        outputs->buzzer_alarm ||
        lock_hw_time_before(now_ms, g_buzzer_until_ms);
    if (buzzer_on) {
        clear_a |= LOCK_OUTPUTS_A_BUZZER_PIN;
    } else {
        set_a |= LOCK_OUTPUTS_A_BUZZER_PIN;
    }

    if (clear_a != 0U) {
        DL_GPIO_clearPins(LOCK_OUTPUTS_A_PORT, clear_a);
    }
    if (set_a != 0U) {
        DL_GPIO_setPins(LOCK_OUTPUTS_A_PORT, set_a);
    }

    if (outputs->unlock_output) {
        DL_GPIO_setPins(
            LOCK_OUTPUTS_B_PORT, LOCK_OUTPUTS_B_LOCK_DRIVE_PIN);
    } else {
        DL_GPIO_clearPins(
            LOCK_OUTPUTS_B_PORT, LOCK_OUTPUTS_B_LOCK_DRIVE_PIN);
    }

    g_last_outputs = *outputs;
}

void lock_hw_present_display(const LockDisplayModel *display)
{
    if (display == NULL) {
        return;
    }
    if (g_display_presented &&
        (display->now_ms == g_last_display.now_ms)) {
        return;
    }

    st7735_present(display);
    g_last_display = *display;
    g_display_presented = true;
}

void lock_hw_idle(void)
{
    __WFE();
}
