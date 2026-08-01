#include "st7735s.h"

#include <limits.h>
#include <string.h>

#define ST7735S_SWRESET 0x01U
#define ST7735S_SLPOUT 0x11U
#define ST7735S_NORON 0x13U
#define ST7735S_INVOFF 0x20U
#define ST7735S_DISPON 0x29U
#define ST7735S_CASET 0x2AU
#define ST7735S_RASET 0x2BU
#define ST7735S_RAMWR 0x2CU
#define ST7735S_MADCTL 0x36U
#define ST7735S_COLMOD 0x3AU
#define ST7735S_FRMCTR1 0xB1U
#define ST7735S_FRMCTR2 0xB2U
#define ST7735S_FRMCTR3 0xB3U
#define ST7735S_INVCTR 0xB4U
#define ST7735S_PWCTR1 0xC0U
#define ST7735S_PWCTR2 0xC1U
#define ST7735S_PWCTR3 0xC2U
#define ST7735S_PWCTR4 0xC3U
#define ST7735S_PWCTR5 0xC4U
#define ST7735S_VMCTR1 0xC5U
#define ST7735S_GMCTRP1 0xE0U
#define ST7735S_GMCTRN1 0xE1U

#define ST7735S_MADCTL_PORTRAIT_RGB 0xC0U
#define ST7735S_PIXEL_FORMAT_RGB565 0x05U
#define ST7735S_PIXEL_CHUNK_BYTES 128U
#define ST7735S_MAX_TEXT_SCALE 2U
#define ST7735S_SCALED_GLYPH_MAX_BYTES (6U * 7U * 2U * 2U * 2U)

#define OUT_LEFT 0x01U
#define OUT_RIGHT 0x02U
#define OUT_TOP 0x04U
#define OUT_BOTTOM 0x08U

static const uint8_t k_font_5x7[95][5] = {
    {0x00U, 0x00U, 0x00U, 0x00U, 0x00U},
    {0x00U, 0x00U, 0x5FU, 0x00U, 0x00U},
    {0x00U, 0x07U, 0x00U, 0x07U, 0x00U},
    {0x14U, 0x7FU, 0x14U, 0x7FU, 0x14U},
    {0x24U, 0x2AU, 0x7FU, 0x2AU, 0x12U},
    {0x23U, 0x13U, 0x08U, 0x64U, 0x62U},
    {0x36U, 0x49U, 0x55U, 0x22U, 0x50U},
    {0x00U, 0x05U, 0x03U, 0x00U, 0x00U},
    {0x00U, 0x1CU, 0x22U, 0x41U, 0x00U},
    {0x00U, 0x41U, 0x22U, 0x1CU, 0x00U},
    {0x14U, 0x08U, 0x3EU, 0x08U, 0x14U},
    {0x08U, 0x08U, 0x3EU, 0x08U, 0x08U},
    {0x00U, 0x50U, 0x30U, 0x00U, 0x00U},
    {0x08U, 0x08U, 0x08U, 0x08U, 0x08U},
    {0x00U, 0x60U, 0x60U, 0x00U, 0x00U},
    {0x20U, 0x10U, 0x08U, 0x04U, 0x02U},
    {0x3EU, 0x51U, 0x49U, 0x45U, 0x3EU},
    {0x00U, 0x42U, 0x7FU, 0x40U, 0x00U},
    {0x42U, 0x61U, 0x51U, 0x49U, 0x46U},
    {0x21U, 0x41U, 0x45U, 0x4BU, 0x31U},
    {0x18U, 0x14U, 0x12U, 0x7FU, 0x10U},
    {0x27U, 0x45U, 0x45U, 0x45U, 0x39U},
    {0x3CU, 0x4AU, 0x49U, 0x49U, 0x30U},
    {0x01U, 0x71U, 0x09U, 0x05U, 0x03U},
    {0x36U, 0x49U, 0x49U, 0x49U, 0x36U},
    {0x06U, 0x49U, 0x49U, 0x29U, 0x1EU},
    {0x00U, 0x36U, 0x36U, 0x00U, 0x00U},
    {0x00U, 0x56U, 0x36U, 0x00U, 0x00U},
    {0x08U, 0x14U, 0x22U, 0x41U, 0x00U},
    {0x14U, 0x14U, 0x14U, 0x14U, 0x14U},
    {0x00U, 0x41U, 0x22U, 0x14U, 0x08U},
    {0x02U, 0x01U, 0x51U, 0x09U, 0x06U},
    {0x32U, 0x49U, 0x79U, 0x41U, 0x3EU},
    {0x7EU, 0x11U, 0x11U, 0x11U, 0x7EU},
    {0x7FU, 0x49U, 0x49U, 0x49U, 0x36U},
    {0x3EU, 0x41U, 0x41U, 0x41U, 0x22U},
    {0x7FU, 0x41U, 0x41U, 0x22U, 0x1CU},
    {0x7FU, 0x49U, 0x49U, 0x49U, 0x41U},
    {0x7FU, 0x09U, 0x09U, 0x09U, 0x01U},
    {0x3EU, 0x41U, 0x49U, 0x49U, 0x7AU},
    {0x7FU, 0x08U, 0x08U, 0x08U, 0x7FU},
    {0x00U, 0x41U, 0x7FU, 0x41U, 0x00U},
    {0x20U, 0x40U, 0x41U, 0x3FU, 0x01U},
    {0x7FU, 0x08U, 0x14U, 0x22U, 0x41U},
    {0x7FU, 0x40U, 0x40U, 0x40U, 0x40U},
    {0x7FU, 0x02U, 0x0CU, 0x02U, 0x7FU},
    {0x7FU, 0x04U, 0x08U, 0x10U, 0x7FU},
    {0x3EU, 0x41U, 0x41U, 0x41U, 0x3EU},
    {0x7FU, 0x09U, 0x09U, 0x09U, 0x06U},
    {0x3EU, 0x41U, 0x51U, 0x21U, 0x5EU},
    {0x7FU, 0x09U, 0x19U, 0x29U, 0x46U},
    {0x46U, 0x49U, 0x49U, 0x49U, 0x31U},
    {0x01U, 0x01U, 0x7FU, 0x01U, 0x01U},
    {0x3FU, 0x40U, 0x40U, 0x40U, 0x3FU},
    {0x1FU, 0x20U, 0x40U, 0x20U, 0x1FU},
    {0x3FU, 0x40U, 0x38U, 0x40U, 0x3FU},
    {0x63U, 0x14U, 0x08U, 0x14U, 0x63U},
    {0x07U, 0x08U, 0x70U, 0x08U, 0x07U},
    {0x61U, 0x51U, 0x49U, 0x45U, 0x43U},
    {0x00U, 0x7FU, 0x41U, 0x41U, 0x00U},
    {0x02U, 0x04U, 0x08U, 0x10U, 0x20U},
    {0x00U, 0x41U, 0x41U, 0x7FU, 0x00U},
    {0x04U, 0x02U, 0x01U, 0x02U, 0x04U},
    {0x40U, 0x40U, 0x40U, 0x40U, 0x40U},
    {0x00U, 0x01U, 0x02U, 0x04U, 0x00U},
    {0x20U, 0x54U, 0x54U, 0x54U, 0x78U},
    {0x7FU, 0x48U, 0x44U, 0x44U, 0x38U},
    {0x38U, 0x44U, 0x44U, 0x44U, 0x20U},
    {0x38U, 0x44U, 0x44U, 0x48U, 0x7FU},
    {0x38U, 0x54U, 0x54U, 0x54U, 0x18U},
    {0x08U, 0x7EU, 0x09U, 0x01U, 0x02U},
    {0x0CU, 0x52U, 0x52U, 0x52U, 0x3EU},
    {0x7FU, 0x08U, 0x04U, 0x04U, 0x78U},
    {0x00U, 0x44U, 0x7DU, 0x40U, 0x00U},
    {0x20U, 0x40U, 0x44U, 0x3DU, 0x00U},
    {0x7FU, 0x10U, 0x28U, 0x44U, 0x00U},
    {0x00U, 0x41U, 0x7FU, 0x40U, 0x00U},
    {0x7CU, 0x04U, 0x18U, 0x04U, 0x78U},
    {0x7CU, 0x08U, 0x04U, 0x04U, 0x78U},
    {0x38U, 0x44U, 0x44U, 0x44U, 0x38U},
    {0x7CU, 0x14U, 0x14U, 0x14U, 0x08U},
    {0x08U, 0x14U, 0x14U, 0x18U, 0x7CU},
    {0x7CU, 0x08U, 0x04U, 0x04U, 0x08U},
    {0x48U, 0x54U, 0x54U, 0x54U, 0x20U},
    {0x04U, 0x3FU, 0x44U, 0x40U, 0x20U},
    {0x3CU, 0x40U, 0x40U, 0x20U, 0x7CU},
    {0x1CU, 0x20U, 0x40U, 0x20U, 0x1CU},
    {0x3CU, 0x40U, 0x30U, 0x40U, 0x3CU},
    {0x44U, 0x28U, 0x10U, 0x28U, 0x44U},
    {0x0CU, 0x50U, 0x50U, 0x50U, 0x3CU},
    {0x44U, 0x64U, 0x54U, 0x4CU, 0x44U},
    {0x00U, 0x08U, 0x36U, 0x41U, 0x00U},
    {0x00U, 0x00U, 0x7FU, 0x00U, 0x00U},
    {0x00U, 0x41U, 0x36U, 0x08U, 0x00U},
    {0x08U, 0x04U, 0x08U, 0x10U, 0x08U}
};

static bool bus_is_valid(const St7735sBus *bus)
{
    return (bus != NULL) &&
           (bus->set_cs != NULL) &&
           (bus->set_dc != NULL) &&
           (bus->set_reset != NULL) &&
           (bus->write != NULL) &&
           (bus->delay_ms != NULL);
}

static void write_command(St7735s *display,
                          uint8_t command,
                          const uint8_t *data,
                          size_t data_length)
{
    display->bus.set_cs(display->bus.context, false);
    display->bus.set_dc(display->bus.context, false);
    display->bus.write(display->bus.context, &command, 1U);

    if ((data != NULL) && (data_length > 0U))
    {
        display->bus.set_dc(display->bus.context, true);
        display->bus.write(display->bus.context, data, data_length);
    }

    display->bus.set_cs(display->bus.context, true);
}

static void write_pixels(St7735s *display,
                         uint16_t color,
                         uint32_t pixel_count)
{
    uint8_t buffer[ST7735S_PIXEL_CHUNK_BYTES];
    const uint8_t high = (uint8_t)(color >> 8U);
    const uint8_t low = (uint8_t)(color & 0xFFU);
    size_t index;

    for (index = 0U; index < sizeof(buffer); index += 2U)
    {
        buffer[index] = high;
        buffer[index + 1U] = low;
    }

    display->bus.set_cs(display->bus.context, false);
    display->bus.set_dc(display->bus.context, true);
    while (pixel_count > 0U)
    {
        uint32_t pixels_this_write =
            pixel_count > (uint32_t)(sizeof(buffer) / 2U)
                ? (uint32_t)(sizeof(buffer) / 2U)
                : pixel_count;

        display->bus.write(display->bus.context,
                           buffer,
                           (size_t)pixels_this_write * 2U);
        pixel_count -= pixels_this_write;
    }
    display->bus.set_cs(display->bus.context, true);
}

static void write_pixel_bytes(St7735s *display,
                              const uint8_t *bytes,
                              size_t length)
{
    display->bus.set_cs(display->bus.context, false);
    display->bus.set_dc(display->bus.context, true);
    while (length > 0U)
    {
        size_t chunk = length > ST7735S_PIXEL_CHUNK_BYTES
                           ? ST7735S_PIXEL_CHUNK_BYTES
                           : length;

        display->bus.write(display->bus.context, bytes, chunk);
        bytes += chunk;
        length -= chunk;
    }
    display->bus.set_cs(display->bus.context, true);
}

static uint8_t line_out_code(int32_t x, int32_t y)
{
    uint8_t code = 0U;

    if (x < 0)
    {
        code |= OUT_LEFT;
    }
    else if (x >= (int32_t)ST7735S_WIDTH)
    {
        code |= OUT_RIGHT;
    }

    if (y < 0)
    {
        code |= OUT_TOP;
    }
    else if (y >= (int32_t)ST7735S_HEIGHT)
    {
        code |= OUT_BOTTOM;
    }

    return code;
}

static bool clip_line(int32_t *x_start,
                      int32_t *y_start,
                      int32_t *x_end,
                      int32_t *y_end)
{
    uint8_t start_code = line_out_code(*x_start, *y_start);
    uint8_t end_code = line_out_code(*x_end, *y_end);

    for (;;)
    {
        uint8_t outside_code;
        int32_t x;
        int32_t y;

        if ((start_code | end_code) == 0U)
        {
            return true;
        }
        if ((start_code & end_code) != 0U)
        {
            return false;
        }

        outside_code = start_code != 0U ? start_code : end_code;
        x = *x_start;
        y = *y_start;

        if ((outside_code & OUT_TOP) != 0U)
        {
            x = *x_start +
                (int32_t)(((int64_t)(*x_end - *x_start) *
                           (int64_t)(0 - *y_start)) /
                          (int64_t)(*y_end - *y_start));
            y = 0;
        }
        else if ((outside_code & OUT_BOTTOM) != 0U)
        {
            y = (int32_t)ST7735S_HEIGHT - 1;
            x = *x_start +
                (int32_t)(((int64_t)(*x_end - *x_start) *
                           (int64_t)(y - *y_start)) /
                          (int64_t)(*y_end - *y_start));
        }
        else if ((outside_code & OUT_RIGHT) != 0U)
        {
            x = (int32_t)ST7735S_WIDTH - 1;
            y = *y_start +
                (int32_t)(((int64_t)(*y_end - *y_start) *
                           (int64_t)(x - *x_start)) /
                          (int64_t)(*x_end - *x_start));
        }
        else
        {
            x = 0;
            y = *y_start +
                (int32_t)(((int64_t)(*y_end - *y_start) *
                           (int64_t)(0 - *x_start)) /
                          (int64_t)(*x_end - *x_start));
        }

        if (outside_code == start_code)
        {
            *x_start = x;
            *y_start = y;
            start_code = line_out_code(*x_start, *y_start);
        }
        else
        {
            *x_end = x;
            *y_end = y;
            end_code = line_out_code(*x_end, *y_end);
        }
    }
}

bool st7735s_init(St7735s *display, const St7735sBus *bus)
{
    static const uint8_t frame_control[] = {0x01U, 0x2CU, 0x2DU};
    static const uint8_t frame_control_3[] = {
        0x01U, 0x2CU, 0x2DU, 0x01U, 0x2CU, 0x2DU
    };
    static const uint8_t power_control_1[] = {0xA2U, 0x02U, 0x84U};
    static const uint8_t power_control_3[] = {0x0AU, 0x00U};
    static const uint8_t power_control_4[] = {0x8AU, 0x2AU};
    static const uint8_t power_control_5[] = {0x8AU, 0xEEU};
    static const uint8_t positive_gamma[] = {
        0x02U, 0x1CU, 0x07U, 0x12U, 0x37U, 0x32U, 0x29U, 0x2DU,
        0x29U, 0x25U, 0x2BU, 0x39U, 0x00U, 0x01U, 0x03U, 0x10U
    };
    static const uint8_t negative_gamma[] = {
        0x03U, 0x1DU, 0x07U, 0x06U, 0x2EU, 0x2CU, 0x29U, 0x2DU,
        0x2EU, 0x2EU, 0x37U, 0x3FU, 0x00U, 0x00U, 0x02U, 0x10U
    };
    static const uint8_t one_byte_07 = 0x07U;
    static const uint8_t one_byte_c5 = 0xC5U;
    static const uint8_t one_byte_0e = 0x0EU;
    static const uint8_t full_columns[] = {
        0x00U, 0x00U, 0x00U, (uint8_t)(ST7735S_WIDTH - 1U)
    };
    static const uint8_t full_rows[] = {
        0x00U, 0x00U, 0x00U, (uint8_t)(ST7735S_HEIGHT - 1U)
    };
    static const uint8_t pixel_format = ST7735S_PIXEL_FORMAT_RGB565;
    static const uint8_t memory_access = ST7735S_MADCTL_PORTRAIT_RGB;

    if ((display == NULL) || !bus_is_valid(bus))
    {
        return false;
    }

    memset(display, 0, sizeof(*display));
    display->bus = *bus;
    display->width = ST7735S_WIDTH;
    display->height = ST7735S_HEIGHT;

    display->bus.set_cs(display->bus.context, true);
    display->bus.set_dc(display->bus.context, true);
    display->bus.set_reset(display->bus.context, true);
    display->bus.delay_ms(display->bus.context, 5U);
    display->bus.set_reset(display->bus.context, false);
    display->bus.delay_ms(display->bus.context, 20U);
    display->bus.set_reset(display->bus.context, true);
    display->bus.delay_ms(display->bus.context, 150U);

    write_command(display, ST7735S_SWRESET, NULL, 0U);
    display->bus.delay_ms(display->bus.context, 150U);
    write_command(display, ST7735S_SLPOUT, NULL, 0U);
    display->bus.delay_ms(display->bus.context, 120U);

    write_command(display,
                  ST7735S_FRMCTR1,
                  frame_control,
                  sizeof(frame_control));
    write_command(display,
                  ST7735S_FRMCTR2,
                  frame_control,
                  sizeof(frame_control));
    write_command(display,
                  ST7735S_FRMCTR3,
                  frame_control_3,
                  sizeof(frame_control_3));
    write_command(display, ST7735S_INVCTR, &one_byte_07, 1U);
    write_command(display,
                  ST7735S_PWCTR1,
                  power_control_1,
                  sizeof(power_control_1));
    write_command(display, ST7735S_PWCTR2, &one_byte_c5, 1U);
    write_command(display,
                  ST7735S_PWCTR3,
                  power_control_3,
                  sizeof(power_control_3));
    write_command(display,
                  ST7735S_PWCTR4,
                  power_control_4,
                  sizeof(power_control_4));
    write_command(display,
                  ST7735S_PWCTR5,
                  power_control_5,
                  sizeof(power_control_5));
    write_command(display, ST7735S_VMCTR1, &one_byte_0e, 1U);
    write_command(display, ST7735S_INVOFF, NULL, 0U);
    write_command(display, ST7735S_COLMOD, &pixel_format, 1U);
    write_command(display, ST7735S_MADCTL, &memory_access, 1U);
    write_command(display,
                  ST7735S_CASET,
                  full_columns,
                  sizeof(full_columns));
    write_command(display, ST7735S_RASET, full_rows, sizeof(full_rows));
    write_command(display,
                  ST7735S_GMCTRP1,
                  positive_gamma,
                  sizeof(positive_gamma));
    write_command(display,
                  ST7735S_GMCTRN1,
                  negative_gamma,
                  sizeof(negative_gamma));
    write_command(display, ST7735S_NORON, NULL, 0U);
    display->bus.delay_ms(display->bus.context, 10U);
    write_command(display, ST7735S_DISPON, NULL, 0U);
    display->bus.delay_ms(display->bus.context, 100U);

    return true;
}

uint16_t st7735s_rgb565(uint8_t red, uint8_t green, uint8_t blue)
{
    return (uint16_t)((((uint16_t)red & 0xF8U) << 8U) |
                      (((uint16_t)green & 0xFCU) << 3U) |
                      ((uint16_t)blue >> 3U));
}

bool st7735s_set_window(St7735s *display,
                        int16_t x_start,
                        int16_t y_start,
                        int16_t x_end,
                        int16_t y_end)
{
    uint8_t columns[4];
    uint8_t rows[4];

    if ((display == NULL) ||
        (x_start < 0) ||
        (y_start < 0) ||
        (x_end < x_start) ||
        (y_end < y_start) ||
        (x_end >= (int16_t)display->width) ||
        (y_end >= (int16_t)display->height))
    {
        return false;
    }

    columns[0] = (uint8_t)((uint16_t)x_start >> 8U);
    columns[1] = (uint8_t)((uint16_t)x_start & 0xFFU);
    columns[2] = (uint8_t)((uint16_t)x_end >> 8U);
    columns[3] = (uint8_t)((uint16_t)x_end & 0xFFU);
    rows[0] = (uint8_t)((uint16_t)y_start >> 8U);
    rows[1] = (uint8_t)((uint16_t)y_start & 0xFFU);
    rows[2] = (uint8_t)((uint16_t)y_end >> 8U);
    rows[3] = (uint8_t)((uint16_t)y_end & 0xFFU);

    write_command(display, ST7735S_CASET, columns, sizeof(columns));
    write_command(display, ST7735S_RASET, rows, sizeof(rows));
    write_command(display, ST7735S_RAMWR, NULL, 0U);
    return true;
}

void st7735s_fill_rect(St7735s *display,
                       int16_t x,
                       int16_t y,
                       int16_t width,
                       int16_t height,
                       uint16_t color)
{
    int32_t x_start = x;
    int32_t y_start = y;
    int32_t x_end;
    int32_t y_end;
    uint32_t pixel_count;

    if ((display == NULL) || (width <= 0) || (height <= 0))
    {
        return;
    }

    x_end = x_start + (int32_t)width - 1;
    y_end = y_start + (int32_t)height - 1;

    if ((x_end < 0) ||
        (y_end < 0) ||
        (x_start >= (int32_t)display->width) ||
        (y_start >= (int32_t)display->height))
    {
        return;
    }

    if (x_start < 0)
    {
        x_start = 0;
    }
    if (y_start < 0)
    {
        y_start = 0;
    }
    if (x_end >= (int32_t)display->width)
    {
        x_end = (int32_t)display->width - 1;
    }
    if (y_end >= (int32_t)display->height)
    {
        y_end = (int32_t)display->height - 1;
    }

    if (!st7735s_set_window(display,
                            (int16_t)x_start,
                            (int16_t)y_start,
                            (int16_t)x_end,
                            (int16_t)y_end))
    {
        return;
    }

    pixel_count = (uint32_t)(x_end - x_start + 1) *
                  (uint32_t)(y_end - y_start + 1);
    write_pixels(display, color, pixel_count);
}

void st7735s_draw_pixel(St7735s *display,
                        int16_t x,
                        int16_t y,
                        uint16_t color)
{
    st7735s_fill_rect(display, x, y, 1, 1, color);
}

void st7735s_draw_line(St7735s *display,
                       int16_t x_start,
                       int16_t y_start,
                       int16_t x_end,
                       int16_t y_end,
                       uint16_t color)
{
    int32_t x0 = x_start;
    int32_t y0 = y_start;
    int32_t x1 = x_end;
    int32_t y1 = y_end;
    int32_t delta_x;
    int32_t step_x;
    int32_t delta_y;
    int32_t step_y;
    int32_t error;

    if ((display == NULL) || !clip_line(&x0, &y0, &x1, &y1))
    {
        return;
    }

    if (y0 == y1)
    {
        int32_t left = x0 < x1 ? x0 : x1;
        int32_t right = x0 < x1 ? x1 : x0;

        st7735s_fill_rect(display,
                          (int16_t)left,
                          (int16_t)y0,
                          (int16_t)(right - left + 1),
                          1,
                          color);
        return;
    }

    if (x0 == x1)
    {
        int32_t top = y0 < y1 ? y0 : y1;
        int32_t bottom = y0 < y1 ? y1 : y0;

        st7735s_fill_rect(display,
                          (int16_t)x0,
                          (int16_t)top,
                          1,
                          (int16_t)(bottom - top + 1),
                          color);
        return;
    }

    delta_x = x1 > x0 ? x1 - x0 : x0 - x1;
    step_x = x0 < x1 ? 1 : -1;
    delta_y = y1 > y0 ? y0 - y1 : y1 - y0;
    step_y = y0 < y1 ? 1 : -1;
    error = delta_x + delta_y;

    for (;;)
    {
        int32_t doubled_error;

        st7735s_draw_pixel(display, (int16_t)x0, (int16_t)y0, color);
        if ((x0 == x1) && (y0 == y1))
        {
            break;
        }

        doubled_error = error * 2;
        if (doubled_error >= delta_y)
        {
            error += delta_y;
            x0 += step_x;
        }
        if (doubled_error <= delta_x)
        {
            error += delta_x;
            y0 += step_y;
        }
    }
}

void st7735s_draw_char(St7735s *display,
                       int16_t x,
                       int16_t y,
                       char character,
                       uint16_t foreground,
                       uint16_t background,
                       bool opaque)
{
    unsigned char glyph_character = (unsigned char)character;
    const uint8_t *glyph;
    uint8_t buffer[ST7735S_SCALED_GLYPH_MAX_BYTES];
    size_t buffer_index = 0U;
    int16_t column;
    int16_t row;

    if (display == NULL)
    {
        return;
    }

    if ((glyph_character < 32U) || (glyph_character > 126U))
    {
        glyph_character = (unsigned char)'?';
    }
    glyph = k_font_5x7[glyph_character - 32U];

    if (opaque &&
        (x >= 0) &&
        (y >= 0) &&
        ((int32_t)x + 5 < (int32_t)display->width) &&
        ((int32_t)y + 6 < (int32_t)display->height) &&
        st7735s_set_window(display, x, y, (int16_t)(x + 5),
                          (int16_t)(y + 6)))
    {
        for (row = 0; row < 7; ++row)
        {
            for (column = 0; column < 6; ++column)
            {
                bool pixel_set =
                    (column < 5) &&
                    ((glyph[column] &
                      (uint8_t)(1U << (uint16_t)row)) != 0U);
                uint16_t color = pixel_set ? foreground : background;

                buffer[buffer_index++] = (uint8_t)(color >> 8U);
                buffer[buffer_index++] = (uint8_t)(color & 0xFFU);
            }
        }
        write_pixel_bytes(display, buffer, buffer_index);
        return;
    }

    for (column = 0; column < 5; ++column)
    {
        for (row = 0; row < 7; ++row)
        {
            bool pixel_set =
                (glyph[column] & (uint8_t)(1U << (uint16_t)row)) != 0U;

            if (pixel_set)
            {
                st7735s_draw_pixel(display,
                                   (int16_t)(x + column),
                                   (int16_t)(y + row),
                                   foreground);
            }
            else if (opaque)
            {
                st7735s_draw_pixel(display,
                                   (int16_t)(x + column),
                                   (int16_t)(y + row),
                                   background);
            }
        }
    }

    if (opaque)
    {
        st7735s_fill_rect(display,
                          (int16_t)(x + 5),
                          y,
                          1,
                          7,
                          background);
    }
}

static void draw_char_scaled(St7735s *display,
                             int16_t x,
                             int16_t y,
                             char character,
                             uint16_t foreground,
                             uint16_t background,
                             bool opaque,
                             uint8_t scale)
{
    unsigned char glyph_character = (unsigned char)character;
    const uint8_t *glyph;
    uint8_t buffer[ST7735S_SCALED_GLYPH_MAX_BYTES];
    size_t buffer_index = 0U;
    int16_t column;
    int16_t row;
    uint8_t repeat_x;
    uint8_t repeat_y;

    if ((display == NULL) || (scale == 0U) ||
        (scale > ST7735S_MAX_TEXT_SCALE))
    {
        return;
    }

    if ((glyph_character < 32U) || (glyph_character > 126U))
    {
        glyph_character = (unsigned char)'?';
    }
    glyph = k_font_5x7[glyph_character - 32U];

    if (opaque &&
        (x >= 0) &&
        (y >= 0) &&
        ((int32_t)x + (int32_t)(6U * scale) - 1 <
         (int32_t)display->width) &&
        ((int32_t)y + (int32_t)(7U * scale) - 1 <
         (int32_t)display->height) &&
        st7735s_set_window(
            display, x, y,
            (int16_t)(x + (int16_t)(6U * scale) - 1),
            (int16_t)(y + (int16_t)(7U * scale) - 1)))
    {
        for (row = 0; row < 7; ++row)
        {
            for (repeat_y = 0U; repeat_y < scale; ++repeat_y)
            {
                for (column = 0; column < 6; ++column)
                {
                    bool pixel_set =
                        (column < 5) &&
                        ((glyph[column] &
                          (uint8_t)(1U << (uint16_t)row)) != 0U);
                    uint16_t color =
                        pixel_set ? foreground : background;

                    for (repeat_x = 0U; repeat_x < scale; ++repeat_x)
                    {
                        buffer[buffer_index++] =
                            (uint8_t)(color >> 8U);
                        buffer[buffer_index++] =
                            (uint8_t)(color & 0xFFU);
                    }
                }
            }
        }
        write_pixel_bytes(display, buffer, buffer_index);
        return;
    }

    for (column = 0; column < 6; ++column)
    {
        for (row = 0; row < 7; ++row)
        {
            bool pixel_set =
                (column < 5) &&
                ((glyph[column] &
                  (uint8_t)(1U << (uint16_t)row)) != 0U);

            if (pixel_set || opaque)
            {
                st7735s_fill_rect(
                    display,
                    (int16_t)(x + (int16_t)(column * scale)),
                    (int16_t)(y + (int16_t)(row * scale)),
                    (int16_t)scale,
                    (int16_t)scale,
                    pixel_set ? foreground : background);
            }
        }
    }
}

void st7735s_draw_text(St7735s *display,
                       int16_t x,
                       int16_t y,
                       const char *text,
                       uint16_t foreground,
                       uint16_t background,
                       bool opaque)
{
    int16_t cursor_x = x;
    int16_t cursor_y = y;

    if ((display == NULL) || (text == NULL))
    {
        return;
    }

    while (*text != '\0')
    {
        if (*text == '\n')
        {
            cursor_x = x;
            cursor_y = (int16_t)(cursor_y + 8);
        }
        else if (*text != '\r')
        {
            st7735s_draw_char(display,
                              cursor_x,
                              cursor_y,
                              *text,
                              foreground,
                              background,
                              opaque);
            cursor_x = (int16_t)(cursor_x + 6);
        }
        ++text;
    }
}

void st7735s_draw_text_scaled(St7735s *display,
                              int16_t x,
                              int16_t y,
                              const char *text,
                              uint16_t foreground,
                              uint16_t background,
                              bool opaque,
                              uint8_t scale)
{
    int16_t cursor_x = x;
    int16_t cursor_y = y;

    if ((display == NULL) || (text == NULL) || (scale == 0U) ||
        (scale > ST7735S_MAX_TEXT_SCALE))
    {
        return;
    }

    while (*text != '\0')
    {
        if (*text == '\n')
        {
            cursor_x = x;
            cursor_y =
                (int16_t)(cursor_y + (int16_t)(8U * scale));
        }
        else if (*text != '\r')
        {
            draw_char_scaled(display, cursor_x, cursor_y, *text,
                             foreground, background, opaque, scale);
            cursor_x =
                (int16_t)(cursor_x + (int16_t)(6U * scale));
        }
        ++text;
    }
}
