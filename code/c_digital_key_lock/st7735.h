#ifndef ST7735_H
#define ST7735_H

#include "lock_types.h"

void st7735_init(void);
void st7735_present(const LockDisplayModel *display);

#endif
