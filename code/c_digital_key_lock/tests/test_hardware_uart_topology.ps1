param(
    [string]$ModuleDir = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
)

$ErrorActionPreference = "Stop"

function Assert-Contains(
    [string]$Text,
    [string]$Pattern,
    [string]$Description
)
{
    if ($Text -notmatch $Pattern) {
        throw "Missing hardware contract: $Description"
    }
}

$SysConfig = Get-Content -LiteralPath (
    Join-Path $ModuleDir "empty.syscfg"
) -Raw
$Hardware = Get-Content -LiteralPath (
    Join-Path $ModuleDir "lock_hw_mspm0.c"
) -Raw

Assert-Contains $SysConfig 'const UWB3\s*=\s*UART\.addInstance\(\);' `
    "UWB3 has its own UART instance"
Assert-Contains $SysConfig 'UWB3\.\$name\s*=\s*"UWB_CH3";' `
    "UWB3 SysConfig name"
Assert-Contains $SysConfig 'UWB3\.peripheral\.\$assign\s*=\s*"UART2";' `
    "UWB3 uses UART2"
Assert-Contains $SysConfig 'UWB3\.peripheral\.txPin\.\$assign\s*=\s*"PB15";' `
    "UWB3 TX uses PB15"
Assert-Contains $SysConfig 'UWB3\.peripheral\.rxPin\.\$assign\s*=\s*"PB16";' `
    "UWB3 RX uses PB16"

Assert-Contains $Hardware '#define HARDWARE_UWB_CHANNEL_COUNT 3U' `
    "three independent hardware receive channels"
Assert-Contains $Hardware 'void UWB_CH3_INST_IRQHandler\(void\)' `
    "UWB3 interrupt handler"
Assert-Contains $Hardware 'capture_uart\(2U,\s*UWB_CH3_INST\);' `
    "UWB3 writes only channel 2 ring buffer"
Assert-Contains $Hardware 'NVIC_EnableIRQ\(UWB_CH3_INST_INT_IRQN\);' `
    "UWB3 IRQ is enabled"

Write-Host "PASS three UWB slaves use independent UART1/UART3/UART2 channels"
