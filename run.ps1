# Usage: .\run.ps1 smoke    (runs scripts\smoke.js and saves a summary to results\)
param([Parameter(Mandatory)][string]$Test)

$k6 = Join-Path $PSScriptRoot 'tools\k6-v2.3.0-windows-amd64\k6.exe'
$script = Join-Path $PSScriptRoot "scripts\$Test.js"
$results = Join-Path $PSScriptRoot 'results'
New-Item -ItemType Directory -Force $results | Out-Null

& $k6 run --summary-export "$results\$Test-summary.json" $script
exit $LASTEXITCODE
