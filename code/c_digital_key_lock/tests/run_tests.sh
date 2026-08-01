#!/usr/bin/env sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
module_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
compiler=${CC:-cc}
binary=$(mktemp "${TMPDIR:-/tmp}/c_digital_key_lock_tests.XXXXXX")

cleanup() {
    rm -f "$binary"
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
    "$module_dir/uwb_two_station_estimator.c" \
    "$module_dir/two_station_model_data.c" \
    "$module_dir/uwb_fusion.c" \
    "$module_dir/trilateration.c" \
    "$module_dir/lock_fsm.c" \
    "$module_dir/lock_app.c" \
    "$module_dir/lock_app_config.c" \
    "$module_dir/lock_ui.c" \
    -lm \
    -o "$binary"

"$binary"
