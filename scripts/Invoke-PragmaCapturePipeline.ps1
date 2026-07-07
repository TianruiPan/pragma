[CmdletBinding()]
param(
  [Parameter()]
  [string]$InputPath,

  [Parameter(Mandatory = $true)]
  [string]$Repo,

  [Parameter()]
  [string]$CliRepo,

  [Parameter(Mandatory = $true)]
  [int]$Issue,

  [Parameter()]
  [int]$ThresholdMb = 20,

  [Parameter()]
  [switch]$Force,

  [Parameter()]
  [switch]$PreflightOnly,

  [Parameter()]
  [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($CliRepo)) {
  $scriptRoot = Split-Path -Parent $PSCommandPath
  $CliRepo = (Resolve-Path -LiteralPath (Join-Path $scriptRoot "..")).Path
}

$cli = Join-Path $CliRepo "src\cli.js"
if (-not (Test-Path -LiteralPath $cli)) {
  Write-Error "Pragma CLI was not found: $cli"
  exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js was not found on PATH."
  exit 1
}

$arguments = @(
  $cli,
  "design", "pack-latest-capture",
  "--repo", $Repo,
  "--issue", [string]$Issue,
  "--threshold-mb", [string]$ThresholdMb
)
if (-not [string]::IsNullOrWhiteSpace($InputPath)) {
  $arguments += @("--input", $InputPath)
}
if ($Force) { $arguments += "--force" }
if ($PreflightOnly) { $arguments += "--preflight-only" }
if ($Json) { $arguments += "--json" }

& node @arguments
exit $LASTEXITCODE
