#include "st7735s.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define ARRAY_COUNT(values) (sizeof(values) / sizeof((values)[0]))
#define MAX_TRANSFERS 2048U
#define MAX_TRANSFER_BYTES 128U

typedef struct
{
    bool is_data;
    size_t length;
    uint8_t bytes[MAX_TRANSFER_BYTES];
} RecordedTransfer;

typedef struct
{
    bool cs_high;
    bool dc_high;
    bool reset_high;
    size_t cs_changes;
    size_t dc_changes;
    size_t reset_changes;
    uint32_t delays[32];
    size_t delay_count;
    RecordedTransfer transfers[MAX_TRANSFERS];
    size_t transfer_count;
} RecordedBus;

static unsigned int g_failures;

static void check_true(bool condition, const char *message)
{
    if (!condition)
    {
        ++g_failures;
        fprintf(stderr, "FAIL: %s\n", message);
    }
}

static void record_cs(void *context, bool high)
{
    RecordedBus *bus = (RecordedBus *)context;

    bus->cs_high = high;
    ++bus->cs_changes;
}

static void record_dc(void *context, bool high)
{
    RecordedBus *bus = (RecordedBus *)context;

    bus->dc_high = high;
    ++bus->dc_changes;
}

static void record_reset(void *context, bool high)
{
    RecordedBus *bus = (RecordedBus *)context;

    bus->reset_high = high;
    ++bus->reset_changes;
}

static void record_write(void *context, const uint8_t *data, size_t length)
{
    RecordedBus *bus = (RecordedBus *)context;
    RecordedTransfer *transfer;

    check_true(bus->transfer_count < MAX_TRANSFERS,
               "recorded transfer capacity is sufficient");
    check_true(length <= MAX_TRANSFER_BYTES,
               "single bus transfer fits the recorder");
    if ((bus->transfer_count >= MAX_TRANSFERS) ||
        (length > MAX_TRANSFER_BYTES))
    {
        return;
    }

    transfer = &bus->transfers[bus->transfer_count++];
    transfer->is_data = bus->dc_high;
    transfer->length = length;
    memcpy(transfer->bytes, data, length);
}

static void record_delay(void *context, uint32_t milliseconds)
{
    RecordedBus *bus = (RecordedBus *)context;

    check_true(bus->delay_count < ARRAY_COUNT(bus->delays),
               "recorded delay capacity is sufficient");
    if (bus->delay_count < ARRAY_COUNT(bus->delays))
    {
        bus->delays[bus->delay_count++] = milliseconds;
    }
}

static St7735sBus make_bus(RecordedBus *recorded)
{
    St7735sBus bus;

    bus.context = recorded;
    bus.set_cs = record_cs;
    bus.set_dc = record_dc;
    bus.set_reset = record_reset;
    bus.write = record_write;
    bus.delay_ms = record_delay;
    return bus;
}

static size_t find_command(const RecordedBus *bus,
                           uint8_t command,
                           size_t start_index)
{
    size_t index;

    for (index = start_index; index < bus->transfer_count; ++index)
    {
        const RecordedTransfer *transfer = &bus->transfers[index];

        if ((!transfer->is_data) &&
            (transfer->length == 1U) &&
            (transfer->bytes[0] == command))
        {
            return index;
        }
    }
    return SIZE_MAX;
}

static size_t data_bytes_after_ram_write(const RecordedBus *bus,
                                         size_t ram_write_index)
{
    size_t total = 0U;
    size_t index;

    for (index = ram_write_index + 1U;
         index < bus->transfer_count;
         ++index)
    {
        if (!bus->transfers[index].is_data)
        {
            break;
        }
        total += bus->transfers[index].length;
    }
    return total;
}

static size_t count_command(const RecordedBus *bus, uint8_t command)
{
    size_t count = 0U;
    size_t index;

    for (index = 0U; index < bus->transfer_count; ++index)
    {
        const RecordedTransfer *transfer = &bus->transfers[index];

        if ((!transfer->is_data) &&
            (transfer->length == 1U) &&
            (transfer->bytes[0] == command))
        {
            ++count;
        }
    }
    return count;
}

static void clear_transfers(RecordedBus *bus)
{
    bus->transfer_count = 0U;
}

static void test_init_sequence(void)
{
    RecordedBus recorded = {0};
    St7735s display;
    St7735sBus bus = make_bus(&recorded);
    size_t sleep_out;
    size_t pixel_format;
    size_t memory_access;
    size_t display_on;

    check_true(st7735s_init(&display, &bus), "valid bus initializes");
    check_true(display.width == ST7735S_WIDTH, "display width is 128");
    check_true(display.height == ST7735S_HEIGHT, "display height is 160");
    check_true(recorded.reset_changes >= 3U,
               "hardware reset is driven high-low-high");
    check_true(recorded.delay_count >= 3U,
               "initialization includes reset and sleep delays");

    sleep_out = find_command(&recorded, 0x11U, 0U);
    pixel_format = find_command(&recorded, 0x3AU, sleep_out + 1U);
    memory_access = find_command(&recorded, 0x36U, pixel_format + 1U);
    display_on = find_command(&recorded, 0x29U, memory_access + 1U);

    check_true(sleep_out != SIZE_MAX, "initialization sends sleep-out 0x11");
    check_true(pixel_format != SIZE_MAX,
               "initialization sends pixel-format 0x3A");
    check_true(memory_access != SIZE_MAX,
               "initialization sends memory-access 0x36");
    check_true(display_on != SIZE_MAX,
               "initialization sends display-on 0x29");
    check_true((pixel_format + 1U < recorded.transfer_count) &&
                   recorded.transfers[pixel_format + 1U].is_data &&
                   (recorded.transfers[pixel_format + 1U].length == 1U) &&
                   (recorded.transfers[pixel_format + 1U].bytes[0] == 0x05U),
               "0x3A selects 16-bit RGB565 pixels");
    check_true((memory_access + 1U < recorded.transfer_count) &&
                   recorded.transfers[memory_access + 1U].is_data &&
                   (recorded.transfers[memory_access + 1U].length == 1U) &&
                   (recorded.transfers[memory_access + 1U].bytes[0] == 0xC0U),
               "0x36 selects portrait RGB order used by the module");
    check_true(recorded.cs_high, "chip select is inactive after init");
}

static void test_rgb565_conversion(void)
{
    check_true(st7735s_rgb565(255U, 0U, 0U) == 0xF800U,
               "RGB565 red conversion");
    check_true(st7735s_rgb565(0U, 255U, 0U) == 0x07E0U,
               "RGB565 green conversion");
    check_true(st7735s_rgb565(0U, 0U, 255U) == 0x001FU,
               "RGB565 blue conversion");
    check_true(st7735s_rgb565(255U, 255U, 255U) == 0xFFFFU,
               "RGB565 white conversion");
}

static void test_fill_rect_clips_to_screen(void)
{
    RecordedBus recorded = {0};
    St7735s display;
    St7735sBus bus = make_bus(&recorded);
    size_t column;
    size_t row;
    size_t ram_write;

    check_true(st7735s_init(&display, &bus), "display initializes for fill");
    clear_transfers(&recorded);

    st7735s_fill_rect(&display, -2, 158, 5, 5, 0x1234U);

    column = find_command(&recorded, 0x2AU, 0U);
    row = find_command(&recorded, 0x2BU, column + 1U);
    ram_write = find_command(&recorded, 0x2CU, row + 1U);

    check_true(column != SIZE_MAX, "clipped fill sets column window");
    check_true(row != SIZE_MAX, "clipped fill sets row window");
    check_true(ram_write != SIZE_MAX, "clipped fill starts RAM write");
    check_true((column + 1U < recorded.transfer_count) &&
                   recorded.transfers[column + 1U].is_data &&
                   (recorded.transfers[column + 1U].length == 4U) &&
                   (recorded.transfers[column + 1U].bytes[0] == 0U) &&
                   (recorded.transfers[column + 1U].bytes[1] == 0U) &&
                   (recorded.transfers[column + 1U].bytes[2] == 0U) &&
                   (recorded.transfers[column + 1U].bytes[3] == 2U),
               "fill clips x range to 0..2");
    check_true((row + 1U < recorded.transfer_count) &&
                   recorded.transfers[row + 1U].is_data &&
                   (recorded.transfers[row + 1U].length == 4U) &&
                   (recorded.transfers[row + 1U].bytes[0] == 0U) &&
                   (recorded.transfers[row + 1U].bytes[1] == 158U) &&
                   (recorded.transfers[row + 1U].bytes[2] == 0U) &&
                   (recorded.transfers[row + 1U].bytes[3] == 159U),
               "fill clips y range to 158..159");
    check_true(data_bytes_after_ram_write(&recorded, ram_write) == 12U,
               "clipped 3x2 fill writes exactly six RGB565 pixels");

    clear_transfers(&recorded);
    st7735s_fill_rect(&display, 128, 0, 10, 10, 0xFFFFU);
    check_true(recorded.transfer_count == 0U,
               "fully off-screen rectangle produces no bus traffic");
}

static void test_pixel_and_line_clipping(void)
{
    RecordedBus recorded = {0};
    St7735s display;
    St7735sBus bus = make_bus(&recorded);
    size_t ram_write;

    check_true(st7735s_init(&display, &bus), "display initializes for drawing");
    clear_transfers(&recorded);

    st7735s_draw_pixel(&display, -1, 20, 0xFFFFU);
    st7735s_draw_pixel(&display, 127, 159, 0xABCDU);
    check_true(find_command(&recorded, 0x2CU, 0U) != SIZE_MAX,
               "last in-range pixel is written");
    check_true(find_command(&recorded, 0x2CU,
                            find_command(&recorded, 0x2CU, 0U) + 1U) ==
                   SIZE_MAX,
               "off-screen pixel is ignored");

    clear_transfers(&recorded);
    st7735s_draw_line(&display, -100, 10, 200, 10, 0x07E0U);
    ram_write = find_command(&recorded, 0x2CU, 0U);
    check_true(ram_write != SIZE_MAX, "clipped horizontal line is drawn");
    check_true(data_bytes_after_ram_write(&recorded, ram_write) ==
                   (size_t)ST7735S_WIDTH * 2U,
               "horizontal line clips to exactly 128 pixels");

    clear_transfers(&recorded);
    st7735s_draw_line(&display, -20, -20, -1, -1, 0xFFFFU);
    check_true(recorded.transfer_count == 0U,
               "fully off-screen line produces no bus traffic");

    clear_transfers(&recorded);
    st7735s_draw_line(&display, 5, -100, 5, 200, 0x001FU);
    ram_write = find_command(&recorded, 0x2CU, 0U);
    check_true((ram_write != SIZE_MAX) &&
                   (data_bytes_after_ram_write(&recorded, ram_write) ==
                    (size_t)ST7735S_HEIGHT * 2U),
               "vertical line clips to exactly 160 pixels");

    clear_transfers(&recorded);
    st7735s_draw_line(&display, -10, -10, 2, 2, 0xF800U);
    check_true(count_command(&recorded, 0x2CU) == 3U,
               "diagonal line clips to three visible pixels");
}

static void test_window_validation(void)
{
    RecordedBus recorded = {0};
    St7735s display;
    St7735sBus bus = make_bus(&recorded);

    check_true(st7735s_init(&display, &bus), "display initializes for window");
    clear_transfers(&recorded);

    check_true(!st7735s_set_window(&display, -1, 0, 1, 1),
               "negative window is rejected");
    check_true(!st7735s_set_window(&display, 10, 10, 9, 11),
               "inverted window is rejected");
    check_true(!st7735s_set_window(&display, 0, 0, 128, 159),
               "window beyond width is rejected");
    check_true(recorded.transfer_count == 0U,
               "invalid windows produce no bus traffic");
}

static void test_ascii_text_is_bounded(void)
{
    RecordedBus recorded = {0};
    St7735s display;
    St7735sBus bus = make_bus(&recorded);
    size_t index;

    check_true(st7735s_init(&display, &bus), "display initializes for text");
    clear_transfers(&recorded);

    st7735s_draw_text(&display,
                      124,
                      156,
                      "A",
                      0xFFFFU,
                      0x0000U,
                      true);

    check_true(recorded.transfer_count > 0U,
               "partially visible text still draws visible pixels");
    for (index = 0U; index < recorded.transfer_count; ++index)
    {
        const RecordedTransfer *transfer = &recorded.transfers[index];

        if ((!transfer->is_data) &&
            (transfer->length == 1U) &&
            ((transfer->bytes[0] == 0x2AU) ||
             (transfer->bytes[0] == 0x2BU)))
        {
            const RecordedTransfer *coordinates;
            uint16_t end;

            check_true(index + 1U < recorded.transfer_count,
                       "window command has coordinate data");
            if (index + 1U >= recorded.transfer_count)
            {
                continue;
            }
            coordinates = &recorded.transfers[index + 1U];
            check_true(coordinates->is_data &&
                           (coordinates->length == 4U),
                       "window coordinates use four data bytes");
            if ((!coordinates->is_data) ||
                (coordinates->length != 4U))
            {
                continue;
            }
            end = (uint16_t)(((uint16_t)coordinates->bytes[2] << 8U) |
                             coordinates->bytes[3]);
            if (transfer->bytes[0] == 0x2AU)
            {
                check_true(end < ST7735S_WIDTH,
                           "text column window remains in bounds");
            }
            else
            {
                check_true(end < ST7735S_HEIGHT,
                           "text row window remains in bounds");
            }
        }
    }

    clear_transfers(&recorded);
    st7735s_draw_char(&display,
                      0,
                      0,
                      'A',
                      0xFFFFU,
                      0x0000U,
                      false);
    check_true(count_command(&recorded, 0x2CU) == 18U,
               "transparent A writes only its 18 foreground pixels");

    clear_transfers(&recorded);
    st7735s_draw_text(&display,
                      0,
                      0,
                      "\r\n\x01",
                      0xFFFFU,
                      0x0000U,
                      false);
    check_true(recorded.transfer_count > 0U,
               "text handles CR, newline, and unsupported ASCII safely");
}

static void test_invalid_bus_is_rejected(void)
{
    RecordedBus recorded = {0};
    St7735s display;
    St7735sBus bus = make_bus(&recorded);

    bus.write = NULL;
    check_true(!st7735s_init(&display, &bus),
               "missing required write callback is rejected");
    check_true(!st7735s_init(NULL, &bus), "null display is rejected");
    check_true(!st7735s_init(&display, NULL), "null bus is rejected");
}

int main(void)
{
    test_init_sequence();
    test_rgb565_conversion();
    test_fill_rect_clips_to_screen();
    test_pixel_and_line_clipping();
    test_window_validation();
    test_ascii_text_is_bounded();
    test_invalid_bus_is_rejected();

    if (g_failures != 0U)
    {
        fprintf(stderr, "%u ST7735S test(s) failed\n", g_failures);
        return 1;
    }

    puts("All ST7735S tests passed");
    return 0;
}
