#!/usr/bin/env sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
binary=$(mktemp "${TMPDIR:-/tmp}/uwb4_capture_parser.XXXXXX")

trap 'rm -f "$binary"' EXIT HUP INT TERM

${CC:-cc} -std=c11 -Wall -Wextra -Werror -pedantic \
    -I"$project_dir" \
    "$script_dir/test_uwb_capture_parser.c" \
    "$project_dir/uwb_capture_parser.c" \
    -o "$binary"

"$binary"
