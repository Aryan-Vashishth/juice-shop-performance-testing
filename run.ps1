# Usage: .\run.ps1 <test>   e.g. .\run.ps1 smoke   (runs scripts\<test>.js; results go to results\)
#        .\run.ps1 all      (runs smoke, product-search, login, basket and stress in order)
#        .\run.ps1 login,basket   (runs several tests in one run)
#
# First run downloads Node.js, Juice Shop and k6 into this folder (about 190 MB).
# If Juice Shop isn't already running on BASE_URL, it is started for the test and stopped afterwards.
param([Parameter(Mandatory)][string[]]$Test)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar on
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = $PSScriptRoot
$baseUrl = if ($env:BASE_URL) { $env:BASE_URL } else { 'http://localhost:3000' }

$node = @{
  Url  = 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip'
  Hash = 'SHA256:158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'
  Dir  = Join-Path $root 'tools\node-v24.21.0-win-x64'
  Into = Join-Path $root 'tools'
}
$k6 = @{
  Url  = 'https://github.com/grafana/k6/releases/download/v2.3.0/k6-v2.3.0-windows-amd64.zip'
  Hash = 'SHA256:112276d495e5741c968e2bc09ea6196099c1275bd6db9ee0875d173c7148ce43'
  Dir  = Join-Path $root 'tools\k6-v2.3.0-windows-amd64'
  Into = Join-Path $root 'tools'
}
$juiceShop = @{
  Url  = 'https://github.com/juice-shop/juice-shop/releases/download/v20.3.0/juice-shop-20.3.0_node24_win32_x64.zip'
  Hash = 'MD5:7add10371c51738e90daa58c6e901809'
  Dir  = Join-Path $root 'app\juice-shop_20.3.0'
  Into = Join-Path $root 'app'
}

# Downloads a zip, checks its hash and unpacks it, unless it's already unpacked.
function Install-Zip($pkg) {
  if (Test-Path $pkg.Dir) { return }
  $name = Split-Path $pkg.Url -Leaf
  Write-Host "Downloading $name ..."
  New-Item -ItemType Directory -Force $pkg.Into | Out-Null
  $zip = Join-Path $pkg.Into $name
  Invoke-WebRequest $pkg.Url -OutFile $zip -UseBasicParsing

  $algorithm, $expected = $pkg.Hash -split ':'
  $actual = (Get-FileHash $zip -Algorithm $algorithm).Hash
  if ($actual -ne $expected) {
    Remove-Item $zip
    throw "Checksum mismatch for $name (expected $expected, got $actual)"
  }

  Write-Host "Unpacking $name ..."
  tar -xf $zip -C $pkg.Into   # much faster than Expand-Archive for Juice Shop's 45,000 files
  if ($LASTEXITCODE -ne 0) { throw "Failed to unpack $name" }
  Remove-Item $zip
}

function Test-AppUp {
  try { (Invoke-WebRequest "$baseUrl/rest/admin/application-version" -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200 }
  catch { $false }
}

# Every run gets its own folders, named by start time: results\<run>\ and logs\<run>\
$runId = Get-Date -Format 'yyyy-MM-dd_HH-mm-ss'
$results = Join-Path $root "results\$runId"
$logs = Join-Path $root "logs\$runId"
New-Item -ItemType Directory -Force $results, $logs | Out-Null
$runLog = Join-Path $logs 'run.log'

# Prints a line and also appends it to logs\<run>\run.log.
function Write-Log($message, $color = 'Gray') {
  Write-Host $message -ForegroundColor $color
  Add-Content $runLog $message -Encoding utf8
}
Write-Log "Run $runId  (results\$runId, logs\$runId)" 'Cyan'

Install-Zip $k6
$app = $null
if (-not (Test-AppUp)) {
  if ($baseUrl -notmatch '^http://(localhost|127\.0\.0\.1):3000/?$') {
    throw "Juice Shop is not reachable at $baseUrl"
  }
  Install-Zip $node
  Install-Zip $juiceShop

  Write-Log "Starting Juice Shop (log: logs\$runId\juice-shop.log) ..."
  $env:PATH = "$($node.Dir);$env:PATH"
  $app = Start-Process (Join-Path $node.Dir 'node.exe') -ArgumentList 'build/app' `
    -WorkingDirectory $juiceShop.Dir -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput "$logs\juice-shop.log" -RedirectStandardError "$logs\juice-shop.err.log"

  $deadline = (Get-Date).AddSeconds(180)
  while (-not (Test-AppUp)) {
    if ($app.HasExited) { throw "Juice Shop exited during startup; see logs\$runId\juice-shop.err.log" }
    if ((Get-Date) -gt $deadline) { Stop-Process -Id $app.Id -Force; throw "Juice Shop did not start within 180 s" }
    Start-Sleep -Seconds 2
  }
  Write-Log "Juice Shop is up at $baseUrl"
}

# Records Juice Shop's CPU (100% = one full core) and memory every 2 s while a test runs.
# Only possible when Juice Shop runs on this machine.
function Start-ServerMonitor($csv) {
  $appPid = if ($app) { $app.Id } else {
    $port = ([uri]$baseUrl).Port
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess
  }
  if (-not $appPid) { return $null }
  Start-Job -ArgumentList $appPid, $csv -ScriptBlock {
    param($appPid, $csv)
    'elapsed_s,cpu_pct,mem_mb' | Out-File $csv -Encoding ascii
    $start = Get-Date
    $prev = (Get-Process -Id $appPid).TotalProcessorTime
    $prevTime = $start
    while ($true) {
      Start-Sleep -Seconds 2
      $p = Get-Process -Id $appPid -ErrorAction SilentlyContinue
      if (-not $p) { break }
      $now = Get-Date
      $cpu = ($p.TotalProcessorTime - $prev).TotalSeconds / ($now - $prevTime).TotalSeconds * 100
      $prev = $p.TotalProcessorTime; $prevTime = $now
      '{0},{1},{2}' -f [math]::Round(($now - $start).TotalSeconds), [math]::Round($cpu, 1), [math]::Round($p.WorkingSet64 / 1MB) |
        Out-File $csv -Append -Encoding ascii
    }
  }
}

$tests = if ($Test -contains 'all') { 'smoke', 'product-search', 'login', 'basket', 'stress' } else { $Test }
foreach ($t in $tests) {
  if (-not (Test-Path (Join-Path $root "scripts\$t.js"))) { throw "No test named '$t' (expected scripts\$t.js)" }
}
$runInfo = [ordered]@{
  run_id = $runId; started = (Get-Date).ToString('s'); finished = $null; base_url = $baseUrl
  k6 = 'v2.3.0'; juice_shop = 'v20.3.0'; started_juice_shop = [bool]$app; tests = @()
}

$exitCode = 0
# k6 writes progress and warnings to stderr. With 'Stop', PowerShell 5.1 turns those
# into terminating errors whenever output is redirected, so judge k6 by its exit code.
$ErrorActionPreference = 'Continue'
try {
  foreach ($t in $tests) {
    Write-Log "`n=== $t ===" 'Cyan'
    # k6's built-in web dashboard, saved as an HTML report with time-series graphs.
    $env:K6_WEB_DASHBOARD = 'true'
    $env:K6_WEB_DASHBOARD_PORT = '-1'   # no live server, just the exported file
    $env:K6_WEB_DASHBOARD_EXPORT = "$results\$t-dashboard.html"
    $monitor = Start-ServerMonitor "$results\$t-server-metrics.csv"
    $start = Get-Date
    # 2>&1 merges k6's stderr (progress, warnings) so the whole console output reaches run.log.
    & (Join-Path $k6.Dir 'k6.exe') run --summary-export "$results\$t-summary.json" (Join-Path $root "scripts\$t.js") 2>&1 |
      ForEach-Object { Write-Log "$_" }
    $k6Exit = $LASTEXITCODE
    if ($monitor) { Stop-Job $monitor; Remove-Job $monitor }
    $runInfo.tests += [ordered]@{ test = $t; started = $start.ToString('s'); finished = (Get-Date).ToString('s'); exit_code = $k6Exit }
    if ($k6Exit -ne 0) { $exitCode = $k6Exit; Write-Log "${t}: thresholds failed (exit $k6Exit)" 'Red' }
  }
}
finally {
  if ($app) {
    Write-Log "Stopping Juice Shop ..."
    Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
  }
  $runInfo.finished = (Get-Date).ToString('s')
  $runInfo | ConvertTo-Json -Depth 4 | Out-File "$results\run.json" -Encoding ascii
  Write-Log "Results saved to results\$runId"
}
exit $exitCode
