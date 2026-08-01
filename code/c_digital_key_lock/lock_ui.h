#ifndef LOCK_UI_H
#define LOCK_UI_H

#include "lock_types.h"

#define LOCK_UI_LINE_COUNT 10U
#define LOCK_UI_LINE_CAPACITY 11U

typedef enum {
    LOCK_UI_PAIR_NONE = 0,
    LOCK_UI_PAIR_MATCH,
    LOCK_UI_PAIR_FAIL
} LockUiPairStatus;

typedef struct {
    char lines[LOCK_UI_LINE_COUNT][LOCK_UI_LINE_CAPACITY];
} LockUiText;

LockUiPairStatus lock_ui_pair_status(const LockDisplayModel *display);
void lock_ui_format(const LockDisplayModel *display, LockUiText *text);

#endif
