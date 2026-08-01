#!/usr/bin/env sh

set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sdk_dir=${MSPM0_SDK_DIR:-/Users/cc/Downloads/mspm0_sdk_2_10_00_04.zip/mspm0_sdk_2_10_00_04}
ccs_dir=${CCS_DIR:-/Applications/ti/ccs2100/ccs}
compiler_dir=${TI_ARMLLVM_DIR:-$ccs_dir/tools/compiler/ti-cgt-armllvm_5.1.1.LTS}
sysconfig_dir=${SYSCONFIG_DIR:-$ccs_dir/utils/sysconfig_1.28.0}
variant=${1:-Full}

case "$variant" in
    ScreenDemo)
        output_name=c_digital_key_lock_190mm_l1_screen
        firmware_level=4
        sources="screen_demo_main.c lock_hw_mspm0.c st7735s.c lock_display_format.c lock_display_ui.c lock_output_behavior.c"
        ;;
    Monitor)
        output_name=c_digital_key_lock_190mm_l2_monitor
        firmware_level=2
        ;;
    Identity)
        output_name=c_digital_key_lock_190mm_l3_identity
        firmware_level=3
        ;;
    Full)
        output_name=c_digital_key_lock_190mm_four_uwb_full
        firmware_level=4
        ;;
    *)
        echo "Usage: $0 [ScreenDemo|Monitor|Identity|Full]" >&2
        exit 2
        ;;
esac

sysconfig_cli=$sysconfig_dir/sysconfig_cli.sh
compiler=$compiler_dir/bin/tiarmclang
objcopy=$compiler_dir/bin/tiarmobjcopy
size_tool=$compiler_dir/bin/tiarmsize
cd "$project_dir"
generated_dir=generated_190mm
build_dir=build_190mm/$variant

for required in "$sysconfig_cli" "$compiler" "$objcopy" "$size_tool" \
    "$sdk_dir/.metadata/product.json"; do
    if [ ! -e "$required" ]; then
        echo "Required tool or file not found: $required" >&2
        exit 1
    fi
done

mkdir -p "$generated_dir" "$build_dir"
"$sysconfig_cli" \
    --compiler ticlang \
    --product "$sdk_dir/.metadata/product.json" \
    --device MSPM0G3507 \
    --package "LQFP-64(PM)" \
    --script "empty.syscfg" \
    --output "$generated_dir" \
    --treatWarningsAsErrors

if [ "$variant" != "ScreenDemo" ]; then
    sources="main.c id_input.c uwb_text_protocol.c uwb_fusion.c lock_distance_stabilizer.c trilateration.c lock_fsm.c lock_app.c lock_app_config.c calibration_model.c calibration_model_data.c empirical_model.c empirical_model_data.c uwb_four_station_estimator.c four_station_model_data.c lock_hw_mspm0.c st7735s.c lock_display_format.c lock_display_ui.c lock_output_behavior.c"
fi

objects=
for source in $sources; do
    object="$build_dir/${source%.c}.obj"
    "$compiler" \
        -I. \
        -I"$generated_dir" \
        -I"$sdk_dir/source/third_party/CMSIS/Core/Include" \
        -I"$sdk_dir/source" \
        @"$generated_dir/device.opt" \
        -DLOCK_FIRMWARE_LEVEL="$firmware_level" \
        -O2 -gdwarf-3 -mcpu=cortex-m0plus -march=thumbv6m \
        -mfloat-abi=soft -mthumb -Wall -Wextra -Werror \
        -c "$source" -o "$object"
    objects="$objects $object"
done

startup_object=$build_dir/startup_mspm0g350x.obj
"$compiler" \
    -I. \
    -I"$generated_dir" \
    -I"$sdk_dir/source/third_party/CMSIS/Core/Include" \
    -I"$sdk_dir/source" \
    @"$generated_dir/device.opt" \
    -O2 -gdwarf-3 -mcpu=cortex-m0plus -march=thumbv6m \
    -mfloat-abi=soft -mthumb -Wall -Wextra -Werror \
    -c "$sdk_dir/source/ti/devices/msp/m0p/startup_system_files/ticlang/startup_mspm0g350x_ticlang.c" \
    -o "$startup_object"
objects="$objects $startup_object"

generated_object=$build_dir/ti_msp_dl_config.obj
"$compiler" \
    -I. \
    -I"$generated_dir" \
    -I"$sdk_dir/source/third_party/CMSIS/Core/Include" \
    -I"$sdk_dir/source" \
    @"$generated_dir/device.opt" \
    -O2 -gdwarf-3 -mcpu=cortex-m0plus -march=thumbv6m \
    -mfloat-abi=soft -mthumb -Wall -Wextra -Werror \
    -c "$generated_dir/ti_msp_dl_config.c" -o "$generated_object"
objects="$objects $generated_object"

out_file=$build_dir/$output_name.out
map_file=$build_dir/$output_name.map
hex_file=$build_dir/$output_name.hex

# shellcheck disable=SC2086
"$compiler" $objects \
    -Wl,-u,_c_int00 \
    -L"$generated_dir" \
    -L"$sdk_dir/source" \
    "$generated_dir/device_linker.cmd" \
    -ldevice.cmd.genlibs \
    -Wl,-m,"$map_file" \
    -Wl,--rom_model \
    -Wl,--warn_sections \
    -L"$compiler_dir/lib" \
    -llibc.a \
    -o "$out_file"

"$objcopy" -O ihex "$out_file" "$hex_file"
"$size_tool" "$out_file"
echo "HEX ready: $hex_file"
