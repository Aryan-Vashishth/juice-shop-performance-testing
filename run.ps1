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
  Name = 'Node.js v24.21.0'
  Url  ='https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip'
  Hash = 'SHA256:158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'
  Dir  = Join-Path $root 'tools\node-v24.21.0-win-x64'
  Into = Join-Path $root 'tools'
}
$k6 = @{
  Name = 'k6 v2.3.0'
  Url  ='https://github.com/grafana/k6/releases/download/v2.3.0/k6-v2.3.0-windows-amd64.zip'
  Hash = 'SHA256:112276d495e5741c968e2bc09ea6196099c1275bd6db9ee0875d173c7148ce43'
  Dir  = Join-Path $root 'tools\k6-v2.3.0-windows-amd64'
  Into = Join-Path $root 'tools'
}
$juiceShop = @{
  Name = 'Juice Shop v20.3.0'
  Url  ='https://github.com/juice-shop/juice-shop/releases/download/v20.3.0/juice-shop-20.3.0_node24_win32_x64.zip'
  Hash = 'MD5:7add10371c51738e90daa58c6e901809'
  Dir  = Join-Path $root 'app\juice-shop_20.3.0'
  Into = Join-Path $root 'app'
}

# Downloads a zip, checks its hash and unpacks it, unless it's already unpacked.
function Install-Zip($pkg) {
  $relDir = $pkg.Dir.Substring($root.Length + 1)
  if (Test-Path $pkg.Dir) { Write-Log "  $($pkg.Name): already installed ($relDir)"; return }
  $name = Split-Path $pkg.Url -Leaf
  Write-Log "  $($pkg.Name): downloading $name (first run only, no progress shown, may take a few minutes) ..."
  New-Item -ItemType Directory -Force $pkg.Into | Out-Null
  $zip = Join-Path $pkg.Into $name
  $started = Get-Date
  # A dropped connection on a large download shouldn't end the run, so retry a few times.
  for ($attempt = 1; ; $attempt++) {
    try {
      Invoke-WebRequest $pkg.Url -OutFile $zip -UseBasicParsing
      break
    } catch {
      Remove-Item $zip -ErrorAction SilentlyContinue
      if ($attempt -ge 3) { throw "Failed to download $name after 3 attempts: $($_.Exception.Message)" }
      Write-Log "  Download failed, retrying in 5 s (attempt $($attempt + 1) of 3): $($_.Exception.Message)" 'Yellow'
      Start-Sleep -Seconds 5
    }
  }
  Write-Log ("  Downloaded {0:N1} MB in {1:N0} s" -f ((Get-Item $zip).Length / 1MB), ((Get-Date) - $started).TotalSeconds)

  $algorithm, $expected = $pkg.Hash -split ':'
  $actual = (Get-FileHash $zip -Algorithm $algorithm).Hash
  if ($actual -ne $expected) {
    Remove-Item $zip
    throw "Checksum mismatch for $name (expected $expected, got $actual)"
  }
  Write-Log "  Checksum OK ($algorithm)"

  Write-Log "  Unpacking $name ..."
  tar -xf $zip -C $pkg.Into   # much faster than Expand-Archive for Juice Shop's 45,000 files
  if ($LASTEXITCODE -ne 0) { throw "Failed to unpack $name" }
  Remove-Item $zip
  Write-Log "  $($pkg.Name): installed in $relDir"
}

function Format-Duration($span) {
  if ($span.TotalMinutes -ge 1) { '{0}m {1:00}s' -f [int][math]::Floor($span.TotalMinutes), $span.Seconds } else { '{0}s' -f [int]$span.TotalSeconds }
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

$tests = if ($Test -contains 'all') { 'smoke', 'product-search', 'login', 'basket', 'stress' } else { $Test }
foreach ($t in $tests) {
  if (-not (Test-Path (Join-Path $root "scripts\$t.js"))) { throw "No test named '$t' (expected scripts\$t.js)" }
}
# Approximate length of each test, from the stages in its script.
$expectedMinutes = @{ 'smoke' = 0.5; 'product-search' = 4.5; 'login' = 4.5; 'basket' = 4.5; 'stress' = 8 }
$plannedMinutes = ($tests | ForEach-Object { if ($expectedMinutes[$_]) { $expectedMinutes[$_] } else { 0 } } | Measure-Object -Sum).Sum
Write-Log ("Tests: {0} (about {1:0.#} min of testing, plus setup)" -f ($tests -join ', '), $plannedMinutes)

Write-Log "`n[1/3] Setting up tools" 'Cyan'
Install-Zip $k6
$app = $null
Write-Log "`n[2/3] Checking for Juice Shop at $baseUrl" 'Cyan'
if (Test-AppUp) {
  Write-Log "  Juice Shop is already running; using it and leaving it running afterwards."
} else {
  if ($baseUrl -notmatch '^http://(localhost|127\.0\.0\.1):3000/?$') {
    throw "Juice Shop is not reachable at $baseUrl"
  }
  Write-Log "  Not running; it will be started for this run and stopped at the end."
  Install-Zip $node
  Install-Zip $juiceShop

  Write-Log "  Starting Juice Shop in the background (log: logs\$runId\juice-shop.log). This usually takes 20-60 s ..."
  $env:PATH = "$($node.Dir);$env:PATH"
  $app = Start-Process (Join-Path $node.Dir 'node.exe') -ArgumentList 'build/app' `
    -WorkingDirectory $juiceShop.Dir -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput "$logs\juice-shop.log" -RedirectStandardError "$logs\juice-shop.err.log"

  $startedAt = Get-Date
  $deadline = $startedAt.AddSeconds(180)
  $nextNotice = $startedAt.AddSeconds(15)
  while (-not (Test-AppUp)) {
    if ($app.HasExited) { throw "Juice Shop exited during startup; see logs\$runId\juice-shop.err.log" }
    if ((Get-Date) -gt $deadline) { Stop-Process -Id $app.Id -Force; throw "Juice Shop did not start within 180 s" }
    if ((Get-Date) -gt $nextNotice) {
      Write-Log "  Still starting ($(Format-Duration ((Get-Date) - $startedAt)) so far, giving up after 3 min) ..."
      $nextNotice = (Get-Date).AddSeconds(15)
    }
    Start-Sleep -Seconds 2
  }
  Write-Log "  Juice Shop is up at $baseUrl after $(Format-Duration ((Get-Date) - $startedAt))"
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

$runInfo = [ordered]@{
  run_id = $runId; started = (Get-Date).ToString('s'); finished = $null; base_url = $baseUrl
  k6 = 'v2.3.0'; juice_shop = 'v20.3.0'; started_juice_shop = [bool]$app; tests = @()
}

$exitCode = 0
# k6 writes progress and warnings to stderr. With 'Stop', PowerShell 5.1 turns those
# into terminating errors whenever output is redirected, so judge k6 by its exit code.
$ErrorActionPreference = 'Continue'
Write-Log "`n[3/3] Running tests" 'Cyan'
Write-Log "  k6 prints a progress line every few seconds while each test runs; a quiet minute between lines is normal."
$runStart = Get-Date
$i = 0
try {
  foreach ($t in $tests) {
    $i++
    $about = if ($expectedMinutes[$t]) { ", about $($expectedMinutes[$t]) min" } else { '' }
    Write-Log "`n=== $t ($i of $($tests.Count)$about) ===" 'Cyan'
    # k6's built-in web dashboard, saved as an HTML report with time-series graphs.
    $env:K6_WEB_DASHBOARD = 'true'
    $env:K6_WEB_DASHBOARD_PORT = '-1'   # no live server, just the exported file
    $env:K6_WEB_DASHBOARD_EXPORT = "$results\$t-dashboard.html"
    $monitor = Start-ServerMonitor "$results\$t-server-metrics.csv"
    if ($monitor) { Write-Log "  Recording Juice Shop CPU and memory every 2 s to results\$runId\$t-server-metrics.csv" }
    else { Write-Log "  Juice Shop is not on this machine, so its CPU and memory are not recorded." }
    $start = Get-Date
    # 2>&1 merges k6's stderr (progress, warnings) so the whole console output reaches run.log.
    & (Join-Path $k6.Dir 'k6.exe') run --summary-export "$results\$t-summary.json" (Join-Path $root "scripts\$t.js") 2>&1 |
      ForEach-Object { Write-Log "$_" }
    $k6Exit = $LASTEXITCODE
    if ($monitor) { Stop-Job $monitor; Remove-Job $monitor }
    $runInfo.tests += [ordered]@{ test = $t; started = $start.ToString('s'); finished = (Get-Date).ToString('s'); exit_code = $k6Exit }
    $took = Format-Duration ((Get-Date) - $start)
    if ($k6Exit -ne 0) { $exitCode = $k6Exit; Write-Log "${t}: thresholds failed (exit $k6Exit) after $took" 'Red' }
    else { Write-Log "${t}: passed in $took" 'Green' }
  }
}
finally {
  if ($app) {
    Write-Log "`nStopping Juice Shop ..."
    Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
  }
  $runInfo.finished = (Get-Date).ToString('s')
  $runInfo | ConvertTo-Json -Depth 4 | Out-File "$results\run.json" -Encoding ascii

  Write-Log "`n=== Summary ===" 'Cyan'
  foreach ($r in $runInfo.tests) {
    if ($r.exit_code -eq 0) { Write-Log "  PASS  $($r.test)" 'Green' } else { Write-Log "  FAIL  $($r.test) (exit $($r.exit_code))" 'Red' }
  }
  $notRun = @($tests | Where-Object { $_ -notin $runInfo.tests.test })
  if ($notRun.Count) { Write-Log "  Not run: $($notRun -join ', ')" 'Yellow' }
  Write-Log "  Test time: $(Format-Duration ((Get-Date) - $runStart))"
  Write-Log "  Results:   results\$runId\  (open <test>-dashboard.html in a browser for graphs)"
  Write-Log "  Log:       logs\$runId\run.log"
  if ($tests -contains 'stress') {
    Write-Log "  The stress test is expected to exceed its targets at higher request rates; that is what it measures."
  }
}
exit $exitCode
