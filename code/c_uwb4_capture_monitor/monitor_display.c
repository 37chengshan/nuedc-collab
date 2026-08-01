/*
 * Copyright (c) 2013-2026, Texas Instruments Incorporated
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 *
 * * Redistributions of source code must retain the above copyright
 *   notice, this list of conditions and the following disclaimer.
 * * Redistributions in binary form must reproduce the above copyright
 *   notice, this list of conditions and the following disclaimer in the
 *   documentation and/or other materials provided with the distribution.
 * * Neither the name of Texas Instruments Incorporated nor the names of
 *   its contributors may be used to endorse or promote products derived
 *   from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

#include "monitor_display.h"
#include "ti_msp_dl_config.h"

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define ST7735_WIDTH 128U
#define ST7735_HEIGHT 160U
#define ST7735_X_OFFSET 2U
#define ST7735_Y_OFFSET 1U
#define ST7735_TEXT_SCALE 2U
#define ST7735_CELL_WIDTH 12U
#define ST7735_CELL_HEIGHT 16U
#define ST7735_TEXT_X 4U
#define MONITOR_LINE_COUNT 10U
#define MONITOR_LINE_CAPACITY 11U

#define ST7735_SWRESET 0x01U
#define ST7735_SLPOUT 0x11U
#define ST7735_NORON 0x13U
#define ST7735_DISPON 0x29U
#define ST7735_CASET 0x2AU
#define ST7735_RASET 0x2BU
#define ST7735_RAMWR 0x2CU
#define ST7735_MADCTL 0x36U
#define ST7735_COLMOD 0x3AU
#define ST7735_FRMCTR1 0xB1U
#define ST7735_FRMCTR2 0xB2U
#define ST7735_FRMCTR3 0xB3U
#define ST7735_INVCTR 0xB4U
#define ST7735_PWCTR1 0xC0U
#define ST7735_PWCTR2 0xC1U
#define ST7735_PWCTR3 0xC2U
#define ST7735_PWCTR4 0xC3U
#define ST7735_PWCTR5 0xC4U
#define ST7735_VMCTR1 0xC5U
#define ST7735_GMCTRP1 0xE0U
#define ST7735_GMCTRN1 0xE1U

#define COLOR_BLACK 0x0000U
#define COLOR_WHITE 0xFFFFU
#define COLOR_RED 0xF800U
#define COLOR_GREEN 0x07E0U
#define COLOR_YELLOW 0xFFE0U
#define COLOR_CYAN 0x07FFU
#define COLOR_MAGENTA 0xF81FU
#define COLOR_GRAY 0x8410U

/*
 * Simple 5x7 ASCII font, characters 32 through 90. The bitmap data is
 * adapted from TI's ST7735 example driver
 * BOOSTXL-EDUMKII/cfaf128128b_lcd.c under the license above.
 */
static const uint8_t g_font5x7[][5] = {
    {0x00, 0x00, 0x00, 0x00, 0x00},
    {0x00, 0x00, 0x5F, 0x00, 0x00},
    {0x00, 0x07, 0x00, 0x07, 0x00},
    {0x14, 0x7F, 0x14, 0x7F, 0x14},
    {0x24, 0x2A, 0x7F, 0x2A, 0x12},
    {0x23, 0x13, 0x08, 0x64, 0x62},
    {0x36, 0x49, 0x55, 0x22, 0x50},
    {0x00, 0x05, 0x03, 0x00, 0x00},
    {0x00, 0x1C, 0x22, 0x41, 0x00},
    {0x00, 0x41, 0x22, 0x1C, 0x00},
    {0x14, 0x08, 0x3E, 0x08, 0x14},
    {0x08, 0x08, 0x3E, 0x08, 0x08},
    {0x00, 0x50, 0x30, 0x00, 0x00},
    {0x08, 0x08, 0x08, 0x08, 0x08},
    {0x00, 0x60, 0x60, 0x00, 0x00},
    {0x20, 0x10, 0x08, 0x04, 0x02},
    {0x3E, 0x51, 0x49, 0x45, 0x3E},
    {0x00, 0x42, 0x7F, 0x40, 0x00},
    {0x42, 0x61, 0x51, 0x49, 0x46},
    {0x21, 0x41, 0x45, 0x4B, 0x31},
    {0x18, 0x14, 0x12, 0x7F, 0x10},
    {0x27, 0x45, 0x45, 0x45, 0x39},
    {0x3C, 0x4A, 0x49, 0x49, 0x30},
    {0x01, 0x71, 0x09, 0x05, 0x03},
    {0x36, 0x49, 0x49, 0x49, 0x36},
    {0x06, 0x49, 0x49, 0x29, 0x1E},
    {0x00, 0x36, 0x36, 0x00, 0x00},
    {0x00, 0x56, 0x36, 0x00, 0x00},
    {0x08, 0x14, 0x22, 0x41, 0x00},
    {0x14, 0x14, 0x14, 0x14, 0x14},
    {0x00, 0x41, 0x22, 0x14, 0x08},
    {0x02, 0x01, 0x51, 0x09, 0x06},
    {0x32, 0x49, 0x79, 0x41, 0x3E},
    {0x7E, 0x11, 0x11, 0x11, 0x7E},
    {0x7F, 0x49, 0x49, 0x49, 0x36},
    {0x3E, 0x41, 0x41, 0x41, 0x22},
    {0x7F, 0x41, 0x41, 0x22, 0x1C},
    {0x7F, 0x49, 0x49, 0x49, 0x41},
    {0x7F, 0x09, 0x09, 0x09, 0x01},
    {0x3E, 0x41, 0x49, 0x49, 0x7A},
    {0x7F, 0x08, 0x08, 0x08, 0x7F},
    {0x00, 0x41, 0x7F, 0x41, 0x00},
    {0x20, 0x40, 0x41, 0x3F, 0x01},
    {0x7F, 0x08, 0x14, 0x22, 0x41},
    {0x7F, 0x40, 0x40, 0x40, 0x40},
    {0x7F, 0x02, 0x0C, 0x02, 0x7F},
    {0x7F, 0x04, 0x08, 0x10, 0x7F},
    {0x3E, 0x41, 0x41, 0x41, 0x3E},
    {0x7F, 0x09, 0x09, 0x09, 0x06},
    {0x3E, 0x41, 0x51, 0x21, 0x5E},
    {0x7F, 0x09, 0x19, 0x29, 0x46},
    {0x46, 0x49, 0x49, 0x49, 0x31},
    {0x01, 0x01, 0x7F, 0x01, 0x01},
    {0x3F, 0x40, 0x40, 0x40, 0x3F},
    {0x1F, 0x20, 0x40, 0x20, 0x1F},
    {0x3F, 0x40, 0x38, 0x40, 0x3F},
    {0x63, 0x14, 0x08, 0x14, 0x63},
    {0x07, 0x08, 0x70, 0x08, 0x07},
    {0x61, 0x51, 0x49, 0x45, 0x43},
};

typedef struct {
    char lines[MONITOR_LINE_COUNT][MONITOR_LINE_CAPACITY];
} MonitorText;

static MonitorText g_previous_text;
static bool g_have_previous_text;

static void lcd_delay_ms(uint32_t milliseconds)
{
    while (milliseconds-- > 0U) {
        delay_cycles(CPUCLK_FREQ / 1000U);
    }
}

static void lcd_set_dc(bool data_mode)
{
    if (data_mode) {
        DL_GPIO_setPins(
            LCD_CONTROL_PORT, LCD_CONTROL_DC_PIN);
    } else {
        DL_GPIO_clearPins(
            LCD_CONTROL_PORT, LCD_CONTROL_DC_PIN);
    }
}

static void lcd_spi_write(uint8_t value)
{
    DL_SPI_transmitDataBlocking8(LCD_SPI_INST, value);
}

static void lcd_write_command(uint8_t command)
{
    lcd_set_dc(false);
    lcd_spi_write(command);
}

static void lcd_write_data(const uint8_t *data, uint8_t length)
{
    uint8_t index;

    lcd_set_dc(true);
    for (index = 0U; index < length; index++) {
        lcd_spi_write(data[index]);
    }
}

static void lcd_write_command_data(uint8_t command, const uint8_t *data,
                                   uint8_t length)
{
    lcd_write_command(command);
    if ((data != NULL) && (length > 0U)) {
        lcd_write_data(data, length);
    }
}

static void lcd_reset(void)
{
    DL_GPIO_clearPins(
        LCD_CONTROL_PORT, LCD_CONTROL_RESET_PIN);
    lcd_delay_ms(100U);
    DL_GPIO_setPins(
        LCD_CONTROL_PORT, LCD_CONTROL_RESET_PIN);
    lcd_delay_ms(50U);
}

static void lcd_set_address_window(uint8_t x0, uint8_t y0, uint8_t x1,
                                   uint8_t y1)
{
    uint16_t start;
    uint16_t end;
    uint8_t address[4];

    start = (uint16_t)x0 + ST7735_X_OFFSET;
    end = (uint16_t)x1 + ST7735_X_OFFSET;
    address[0] = (uint8_t)(start >> 8);
    address[1] = (uint8_t)start;
    address[2] = (uint8_t)(end >> 8);
    address[3] = (uint8_t)end;
    lcd_write_command_data(ST7735_CASET, address, sizeof(address));

    start = (uint16_t)y0 + ST7735_Y_OFFSET;
    end = (uint16_t)y1 + ST7735_Y_OFFSET;
    address[0] = (uint8_t)(start >> 8);
    address[1] = (uint8_t)start;
    address[2] = (uint8_t)(end >> 8);
    address[3] = (uint8_t)end;
    lcd_write_command_data(ST7735_RASET, address, sizeof(address));

    lcd_write_command(ST7735_RAMWR);
    lcd_set_dc(true);
}

static void lcd_write_color(uint16_t color)
{
    lcd_spi_write((uint8_t)(color >> 8));
    lcd_spi_write((uint8_t)color);
}

static void lcd_fill_rect(uint8_t x, uint8_t y, uint8_t width,
                          uint8_t height, uint16_t color)
{
    uint16_t x_end;
    uint16_t y_end;
    uint32_t pixel_count;

    if ((width == 0U) || (height == 0U) ||
        (x >= ST7735_WIDTH) || (y >= ST7735_HEIGHT)) {
        return;
    }

    x_end = (uint16_t)x + width - 1U;
    y_end = (uint16_t)y + height - 1U;
    if (x_end >= ST7735_WIDTH) {
        x_end = ST7735_WIDTH - 1U;
    }
    if (y_end >= ST7735_HEIGHT) {
        y_end = ST7735_HEIGHT - 1U;
    }

    lcd_set_address_window(
        x, y, (uint8_t)x_end, (uint8_t)y_end);
    pixel_count =
        ((uint32_t)x_end - x + 1U) * ((uint32_t)y_end - y + 1U);
    while (pixel_count-- > 0U) {
        lcd_write_color(color);
    }
}

static const uint8_t *lcd_glyph(char character)
{
    if ((character < ' ') || (character > 'Z')) {
        character = '?';
    }
    return g_font5x7[(uint8_t)character - (uint8_t)' '];
}

static void lcd_draw_character(uint8_t x, uint8_t y, char character,
                               uint16_t foreground,
                               uint16_t background)
{
    const uint8_t *glyph = lcd_glyph(character);
    uint8_t output_y;

    lcd_set_address_window(
        x, y, (uint8_t)(x + ST7735_CELL_WIDTH - 1U),
        (uint8_t)(y + ST7735_CELL_HEIGHT - 1U));

    for (output_y = 0U; output_y < ST7735_CELL_HEIGHT; output_y++) {
        uint8_t output_x;
        uint8_t source_y = output_y / ST7735_TEXT_SCALE;

        for (output_x = 0U; output_x < ST7735_CELL_WIDTH;
             output_x++) {
            uint8_t source_x = output_x / ST7735_TEXT_SCALE;
            bool set = (source_x < 5U) && (source_y < 7U) &&
                       ((glyph[source_x] &
                         (uint8_t)(1U << source_y)) != 0U);

            lcd_write_color(set ? foreground : background);
        }
    }
}

static void lcd_draw_line(uint8_t row, const char *line,
                          uint16_t foreground)
{
    uint8_t column;
    size_t length = 0U;
    uint8_t y = (uint8_t)(row * ST7735_CELL_HEIGHT);

    while ((length < (MONITOR_LINE_CAPACITY - 1U)) &&
           (line[length] != '\0')) {
        length++;
    }

    for (column = 0U; column < (MONITOR_LINE_CAPACITY - 1U);
         column++) {
        char character =
            (column < length) ? line[column] : ' ';
        lcd_draw_character(
            (uint8_t)(ST7735_TEXT_X +
                      (column * ST7735_CELL_WIDTH)),
            y, character, foreground, COLOR_BLACK);
    }
}

static uint16_t status_color(UwbMonitorStatus status)
{
    switch (status) {
    case UWB_MONITOR_OK:
        return COLOR_GREEN;
    case UWB_MONITOR_RX:
        return COLOR_YELLOW;
    case UWB_MONITOR_LOST:
        return COLOR_RED;
    case UWB_MONITOR_WAIT:
    default:
        return COLOR_GRAY;
    }
}

static void text_append_char(char *line, uint8_t *length, char value)
{
    if (*length < (MONITOR_LINE_CAPACITY - 1U)) {
        line[*length] = value;
        (*length)++;
        line[*length] = '\0';
    }
}

static void text_append(char *line, uint8_t *length, const char *value)
{
    while (*value != '\0') {
        text_append_char(line, length, *value++);
    }
}

static void text_append_u32(char *line, uint8_t *length, uint32_t value)
{
    char reversed[10];
    uint8_t count = 0U;

    do {
        reversed[count++] = (char)('0' + (value % 10U));
        value /= 10U;
    } while ((value != 0U) && (count < sizeof(reversed)));

    while (count > 0U) {
        text_append_char(line, length, reversed[--count]);
    }
}

static const char *status_text(UwbMonitorStatus status)
{
    switch (status) {
    case UWB_MONITOR_OK:
        return "OK";
    case UWB_MONITOR_RX:
        return "RX";
    case UWB_MONITOR_LOST:
        return "LOST";
    case UWB_MONITOR_WAIT:
    default:
        return "WAIT";
    }
}

static void format_monitor_text(const UwbMonitorSnapshot *snapshot,
                                MonitorText *text)
{
    uint8_t channel;

    memset(text, 0, sizeof(*text));
    memcpy(text->lines[0], "UWB4 MON", 9U);

    for (channel = 0U; channel < UWB_MONITOR_CHANNEL_COUNT; channel++) {
        uint8_t status_row = (uint8_t)(1U + channel * 2U);
        uint8_t count_row = (uint8_t)(status_row + 1U);
        uint8_t length = 0U;

        text_append(text->lines[status_row], &length, "U");
        text_append_char(
            text->lines[status_row], &length, (char)('1' + channel));
        text_append(text->lines[status_row], &length, " ");
        text_append(
            text->lines[status_row], &length,
            status_text(snapshot->status[channel]));

        length = 0U;
        text_append(text->lines[count_row], &length, "D ");
        if (snapshot->distance_valid[channel]) {
            uint32_t distance = snapshot->distance_mm[channel];

            if (distance > 9999U) {
                distance = 9999U;
            }
            text_append_u32(text->lines[count_row], &length, distance);
            text_append(text->lines[count_row], &length, "MM");
        } else {
            text_append(text->lines[count_row], &length, "----");
        }
    }

    memcpy(text->lines[9], "115200 8N1", 10U);
}

void monitor_display_init(void)
{
    static const uint8_t frame_rate[] = {0x01U, 0x2CU, 0x2DU};
    static const uint8_t frame_rate_partial[] = {
        0x01U, 0x2CU, 0x2DU, 0x01U, 0x2CU, 0x2DU};
    static const uint8_t power1[] = {0xA2U, 0x02U, 0x84U};
    static const uint8_t power3[] = {0x0AU, 0x00U};
    static const uint8_t power4[] = {0x8AU, 0x2AU};
    static const uint8_t power5[] = {0x8AU, 0xEEU};
    static const uint8_t gamma_positive[] = {
        0x0FU, 0x1AU, 0x0FU, 0x18U, 0x2FU, 0x28U, 0x20U, 0x22U,
        0x1FU, 0x1BU, 0x23U, 0x37U, 0x00U, 0x07U, 0x02U, 0x10U};
    static const uint8_t gamma_negative[] = {
        0x0FU, 0x1BU, 0x0FU, 0x17U, 0x33U, 0x2CU, 0x29U, 0x2EU,
        0x30U, 0x30U, 0x39U, 0x3FU, 0x00U, 0x07U, 0x03U, 0x10U};
    static const uint8_t one = 0x01U;
    static const uint8_t zero = 0x00U;
    static const uint8_t inversion = 0x07U;
    static const uint8_t power2 = 0xC5U;
    static const uint8_t vcom = 0x0EU;
    static const uint8_t madctl = 0xC0U;
    static const uint8_t color_mode = 0x05U;

    lcd_reset();
    lcd_write_command(ST7735_SWRESET);
    lcd_delay_ms(150U);
    lcd_write_command(ST7735_SLPOUT);
    lcd_delay_ms(120U);

    lcd_write_command_data(
        ST7735_FRMCTR1, frame_rate, sizeof(frame_rate));
    lcd_write_command_data(
        ST7735_FRMCTR2, frame_rate, sizeof(frame_rate));
    lcd_write_command_data(
        ST7735_FRMCTR3, frame_rate_partial,
        sizeof(frame_rate_partial));
    lcd_write_command_data(ST7735_INVCTR, &inversion, 1U);
    lcd_write_command_data(ST7735_PWCTR1, power1, sizeof(power1));
    lcd_write_command_data(ST7735_PWCTR2, &power2, 1U);
    lcd_write_command_data(ST7735_PWCTR3, power3, sizeof(power3));
    lcd_write_command_data(ST7735_PWCTR4, power4, sizeof(power4));
    lcd_write_command_data(ST7735_PWCTR5, power5, sizeof(power5));
    lcd_write_command_data(ST7735_VMCTR1, &vcom, 1U);
    lcd_write_command_data(ST7735_MADCTL, &madctl, 1U);
    lcd_write_command_data(
        ST7735_GMCTRP1, gamma_positive, sizeof(gamma_positive));
    lcd_write_command_data(
        ST7735_GMCTRN1, gamma_negative, sizeof(gamma_negative));
    lcd_write_command_data(0xF0U, &one, 1U);
    lcd_write_command_data(0xF6U, &zero, 1U);
    lcd_write_command_data(ST7735_COLMOD, &color_mode, 1U);
    lcd_write_command(ST7735_NORON);
    lcd_delay_ms(10U);
    lcd_write_command(ST7735_DISPON);
    lcd_delay_ms(20U);

    lcd_fill_rect(
        0U, 0U, ST7735_WIDTH, ST7735_HEIGHT, COLOR_BLACK);
    memset(&g_previous_text, 0, sizeof(g_previous_text));
    g_have_previous_text = false;
}

void monitor_display_present(const UwbMonitorSnapshot *snapshot)
{
    MonitorText current;
    uint8_t row;

    if (snapshot == NULL) {
        return;
    }

    format_monitor_text(snapshot, &current);
    for (row = 0U; row < MONITOR_LINE_COUNT; row++) {
        if (!g_have_previous_text ||
            (strncmp(current.lines[row], g_previous_text.lines[row],
                     MONITOR_LINE_CAPACITY) != 0)) {
            uint16_t color =
                (row == 0U)
                    ? COLOR_WHITE
                    : ((row == 9U)
                           ? COLOR_CYAN
                           : (((row & 1U) != 0U)
                                  ? status_color(
                                        snapshot->status[(row - 1U) / 2U])
                                  : COLOR_WHITE));
            lcd_draw_line(
                row, current.lines[row], color);
        }
    }

    g_previous_text = current;
    g_have_previous_text = true;
}
