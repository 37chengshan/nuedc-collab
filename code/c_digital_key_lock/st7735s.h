#ifndef ST7735S_H
#define ST7735S_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define ST7735S_WIDTH 128U
#define ST7735S_HEIGHT 160U

typedef void (*St7735sPinWrite)(void *context, bool high);
typedef void (*St7735sWrite)(void *context,
                             const uint8_t *data,
                             size_t length);
typedef void (*St7735sDelayMs)(void *context, uint32_t milliseconds);

typedef struct
{
    void *context;
    St7735sPinWrite set_cs;
    St7735sPinWrite set_dc;
    St7735sPinWrite set_reset;
    St7735sWrite write;
    St7735sDelayMs delay_ms;
} St7735sBus;

typedef struct
{
    St7735sBus bus;
    uint16_t width;
    uint16_t height;
} St7735s;

bool st7735s_init(St7735s *display, const St7735sBus *bus);

uint16_t st7735s_rgb565(uint8_t red, uint8_t green, uint8_t blue);

bool st7735s_set_window(St7735s *display,
                        int16_t x_start,
                        int16_t y_start,
                        int16_t x_end,
                        int16_t y_end);

void st7735s_fill_rect(St7735s *display,
                       int16_t x,
                       int16_t y,
                       int16_t width,
                       int16_t height,
                       uint16_t color);

void st7735s_draw_pixel(St7735s *display,
                        int16_t x,
                        int16_t y,
                        uint16_t color);

void st7735s_draw_line(St7735s *display,
                       int16_t x_start,
                       int16_t y_start,
                       int16_t x_end,
                       int16_t y_end,
                       uint16_t color);

void st7735s_draw_char(St7735s *display,
                       int16_t x,
                       int16_t y,
                       char character,
                       uint16_t foreground,
                       uint16_t background,
                       bool opaque);

void st7735s_draw_text(St7735s *display,
                       int16_t x,
                       int16_t y,
                       const char *text,
                       uint16_t foreground,
                       uint16_t background,
                       bool opaque);

void st7735s_draw_text_scaled(St7735s *display,
                              int16_t x,
                              int16_t y,
                              const char *text,
                              uint16_t foreground,
                              uint16_t background,
                              bool opaque,
                              uint8_t scale);

#ifdef __cplusplus
}
#endif

#endif
