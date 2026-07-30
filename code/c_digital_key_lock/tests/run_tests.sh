#!/usr/bin/env sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
module_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
compiler=${CC:-cc}
legacy_binary=$(mktemp "${TMPDIR:-/tmp}/c_digital_key_lock_tests.XXXXXX")
calibrated_binary=$(mktemp "${TMPDIR:-/tmp}/c_digital_key_lock_calibrated_tests.XXXXXX")

cleanup() {
    rm -f "$legacy_binary" "$calibrated_binary"
}
trap cleanup EXIT HUP INT TERM

"$compiler" \
    -std=c11 \
    -D_POSIX_C_SOURCE=200809L \
    -Wall -Wextra -Werror -pedantic \
    -I"$module_dir" \
    "$script_dir/test_lock_logic.c" \
    "$module_dir/id_input.c" \
    "$module_dir/uwb_text_protocol.c" \
    "$module_dir/uwb_fusion.c" \
    "$module_dir/trilateration.c" \
    "$module_dir/lock_fsm.c" \
    "$module_dir/lock_app.c" \
    "$module_dir/lock_app_config.c" \
    "$module_dir/calibration_model.c" \
    "$module_dir/calibration_model_data.c" \
    -lm \
    -o "$legacy_binary"

"$legacy_binary"

"$compiler" \
    -std=c11 \
    -D_POSIX_C_SOURCE=200809L \
    -Wall -Wextra -Werror -pedantic \
    -I"$module_dir" \
    "$script_dir/test_calibrated_lock.c" \
    "$module_dir/id_input.c" \
    "$module_dir/uwb_text_protocol.c" \
    "$module_dir/uwb_fusion.c" \
    "$module_dir/trilateration.c" \
    "$module_dir/lock_fsm.c" \
    "$module_dir/lock_app.c" \
    "$module_dir/lock_app_config.c" \
    "$module_dir/calibration_model.c" \
    "$module_dir/calibration_model_data.c" \
    -lm \
    -o "$calibrated_binary"

"$calibrated_binary"
