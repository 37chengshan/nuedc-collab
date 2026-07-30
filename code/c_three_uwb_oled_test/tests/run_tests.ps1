$ErrorActionPreference = "Stop"

$testDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Split-Path -Parent $testDir
$binary = Join-Path $env:TEMP "c_three_uwb_oled_test.exe"
$syscfg = Get-Content -LiteralPath (Join-Path $projectDir "three_uwb_monitor.syscfg") -Raw

if ($syscfg -notmatch 'UWB1\.targetBaudRate\s*=\s*115200') {
    throw "UART1 must use the measured EWT550 baud rate 115200"
}

if ($syscfg -notmatch 'UWB2\.targetBaudRate\s*=\s*115200') {
    throw "UART3 must use the measured EWT550 baud rate 115200"
}

if ($syscfg -notmatch 'UWB1\.peripheral\.rxPin\.\$assign\s*=\s*"PA9"') {
    throw "UART1 RX must use PA9 / A09"
}

if ($syscfg -notmatch 'UWB2\.peripheral\.rxPin\.\$assign\s*=\s*"PA25"') {
    throw "UART3 RX must use PA25 for the board UART3 R header"
}

if ($syscfg -notmatch 'UWB2\.peripheral\.txPin\.\$assign\s*=\s*"PA26"') {
    throw "UART3 TX must use PA26 for the board UART3 T header"
}

if ($syscfg -notmatch 'UWB1\.enabledInterrupts\s*=\s*\["RX"\]') {
    throw "UART1 RX interrupt must protect reception during OLED refresh"
}

if ($syscfg -notmatch 'UWB2\.enabledInterrupts\s*=\s*\["RX"\]') {
    throw "UART3 RX interrupt must protect reception during OLED refresh"
}

if ($syscfg -notmatch 'OLED\.peripheral\.sdaPin\.\$assign\s*=\s*"PB3"') {
    throw "OLED SDA must use PB3"
}

if ($syscfg -notmatch 'OLED\.peripheral\.sclPin\.\$assign\s*=\s*"PB2"') {
    throw "OLED SCL must use PB2"
}

& "C:\msys64\mingw64\bin\gcc.exe" `
    -std=c11 `
    -Wall -Wextra -Werror -pedantic `
    "-I$projectDir" `
    (Join-Path $testDir "test_uwb_monitor.c") `
    (Join-Path $projectDir "uwb_monitor.c") `
    (Join-Path $projectDir "uwb_calibration.c") `
    (Join-Path $projectDir "uwb_position.c") `
    -lm `
    -o $binary

if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

& $binary
exit $LASTEXITCODE
