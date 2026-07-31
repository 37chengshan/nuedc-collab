#include "lock_display_ui.h"

#include "lock_display_format.h"

#include <math.h>
#include <stddef.h>

#define UI_COLOR_BACKGROUND 0x0842U
#define UI_COLOR_PANEL 0x10A5U
#define UI_COLOR_BORDER 0x2A69U
#define UI_COLOR_WHITE 0xFFFFU
#define UI_COLOR_MUTED 0x8C71U
#define UI_COLOR_CYAN 0x07FFU
#define UI_COLOR_GREEN 0x07E0U
#define UI_COLOR_RED 0xF800U
#define UI_COLOR_YELLOW 0xFFE0U
#define UI_COLOR_BLACK 0x0000U
#define UI_COLOR_BLUE 0x001FU

#define UI_PI 3.14159265358979323846f

static size_t text_length(const char *text)
{
    size_t length = 0U;

    while ((text != NULL) && (text[length] != '\0')) {
        length++;
    }
    return length;
}

static int16_t centered_x(const char *text, uint8_t scale)
{
    int32_t width = (int32_t)text_length(text) * 6 * scale;

    return (int16_t)((ST7735S_WIDTH - width) / 2);
}

static void draw_label(St7735s *display, int16_t y, const char *label)
{
    st7735s_draw_text(display, 7, y, label, UI_COLOR_MUTED,
                      UI_COLOR_BACKGROUND, true);
}

static void draw_static_frame(LockDisplayUi *ui)
{
    St7735s *display = ui->display;

    st7735s_fill_rect(display, 0, 0, ST7735S_WIDTH, ST7735S_HEIGHT,
                      UI_COLOR_BACKGROUND);
    st7735s_fill_rect(display, 0, 0, ST7735S_WIDTH, 14, UI_COLOR_PANEL);
    st7735s_draw_text(display, 28, 4, "DIGITAL KEY", UI_COLOR_WHITE,
                      UI_COLOR_PANEL, true);
    st7735s_draw_line(display, 0, 14, 127, 14, UI_COLOR_CYAN);

    draw_label(display, 19, "TAG SET");
    draw_label(display, 30, "TAG ID");
    draw_label(display, 41, "AUTH");
    draw_label(display, 113, "DIST");
    draw_label(display, 125, "ZONE");

    st7735s_draw_line(display, 5, 51, 122, 51, UI_COLOR_BORDER);
    st7735s_draw_line(display, 5, 108, 122, 108, UI_COLOR_BORDER);
    ui->frame_drawn = true;
}

static uint16_t auth_color(const LockDisplayModel *model)
{
    const char *auth = lock_display_auth_text(model);

    if (auth[0] == 'P') {
        return UI_COLOR_GREEN;
    }
    if (auth[0] == 'F') {
        return UI_COLOR_RED;
    }
    return UI_COLOR_YELLOW;
}

static void draw_angle_panel(LockDisplayUi *ui,
                             const LockDisplayModel *model)
{
    static const int16_t arc_points[][2] = {
        {30, 80}, {34, 70}, {42, 62}, {52, 57}, {64, 55},
        {76, 57}, {86, 62}, {94, 70}, {98, 80},
    };
    St7735s *display = ui->display;
    char angle[LOCK_DISPLAY_ANGLE_TEXT_CAPACITY];
    char channels[LOCK_DISPLAY_CHANNEL_TEXT_CAPACITY];
    uint16_t color =
        model->position.angle_valid ? UI_COLOR_CYAN : UI_COLOR_YELLOW;
    uint16_t channel_color =
        ((model->channel_valid_mask & 0x03U) == 0x03U &&
         model->channel_distance_mm[0] > 0U &&
         model->channel_distance_mm[1] > 0U)
            ? UI_COLOR_CYAN
            : UI_COLOR_YELLOW;
    size_t index;

    st7735s_fill_rect(display, 6, 52, 116, 56, UI_COLOR_PANEL);
    lock_display_format_channels(model, channels);
    st7735s_draw_text(display, 7, 55, channels, channel_color,
                      UI_COLOR_PANEL, true);
    for (index = 1U;
         index < (sizeof(arc_points) / sizeof(arc_points[0]));
         index++) {
        st7735s_draw_line(display, arc_points[index - 1U][0],
                          arc_points[index - 1U][1],
                          arc_points[index][0], arc_points[index][1],
                          UI_COLOR_BORDER);
    }

    if (model->position.angle_valid || model->position.angle_held) {
        float bounded = model->position.bearing_deg;
        float radians;
        int16_t end_x;
        int16_t end_y;

        if (bounded < -60.0f) {
            bounded = -60.0f;
        } else if (bounded > 60.0f) {
            bounded = 60.0f;
        }
        radians = bounded * (UI_PI / 180.0f);
        end_x = (int16_t)(64.0f + sinf(radians) * 22.0f);
        end_y = (int16_t)(80.0f - cosf(radians) * 22.0f);
        st7735s_draw_line(display, 64, 80, end_x, end_y, color);
        st7735s_fill_rect(display, 62, 78, 5, 5, color);
    } else {
        st7735s_draw_line(display, 58, 78, 70, 78, UI_COLOR_YELLOW);
    }

    lock_display_format_angle(model, angle);
    st7735s_draw_text_scaled(display, centered_x(angle, 2U), 88, angle,
                             color, UI_COLOR_PANEL, true, 2U);
}

static void draw_value_row(St7735s *display, int16_t y, const char *text,
                           uint16_t color)
{
    st7735s_fill_rect(display, 62, y - 1, 61, 9, UI_COLOR_BACKGROUND);
    st7735s_draw_text(display, 65, y, text, color, UI_COLOR_BACKGROUND,
                      true);
}

static void draw_status_bar(St7735s *display,
                            const LockDisplayModel *model)
{
    const char *state = lock_display_footer_text(model);
    uint16_t background =
        model->monitor_only
            ? UI_COLOR_BLUE
            : (model->state == LOCK_STATE_UNLOCKED) ? UI_COLOR_GREEN
                                                    : UI_COLOR_RED;
    uint16_t foreground =
        (!model->monitor_only &&
         (model->state == LOCK_STATE_UNLOCKED))
            ? UI_COLOR_BLACK
            : UI_COLOR_WHITE;

    st7735s_fill_rect(display, 0, 140, ST7735S_WIDTH, 20, background);
    st7735s_draw_text_scaled(display, centered_x(state, 2U), 143, state,
                             foreground, background, true, 2U);
}

void lock_display_ui_init(LockDisplayUi *ui, St7735s *display)
{
    if (ui == NULL) {
        return;
    }
    ui->display = display;
    ui->frame_drawn = false;
    ui->has_rendered = false;
    ui->last_render_ms = 0U;
}

void lock_display_ui_render(LockDisplayUi *ui,
                            const LockDisplayModel *model)
{
    char expected[LOCK_DISPLAY_ID_TEXT_CAPACITY];
    char observed[LOCK_DISPLAY_ID_TEXT_CAPACITY];
    char distance[LOCK_DISPLAY_DISTANCE_TEXT_CAPACITY];

    if ((ui == NULL) || (ui->display == NULL) || (model == NULL)) {
        return;
    }
    if (ui->has_rendered &&
        ((model->now_ms - ui->last_render_ms) <
         LOCK_DISPLAY_UI_REFRESH_MS)) {
        return;
    }
    if (!ui->frame_drawn) {
        draw_static_frame(ui);
    }

    lock_display_format_address4(model->expected_address, expected);
    lock_display_format_key_id(model, observed);
    lock_display_format_distance(model, distance);

    draw_value_row(ui->display, 19, expected, UI_COLOR_CYAN);
    draw_value_row(ui->display, 30, observed, UI_COLOR_CYAN);
    draw_value_row(ui->display, 41, lock_display_auth_text(model),
                   auth_color(model));
    draw_angle_panel(ui, model);
    draw_value_row(ui->display, 113, distance, UI_COLOR_CYAN);
    draw_value_row(
        ui->display, 125, lock_display_zone_text(model->zone),
        (model->zone == LOCK_ZONE_INVALID) ? UI_COLOR_YELLOW
                                           : UI_COLOR_CYAN);
    draw_status_bar(ui->display, model);

    ui->last_render_ms = model->now_ms;
    ui->has_rendered = true;
}

void lock_display_ui_show_color_test(LockDisplayUi *ui)
{
    St7735s *display;

    if ((ui == NULL) || (ui->display == NULL)) {
        return;
    }
    display = ui->display;
    st7735s_fill_rect(display, 0, 0, 128, 32, UI_COLOR_RED);
    st7735s_fill_rect(display, 0, 32, 128, 32, UI_COLOR_GREEN);
    st7735s_fill_rect(display, 0, 64, 128, 32, UI_COLOR_BLUE);
    st7735s_fill_rect(display, 0, 96, 128, 32, UI_COLOR_WHITE);
    st7735s_fill_rect(display, 0, 128, 128, 32, UI_COLOR_BLACK);
    st7735s_draw_text_scaled(display, 52, 9, "R", UI_COLOR_WHITE,
                             UI_COLOR_RED, true, 2U);
    st7735s_draw_text_scaled(display, 52, 41, "G", UI_COLOR_BLACK,
                             UI_COLOR_GREEN, true, 2U);
    st7735s_draw_text_scaled(display, 52, 73, "B", UI_COLOR_WHITE,
                             UI_COLOR_BLUE, true, 2U);
    st7735s_draw_text(display, 43, 108, "WHITE", UI_COLOR_BLACK,
                      UI_COLOR_WHITE, true);
    st7735s_draw_text(display, 43, 140, "BLACK", UI_COLOR_WHITE,
                      UI_COLOR_BLACK, true);
    ui->frame_drawn = false;
    ui->has_rendered = false;
}
