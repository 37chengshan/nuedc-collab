#ifndef LOCK_DISPLAY_FORMAT_H
#define LOCK_DISPLAY_FORMAT_H

#include "lock_types.h"

#include <stdint.h>

#define LOCK_DISPLAY_ID_TEXT_CAPACITY 5U
#define LOCK_DISPLAY_ANGLE_TEXT_CAPACITY 10U
#define LOCK_DISPLAY_DISTANCE_TEXT_CAPACITY 9U

/*
 * Formats the low four bits as binary and always keeps leading zeroes.
 * The output buffer must provide LOCK_DISPLAY_ID_TEXT_CAPACITY bytes.
 */
void lock_display_format_id4(uint8_t id, char *output);

/*
 * Formats the observed key ID, or "----" while no valid key ID is present.
 * The output buffer must provide LOCK_DISPLAY_ID_TEXT_CAPACITY bytes.
 */
void lock_display_format_key_id(const LockDisplayModel *model, char *output);

/*
 * Formats a trusted bearing as a rounded signed value such as "+30 deg".
 * Held, missing, non-finite, or out-of-range bearings are formatted as "--".
 * The output buffer must provide LOCK_DISPLAY_ANGLE_TEXT_CAPACITY bytes.
 */
void lock_display_format_angle(const LockDisplayModel *model, char *output);

/*
 * Formats boundary distance as meters with two decimal places, for example
 * "1.23 m". Missing or non-finite positions are formatted as "--.-- m".
 */
void lock_display_format_distance(const LockDisplayModel *model,
                                  char *output);

/* Returns one of the static strings "WAIT", "PASS", or "FAIL". */
const char *lock_display_auth_text(const LockDisplayModel *model);

/* Returns a stable static label for the supplied zone. */
const char *lock_display_zone_text(LockZone zone);

/* Returns "OPEN" only for LOCK_STATE_UNLOCKED; otherwise returns "LOCKED". */
const char *lock_display_state_text(LockState state);

#endif
