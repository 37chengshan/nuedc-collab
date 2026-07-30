_Static_assert(CALIBRATION_MODEL_V1_VERSION == 0x0100U,
               "version must stay v1");
_Static_assert(LOCK_UWB_CHANNEL_COUNT == 4U, "firmware supports 4 anchors");
_Static_assert(CALIBRATION_DISTANCE_AXIS_CAPACITY == 11U,
               "distance axis must contain 11 points");
_Static_assert(CALIBRATION_ANGLE_AXIS_CAPACITY == 7U,
               "angle axis must contain 7 points");
_Static_assert(CALIBRATION_GRID_CAPACITY == 77U,
               "compensation grid must contain 77 cells");
_Static_assert(sizeof(CalibrationModelV1) ==
                   CALIBRATION_MODEL_V1_SERIALIZED_SIZE,
               "exported model must match firmware ABI");

int calibration_model_v1_golden_fixture(void)
{
    const CalibrationModelV1 *model = &g_door_uwb_calibration;

    return (model->magic == CALIBRATION_MODEL_V1_MAGIC &&
            model->version == CALIBRATION_MODEL_V1_VERSION &&
            model->model_size_bytes == CALIBRATION_MODEL_V1_SERIALIZED_SIZE &&
            model->anchor_count == 4U &&
            model->enabled_anchor_mask == 0x0FU &&
            model->distance_axis_count == 11U &&
            model->angle_axis_count == 7U &&
            model->flags == (CALIBRATION_MODEL_FLAG_DISTANCE_GRID |
                             CALIBRATION_MODEL_FLAG_ANGLE_GRID) &&
            model->range_models[0].type == CALIBRATION_RANGE_LINEAR &&
            model->range_models[1].type == CALIBRATION_RANGE_QUADRATIC &&
            model->range_models[2].type == CALIBRATION_RANGE_MONOTONIC_PWL)
               ? 0
               : 1;
}
