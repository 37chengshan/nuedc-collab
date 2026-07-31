param(
    [string]$Compiler = "gcc"
)

$ErrorActionPreference = "Stop"

function Assert-LastExitCode([string]$Step)
{
    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed with exit code $LASTEXITCODE"
    }
}

$TestDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ModuleDir = Split-Path -Parent $TestDir
$TempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$BuildDir = Join-Path $TempRoot (
    "c_digital_key_lock_tests_" + [Guid]::NewGuid().ToString("N")
)
$ResolvedBuildDir = [IO.Path]::GetFullPath($BuildDir)

if (-not $ResolvedBuildDir.StartsWith(
        $TempRoot,
        [StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Refusing to create test output outside the temporary directory"
}

$CommonSources = @(
    (Join-Path $ModuleDir "id_input.c"),
    (Join-Path $ModuleDir "uwb_text_protocol.c"),
    (Join-Path $ModuleDir "uwb_fusion.c"),
    (Join-Path $ModuleDir "trilateration.c"),
    (Join-Path $ModuleDir "lock_fsm.c"),
    (Join-Path $ModuleDir "lock_app.c"),
    (Join-Path $ModuleDir "lock_app_config.c"),
    (Join-Path $ModuleDir "calibration_model.c"),
    (Join-Path $ModuleDir "calibration_model_data.c"),
    (Join-Path $ModuleDir "empirical_model.c")
)
$CommonFlags = @(
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-pedantic",
    "-I$ModuleDir"
)

New-Item -ItemType Directory -Path $ResolvedBuildDir | Out-Null
try {
    foreach ($Target in @(
        @{
            Name = "legacy"
            TestSource = Join-Path $TestDir "test_lock_logic.c"
        },
        @{
            Name = "calibrated"
            TestSource = Join-Path $TestDir "test_calibrated_lock.c"
        }
    )) {
        $Executable = Join-Path $ResolvedBuildDir ($Target.Name + ".exe")
        & $Compiler @CommonFlags $Target.TestSource @CommonSources `
            "-lm" "-o" $Executable
        Assert-LastExitCode "Compile $($Target.Name) host tests"

        & $Executable
        Assert-LastExitCode "Run $($Target.Name) host tests"
    }
} finally {
    if (Test-Path -LiteralPath $ResolvedBuildDir) {
        $DeleteTarget = [IO.Path]::GetFullPath($ResolvedBuildDir)
        if ($DeleteTarget.StartsWith(
                $TempRoot,
                [StringComparison]::OrdinalIgnoreCase
            )) {
            Remove-Item -LiteralPath $DeleteTarget -Recurse -Force
        }
    }
}
