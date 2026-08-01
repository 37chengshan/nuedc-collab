#ifndef LOCK_DISPLAY_UI_H
#define LOCK_DISPLAY_UI_H

#include "lock_types.h"
#include "st7735s.h"

#include <stdbool.h>
#include <stdint.h>

#define LOCK_DISPLAY_UI_REFRESH_MS 500U

typedef struct {
    St7735s *display;
    bool frame_drawn;
    bool has_rendered;
    uint32_t last_render_ms;
} LockDisplayUi;

void lock_display_ui_init(LockDisplayUi *ui, St7735s *display);
void lock_display_ui_render(LockDisplayUi *ui,
                            const LockDisplayModel *model);
void lock_display_ui_show_color_test(LockDisplayUi *ui);

#endif
