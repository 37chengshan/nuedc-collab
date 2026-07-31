param(
    [ValidateSet("All", "App", "ScreenDemo", "Monitor", "Identity", "Full")]
    [string]$Variant = "App",
    [string]$SdkDir = "D:\CCCCC\mspm0-sdk-2.10.00.04",
    [string]$CompilerDir = "D:\ti\ccs2020\ccs\tools\compiler\ti-cgt-armllvm_4.0.3.LTS",
    [string]$SysConfigDir = "D:\CCCCC\tools\sysconfig_1.28.0"
)

$ErrorActionPreference = "Stop"

function Assert-LastExitCode([string]$Step)
{
    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed with exit code $LASTEXITCODE"
    }
}

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$GeneratedDir = Join-Path $ProjectDir "generated"
$BuildDir = Join-Path $ProjectDir "build"

if ($Variant -eq "All") {
    foreach ($ChildVariant in @("ScreenDemo", "Monitor", "Identity", "Full")) {
        & $PSCommandPath `
            -Variant $ChildVariant `
            -SdkDir $SdkDir `
            -CompilerDir $CompilerDir `
            -SysConfigDir $SysConfigDir
        Assert-LastExitCode "Build $ChildVariant"
    }
    return
}

$OutputName = switch ($Variant) {
    "ScreenDemo" { "c_digital_key_lock_l1_screen" }
    "Monitor" { "c_digital_key_lock_l2_monitor" }
    "Identity" { "c_digital_key_lock_l3_identity" }
    "Full" { "c_digital_key_lock_l4_full" }
    default { "c_digital_key_lock" }
}
$ObjectPrefix = $Variant.ToLowerInvariant()
$FirmwareLevel = switch ($Variant) {
    "Monitor" { 2 }
    "Identity" { 3 }
    default { 4 }
}
$SysConfigCli = Join-Path $SysConfigDir "sysconfig_cli.bat"
$Compiler = Join-Path $CompilerDir "bin\tiarmclang.exe"
$ObjCopy = Join-Path $CompilerDir "bin\tiarmobjcopy.exe"
$SizeTool = Join-Path $CompilerDir "bin\tiarmsize.exe"

foreach ($RequiredPath in @(
    $SysConfigCli,
    $Compiler,
    $ObjCopy,
    (Join-Path $SdkDir ".metadata\product.json")
)) {
    if (-not (Test-Path -LiteralPath $RequiredPath)) {
        throw "Required tool or file not found: $RequiredPath"
    }
}

New-Item -ItemType Directory -Force $GeneratedDir | Out-Null
New-Item -ItemType Directory -Force $BuildDir | Out-Null

Write-Host "Generating SysConfig files..."
& $SysConfigCli `
    --compiler ticlang `
    --product (Join-Path $SdkDir ".metadata\product.json") `
    --device MSPM0G3507 `
    --package "LQFP-64(PM)" `
    --script (Join-Path $ProjectDir "empty.syscfg") `
    --output $GeneratedDir `
    --treatWarningsAsErrors
Assert-LastExitCode "SysConfig generation"

$CommonFlags = @(
    "-I$ProjectDir",
    "-I$GeneratedDir",
    "-I$(Join-Path $SdkDir 'source\third_party\CMSIS\Core\Include')",
    "-I$(Join-Path $SdkDir 'source')",
    "@$(Join-Path $GeneratedDir 'device.opt')",
    "-O2",
    "-gdwarf-3",
    "-mcpu=cortex-m0plus",
    "-march=thumbv6m",
    "-mfloat-abi=soft",
    "-mthumb",
    "-Wall",
    "-Wextra",
    "-Werror"
)
if ($Variant -ne "ScreenDemo") {
    $CommonFlags += "-DLOCK_FIRMWARE_LEVEL=$FirmwareLevel"
}

$SharedDisplaySources = @(
    "lock_hw_mspm0.c",
    "st7735s.c",
    "lock_display_format.c",
    "lock_display_ui.c",
    "lock_output_behavior.c"
)

$AppSources = @(
    "main.c",
    "id_input.c",
    "uwb_text_protocol.c",
    "uwb_fusion.c",
    "lock_distance_stabilizer.c",
    "trilateration.c",
    "lock_fsm.c",
    "lock_app.c",
    "lock_app_config.c",
    "calibration_model.c",
    "calibration_model_data.c",
    "empirical_model.c",
    "empirical_model_data.c"
)

$DemoSources = @(
    "screen_demo_main.c"
)

$Sources = $SharedDisplaySources + $(if ($Variant -eq "ScreenDemo") {
    $DemoSources
} else {
    $AppSources
})

$Objects = @()
foreach ($SourceName in $Sources) {
    $ObjectPath = Join-Path $BuildDir (
        $ObjectPrefix + "_" +
        [IO.Path]::GetFileNameWithoutExtension($SourceName) + ".obj"
    )
    Write-Host "Compiling $SourceName..."
    & $Compiler @CommonFlags -c (Join-Path $ProjectDir $SourceName) -o $ObjectPath
    Assert-LastExitCode "Compile $SourceName"
    $Objects += $ObjectPath
}

$StartupObject = Join-Path $BuildDir (
    $ObjectPrefix + "_startup_mspm0g350x.obj"
)
& $Compiler @CommonFlags -c `
    (Join-Path $SdkDir "source\ti\devices\msp\m0p\startup_system_files\ticlang\startup_mspm0g350x_ticlang.c") `
    -o $StartupObject
Assert-LastExitCode "Compile startup"
$Objects += $StartupObject

$GeneratedObject = Join-Path $BuildDir (
    $ObjectPrefix + "_ti_msp_dl_config.obj"
)
& $Compiler @CommonFlags -c (Join-Path $GeneratedDir "ti_msp_dl_config.c") `
    -o $GeneratedObject
Assert-LastExitCode "Compile generated configuration"
$Objects += $GeneratedObject

$OutFile = Join-Path $BuildDir ($OutputName + ".out")
$MapFile = Join-Path $BuildDir ($OutputName + ".map")
$HexFile = Join-Path $BuildDir ($OutputName + ".hex")
$LinkFlags = @(
    "-Wl,-u,_c_int00",
    "-L$GeneratedDir",
    "-L$(Join-Path $SdkDir 'source')",
    (Join-Path $GeneratedDir "device_linker.cmd"),
    "-ldevice.cmd.genlibs",
    "-Wl,-m,$MapFile",
    "-Wl,--rom_model",
    "-Wl,--warn_sections",
    "-L$(Join-Path $CompilerDir 'lib')",
    "-llibc.a"
)

Write-Host "Linking $Variant firmware..."
& $Compiler @Objects @LinkFlags -o $OutFile
Assert-LastExitCode "Link"

Write-Host "Creating Intel HEX..."
& $ObjCopy -O ihex $OutFile $HexFile
Assert-LastExitCode "HEX conversion"

Write-Host "Firmware size:"
& $SizeTool $OutFile
Assert-LastExitCode "Size report"
Write-Host "HEX ready: $HexFile"
