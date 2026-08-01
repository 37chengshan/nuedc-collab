#!/usr/bin/env sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
module_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
compiler=${CC:-cc}
binary=$(mktemp "${TMPDIR:-/tmp}/two_station_estimator_tests.XXXXXX")

cleanup() {
    rm -f "$binary"
}
trap cleanup EXIT HUP INT TERM

"$compiler" \
    -std=c11 \
    -Wall -Wextra -Werror -pedantic \
    -I"$module_dir" \
    "$script_dir/test_two_station_estimator.c" \
    "$module_dir/uwb_two_station_estimator.c" \
    "$module_dir/two_station_model_data.c" \
    -o "$binary"

"$binary"
