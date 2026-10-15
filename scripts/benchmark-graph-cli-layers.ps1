param(
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
  [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$cliPath = Join-Path $RepoRoot "packages/data-graph/src/asset-graph/cli.ts"
$tsxLoader = Join-Path $RepoRoot "node_modules/tsx/dist/loader.mjs"
if (-not (Test-Path $tsxLoader)) {
  throw "tsx loader missing; run npm run prepare:deps"
}

function Measure-Node {
  param([string[]]$NodeArgs, [string]$Label, [string]$ExpectedCommand)
  # Native stderr can become ErrorRecord objects in Windows PowerShell.
  # Capture it separately from JSON; do not expose raw diagnostics or connection details.
  $ErrorActionPreference = "Continue"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $captured = @(& node @NodeArgs 2>&1)
  $code = $LASTEXITCODE
  $sw.Stop()
  $payload = $null
  $status = if ($code -eq 0) { "ok" } else { "process-failed" }
  $mainMs = $null
  if ($ExpectedCommand) {
    try {
      $stdout = ($captured | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
      $payload = $stdout | ConvertFrom-Json -ErrorAction Stop
      if ($payload.ok -ne $true -or $code -ne 0) {
        $status = "cli-failed"
      } elseif (($ExpectedCommand -eq "help" -and $payload.name -ne "lineage-graph") -or
                ($ExpectedCommand -ne "help" -and $payload.command -ne $ExpectedCommand)) {
        $status = "unexpected-response"
      }
      if ($status -eq "ok" -and $ExpectedCommand -ne "help") {
        $mainMs = $payload.meta.elapsedMs
        if ($mainMs -isnot [ValueType] -or $mainMs -lt 0) {
          throw "INVALID_ELAPSED_MS"
        }
      }
    } catch {
      $status = "invalid-response"
      $mainMs = $null
    }
  }
  [PSCustomObject]@{
    label = $Label
    outerMs = [math]::Round($sw.Elapsed.TotalMilliseconds)
    mainMs = $mainMs
    exitCode = $code
    status = $status
  }
}

function Invoke-NodeCli {
  param([string[]]$CliArgs, [string]$Label)
  Measure-Node -NodeArgs (@("--import", ([System.Uri]$tsxLoader).AbsoluteUri, $cliPath) + $CliArgs) -Label $Label -ExpectedCommand $CliArgs[0]
}

$sw = [Diagnostics.Stopwatch]::StartNew()
& { }
$sw.Stop()
$results = @(
  [PSCustomObject]@{ label = "empty-powershell-block"; outerMs = [math]::Round($sw.Elapsed.TotalMilliseconds); mainMs = $null; exitCode = $null; status = "ok" }
  Measure-Node -NodeArgs @("-e", "process.exit(0)") -Label "node-empty"
  Measure-Node -NodeArgs @("--import", ([System.Uri]$tsxLoader).AbsoluteUri, "-e", "console.log('ok')") -Label "node-tsx-echo"
  Invoke-NodeCli -CliArgs @("help") -Label "cli-help"
  Invoke-NodeCli -CliArgs @("trace", "--task-id", "159763", "--column", "index_val", "--layer", "field", "--direction", "up", "--depth", "2", "--limit", "20") -Label "cli-trace"
)

if ($Json) {
  $results | ConvertTo-Json -Depth 4
} else {
  $results | Format-Table label, outerMs, mainMs, exitCode, status -AutoSize
  Write-Host "outerMs starts inside this PowerShell session and includes child process shutdown."
  Write-Host "mainMs is the successful CLI response's meta.elapsedMs from that same invocation."
  Write-Host "Caller/tool/shell startup before this script is excluded; record caller wall separately."
  Write-Host "Non-ok rows are failed measurements, not successful trace timings."
}
if (@($results | Where-Object { $_.status -ne "ok" }).Count -gt 0) { exit 1 }
