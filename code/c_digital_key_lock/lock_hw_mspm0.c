#include "lock_hw.h"

#include "lock_display_ui.h"
#include "lock_output_behavior.h"
#include "st7735s.h"
#include "ti_msp_dl_config.h"

#define RX_RING_SIZE 128U
#define RX_RING_MASK (RX_RING_SIZE - 1U)
#define HARDWARE_UWB_CHANNEL_COUNT 2U
#define MILLISECOND_CYCLES (CPUCLK_FREQ / 1000U)

static volatile uint8_t
    g_rx_ring[HARDWARE_UWB_CHANNEL_COUNT][RX_RING_SIZE];
static volatile uint8_t g_rx_head[HARDWARE_UWB_CHANNEL_COUNT];
static volatile uint8_t g_rx_tail[HARDWARE_UWB_CHANNEL_COUNT];
static volatile uint32_t g_millis;
static LockOutputSnapshot g_last_outputs;
static LockDisplayModel g_last_display;
static St7735s g_lcd;
static LockDisplayUi g_display_ui;
static LockOutputBehavior g_output_behavior;
static bool g_display_ready;

static void lcd_set_cs(void *context, bool high)
{
    (void)context;
    if (high) {
        DL_GPIO_setPins(LCD_CONTROL_PORT, LCD_CONTROL_LCD_CS_PIN);
    } else {
        DL_GPIO_clearPins(LCD_CONTROL_PORT, LCD_CONTROL_LCD_CS_PIN);
    }
}

static void lcd_set_dc(void *context, bool high)
{
    (void)context;
    if (high) {
        DL_GPIO_setPins(LCD_CONTROL_PORT, LCD_CONTROL_LCD_DC_PIN);
    } else {
        DL_GPIO_clearPins(LCD_CONTROL_PORT, LCD_CONTROL_LCD_DC_PIN);
    }
}

static void lcd_set_reset(void *context, bool high)
{
    (void)context;
    if (high) {
        DL_GPIO_setPins(LCD_CONTROL_PORT, LCD_CONTROL_LCD_RESET_PIN);
    } else {
        DL_GPIO_clearPins(LCD_CONTROL_PORT, LCD_CONTROL_LCD_RESET_PIN);
    }
}

static void lcd_write(void *context, const uint8_t *data, size_t length)
{
    size_t index;

    (void)context;
    for (index = 0U; index < length; index++) {
        while (DL_SPI_isTXFIFOFull(LCD_SPI_INST)) {
        }
        DL_SPI_transmitData8(LCD_SPI_INST, data[index]);
    }
    while (DL_SPI_isBusy(LCD_SPI_INST)) {
    }
}

static void lcd_delay_ms(void *context, uint32_t milliseconds)
{
    (void)context;
    while (milliseconds > 0U) {
        delay_cycles(MILLISECOND_CYCLES);
        milliseconds--;
    }
}

static void write_output_pin(uint32_t pin, bool enabled)
{
    if (enabled) {
        DL_GPIO_setPins(LOCK_OUTPUTS_PORT, pin);
    } else {
        DL_GPIO_clearPins(LOCK_OUTPUTS_PORT, pin);
    }
}

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
    St7735sBus lcd_bus;
    uint8_t channel;

    for (channel = 0U; channel < HARDWARE_UWB_CHANNEL_COUNT; channel++) {
        g_rx_head[channel] = 0U;
        g_rx_tail[channel] = 0U;
    }
    g_millis = 0U;
    g_last_outputs = (LockOutputSnapshot){0};
    g_last_display = (LockDisplayModel){0};
    g_display_ready = false;
    lock_output_behavior_init(&g_output_behavior);
    DL_GPIO_clearPins(
        LOCK_OUTPUTS_PORT,
        LOCK_OUTPUTS_RED_LED_PIN |
            LOCK_OUTPUTS_GREEN_LED_PIN |
            LOCK_OUTPUTS_BUZZER_PIN |
            LOCK_OUTPUTS_LOCK_RELAY_PIN);

    (void)SysTick_Config(CPUCLK_FREQ / 1000U);
    NVIC_ClearPendingIRQ(UWB_CH1_INST_INT_IRQN);
    NVIC_ClearPendingIRQ(UWB_CH2_INST_INT_IRQN);
    NVIC_EnableIRQ(UWB_CH1_INST_INT_IRQN);
    NVIC_EnableIRQ(UWB_CH2_INST_INT_IRQN);

    lcd_bus.context = NULL;
    lcd_bus.set_cs = lcd_set_cs;
    lcd_bus.set_dc = lcd_set_dc;
    lcd_bus.set_reset = lcd_set_reset;
    lcd_bus.write = lcd_write;
    lcd_bus.delay_ms = lcd_delay_ms;
    g_display_ready = st7735s_init(&g_lcd, &lcd_bus);
    lock_display_ui_init(&g_display_ui,
                         g_display_ready ? &g_lcd : NULL);
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
    uint32_t pins = DL_GPIO_readPins(
        SET_ID_INPUTS_PORT,
        SET_ID_INPUTS_SET_ID_BIT0_PIN |
            SET_ID_INPUTS_SET_ID_BIT1_PIN |
            SET_ID_INPUTS_SET_ID_BIT2_PIN |
            SET_ID_INPUTS_SET_ID_BIT3_PIN);
    uint8_t value = 0U;

    if ((pins & SET_ID_INPUTS_SET_ID_BIT0_PIN) == 0U) {
        value |= 0x01U;
    }
    if ((pins & SET_ID_INPUTS_SET_ID_BIT1_PIN) == 0U) {
        value |= 0x02U;
    }
    if ((pins & SET_ID_INPUTS_SET_ID_BIT2_PIN) == 0U) {
        value |= 0x04U;
    }
    if ((pins & SET_ID_INPUTS_SET_ID_BIT3_PIN) == 0U) {
        value |= 0x08U;
    }
    return value;
}

void lock_hw_apply_outputs(const LockOutputSnapshot *outputs)
{
    LockPhysicalOutputs physical;

    if (outputs != NULL) {
        g_last_outputs = *outputs;
        physical = lock_output_behavior_update(
            &g_output_behavior, outputs, g_millis);
        write_output_pin(LOCK_OUTPUTS_RED_LED_PIN, physical.red_on);
        write_output_pin(LOCK_OUTPUTS_GREEN_LED_PIN, physical.green_on);
        write_output_pin(LOCK_OUTPUTS_BUZZER_PIN, physical.buzzer_on);
        write_output_pin(
            LOCK_OUTPUTS_LOCK_RELAY_PIN, physical.lock_on);
    }
}

void lock_hw_present_display(const LockDisplayModel *display)
{
    if (display != NULL) {
        g_last_display = *display;
        if (g_display_ready) {
            lock_display_ui_render(&g_display_ui, display);
        }
    }
}

void lock_hw_show_display_test_pattern(void)
{
    if (g_display_ready) {
        lock_display_ui_show_color_test(&g_display_ui);
    }
}

void lock_hw_idle(void)
{
    __WFE();
}
