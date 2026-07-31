#ifndef OLED_RECOVERY_H
#define OLED_RECOVERY_H

#include <stdbool.h>
#include <stdint.h>

#define OLED_RECOVERY_FAILURE_LIMIT 3U
#define OLED_RECOVERY_RETRY_DELAY_MS 1000U

typedef struct {
    bool ready;
    uint8_t consecutive_failures;
    uint32_t retry_at_ms;
} OledRecoveryState;

void oled_recovery_init(OledRecoveryState *state, bool initialized,
                        uint32_t now_ms);
bool oled_recovery_is_ready(const OledRecoveryState *state);
void oled_recovery_record_refresh(OledRecoveryState *state, bool success,
                                  uint32_t now_ms);
bool oled_recovery_reinit_due(const OledRecoveryState *state,
                              uint32_t now_ms);
void oled_recovery_record_reinit(OledRecoveryState *state, bool success,
                                 uint32_t now_ms);

#endif
