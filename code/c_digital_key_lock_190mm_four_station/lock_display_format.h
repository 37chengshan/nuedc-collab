#ifndef LOCK_DISPLAY_FORMAT_H
#define LOCK_DISPLAY_FORMAT_H

#include "lock_types.h"

#include <stdint.h>

#define LOCK_DISPLAY_ID_TEXT_CAPACITY 5U
#define LOCK_DISPLAY_ANGLE_TEXT_CAPACITY 10U
#define LOCK_DISPLAY_DISTANCE_TEXT_CAPACITY 16U
#define LOCK_DISPLAY_CHANNEL_TEXT_CAPACITY 12U

/*
 * Formats the low four bits as binary and always keeps leading zeroes.
 * The output buffer must provide LOCK_DISPLAY_ID_TEXT_CAPACITY bytes.
 */
void lock_display_format_id4(uint8_t id, char *output);

/* Formats a 16-bit numeric address as four uppercase hexadecimal digits. */
void lock_display_format_address4(uint16_t address, char *output);

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
 * Formats boundary distance with one decimal place, for example "0.4m".
 */
void lock_display_format_distance(const LockDisplayModel *model,
                                  char *output);

/*
 * Formats the four UART states as OK/-- without showing raw distances.
 */
void lock_display_format_channels(const LockDisplayModel *model,
                                  char *output);
void lock_display_format_channel_pair(const LockDisplayModel *model,
                                      uint8_t first_channel, char *output);

/* Returns one of the static strings "WAIT", "PASS", or "FAIL". */
const char *lock_display_auth_text(const LockDisplayModel *model);

/* Returns a stable static label for the supplied zone. */
const char *lock_display_zone_text(LockZone zone);

/* Returns "OPEN" only for LOCK_STATE_UNLOCKED; otherwise returns "LOCKED". */
const char *lock_display_state_text(LockState state);

/* Returns "MONITOR" for the non-actuating L2 firmware. */
const char *lock_display_footer_text(const LockDisplayModel *model);

#endif
