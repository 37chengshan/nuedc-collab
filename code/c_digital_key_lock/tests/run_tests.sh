#!/usr/bin/env sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
module_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
compiler=${CC:-cc}
legacy_binary=$(mktemp "${TMPDIR:-/tmp}/c_digital_key_lock_tests.XXXXXX")
calibrated_binary=$(mktemp "${TMPDIR:-/tmp}/c_digital_key_lock_calibrated_tests.XXXXXX")
display_format_binary=$(mktemp "${TMPDIR:-/tmp}/c_digital_key_lock_display_format_tests.XXXXXX")
st7735s_binary=$(mktemp "${TMPDIR:-/tmp}/c_digital_key_lock_st7735s_tests.XXXXXX")
display_ui_binary=$(mktemp "${TMPDIR:-/tmp}/c_digital_key_lock_display_ui_tests.XXXXXX")
output_behavior_binary=$(mktemp "${TMPDIR:-/tmp}/c_digital_key_lock_output_behavior_tests.XXXXXX")
distance_stabilizer_binary=$(mktemp "${TMPDIR:-/tmp}/c_digital_key_lock_distance_stabilizer_tests.XXXXXX")

cleanup() {
    rm -f "$legacy_binary" "$calibrated_binary" \
        "$display_format_binary" "$st7735s_binary" "$display_ui_binary" \
        "$output_behavior_binary" "$distance_stabilizer_binary"
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

"$compiler" \
    -std=c11 \
    -D_POSIX_C_SOURCE=200809L \
    -Wall -Wextra -Werror -pedantic \
    -I"$module_dir" \
    "$script_dir/test_lock_display_format.c" \
    "$module_dir/lock_display_format.c" \
    -lm \
    -o "$display_format_binary"

"$display_format_binary"

"$compiler" \
    -std=c11 \
    -D_POSIX_C_SOURCE=200809L \
    -Wall -Wextra -Werror -pedantic \
    -I"$module_dir" \
    "$script_dir/test_st7735s.c" \
    "$module_dir/st7735s.c" \
    -lm \
    -o "$st7735s_binary"

"$st7735s_binary"

"$compiler" \
    -std=c11 \
    -D_POSIX_C_SOURCE=200809L \
    -Wall -Wextra -Werror -pedantic \
    -I"$module_dir" \
    "$script_dir/test_lock_display_ui.c" \
    "$module_dir/st7735s.c" \
    "$module_dir/lock_display_format.c" \
    "$module_dir/lock_display_ui.c" \
    -lm \
    -o "$display_ui_binary"

"$display_ui_binary"

"$compiler" \
    -std=c11 \
    -D_POSIX_C_SOURCE=200809L \
    -Wall -Wextra -Werror -pedantic \
    -I"$module_dir" \
    "$script_dir/test_lock_output_behavior.c" \
    "$module_dir/lock_output_behavior.c" \
    -o "$output_behavior_binary"

"$output_behavior_binary"

"$compiler" \
    -std=c11 \
    -D_POSIX_C_SOURCE=200809L \
    -Wall -Wextra -Werror -pedantic \
    -I"$module_dir" \
    "$script_dir/test_lock_distance_stabilizer.c" \
    "$module_dir/lock_distance_stabilizer.c" \
    -lm \
    -o "$distance_stabilizer_binary"

"$distance_stabilizer_binary"
