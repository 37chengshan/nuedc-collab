#ifndef LOCK_APP_H
#define LOCK_APP_H

#include "id_input.h"
#include "lock_fsm.h"
#include "uwb_fusion.h"
#include "uwb_text_protocol.h"

typedef struct {
    LockAppConfig config;
    const CalibrationModelV1 *calibration_model;
    const EmpiricalModelV1 *empirical_model;
    CalibrationModelStatus calibration_status;
    EmpiricalModelStatus empirical_status;
    UwbTextParser parsers[LOCK_UWB_CHANNEL_COUNT];
    LockUwbFusion fusion;
    LockIdInput id_input;
    LockStateMachine state_machine;
    LockPositionSolution position;
    LockOutputSnapshot outputs;
    LockDisplayModel display;
} LockApp;

void lock_app_init(LockApp *app, LockIdInputBackend backend);
void lock_app_init_with_model(LockApp *app, LockIdInputBackend backend,
                              const CalibrationModelV1 *model);
void lock_app_init_with_models(LockApp *app, LockIdInputBackend backend,
                               const CalibrationModelV1 *calibration_model,
                               const EmpiricalModelV1 *empirical_model);
void lock_app_process_uart_byte(LockApp *app, uint8_t channel, uint8_t byte,
                                uint32_t now_ms);
void lock_app_update(LockApp *app, uint32_t now_ms,
                     uint8_t raw_id_low_active_bits);
const LockOutputSnapshot *lock_app_outputs(const LockApp *app);
const LockDisplayModel *lock_app_display(const LockApp *app);

#endif
