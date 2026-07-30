param(
    [string]$SdkDir = "D:\CCCCC\mspm0-sdk-2.10.00.04",
    [string]$CompilerDir = "D:\ti\ccs2020\ccs\tools\compiler\ti-cgt-armllvm_4.0.3.LTS",
    [string]$SysConfigDir = "D:\CCCCC\tools\sysconfig_1.28.0",
    [string]$MainSource = "main.c",
    [string]$OutputName = "c_three_uwb_oled_test"
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
$SharedOledDir = Join-Path (Split-Path -Parent $ProjectDir) "dimengxing_receiver"

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
    --script (Join-Path $ProjectDir "three_uwb_monitor.syscfg") `
    --output $GeneratedDir
Assert-LastExitCode "SysConfig generation"

$CommonFlags = @(
    "-I$ProjectDir",
    "-I$GeneratedDir",
    "-I$SharedOledDir",
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
    "-Wextra"
)

$Sources = @(
    @{ Name = "main"; Source = (Join-Path $ProjectDir $MainSource) },
    @{ Name = "uwb_monitor"; Source = (Join-Path $ProjectDir "uwb_monitor.c") },
    @{ Name = "uwb_calibration"; Source = (Join-Path $ProjectDir "uwb_calibration.c") },
    @{ Name = "uwb_position"; Source = (Join-Path $ProjectDir "uwb_position.c") },
    @{ Name = "oled"; Source = (Join-Path $SharedOledDir "oled.c") },
    @{ Name = "delay"; Source = (Join-Path $SharedOledDir "delay.c") },
    @{
        Name = "startup_mspm0g350x"
        Source = (Join-Path $SdkDir "source\ti\devices\msp\m0p\startup_system_files\ticlang\startup_mspm0g350x_ticlang.c")
    },
    @{ Name = "ti_msp_dl_config"; Source = (Join-Path $GeneratedDir "ti_msp_dl_config.c") }
)

$Objects = @()
foreach ($Unit in $Sources) {
    $ObjectPath = Join-Path $BuildDir ($Unit.Name + ".obj")
    Write-Host "Compiling $($Unit.Name)..."
    & $Compiler @CommonFlags -c $Unit.Source -o $ObjectPath
    Assert-LastExitCode "Compile $($Unit.Name)"
    $Objects += $ObjectPath
}

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

Write-Host "Linking firmware..."
& $Compiler @Objects @LinkFlags -o $OutFile
Assert-LastExitCode "Link"

Write-Host "Creating Intel HEX..."
& $ObjCopy -O ihex $OutFile $HexFile
Assert-LastExitCode "HEX conversion"

Write-Host "Firmware size:"
& $SizeTool $OutFile
Assert-LastExitCode "Size report"

Write-Host "HEX ready: $HexFile"
