#!/usr/bin/env sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
module_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
compiler=${CC:-cc}
build_dir=$(mktemp -d "${TMPDIR:-/tmp}/c_digital_key_lock_tests.XXXXXX")

cleanup() {
    rm -rf "$build_dir"
}
trap cleanup EXIT HUP INT TERM

compile_and_run() {
    name=$1
    shift
    binary="$build_dir/$name"
    "$compiler" \
        -std=c11 \
        -D_POSIX_C_SOURCE=200809L \
        -Wall -Wextra -Werror -pedantic \
        -I"$module_dir" \
        "$@" \
        -lm \
        -o "$binary"
    "$binary"
}

compile_logic_test() {
    name=$1
    test_source=$2
    compile_and_run "$name" \
        "$test_source" \
        "$module_dir/id_input.c" \
        "$module_dir/uwb_text_protocol.c" \
        "$module_dir/uwb_fusion.c" \
        "$module_dir/lock_distance_stabilizer.c" \
        "$module_dir/trilateration.c" \
        "$module_dir/lock_fsm.c" \
        "$module_dir/lock_app.c" \
        "$module_dir/lock_app_config.c" \
        "$module_dir/calibration_model.c" \
        "$module_dir/calibration_model_data.c" \
        "$module_dir/empirical_model.c" \
        "$module_dir/empirical_model_data.c"
}

compile_logic_test legacy "$script_dir/test_lock_logic.c"
compile_logic_test calibrated "$script_dir/test_calibrated_lock.c"

compile_and_run display_format \
    "$script_dir/test_lock_display_format.c" \
    "$module_dir/lock_display_format.c"

compile_and_run st7735s \
    "$script_dir/test_st7735s.c" \
    "$module_dir/st7735s.c"

compile_and_run display_ui \
    "$script_dir/test_lock_display_ui.c" \
    "$module_dir/st7735s.c" \
    "$module_dir/lock_display_format.c" \
    "$module_dir/lock_display_ui.c"

compile_and_run output_behavior \
    "$script_dir/test_lock_output_behavior.c" \
    "$module_dir/lock_output_behavior.c"

compile_and_run distance_stabilizer \
    "$script_dir/test_lock_distance_stabilizer.c" \
    "$module_dir/lock_distance_stabilizer.c"
