# Builds docs\scenarios\performance-test-scenarios.xlsx from the scenario definitions below
# and fills the "Actual" columns from the newest results\<run>\<test>-summary.json for each
# test. Needs Microsoft Excel.
# Usage: powershell -ExecutionPolicy Bypass -File docs\build-scenario-sheet.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$outFile = Join-Path $root 'docs\scenarios\performance-test-scenarios.xlsx'
New-Item -ItemType Directory -Force (Split-Path $outFile) | Out-Null

$runs = Get-ChildItem (Join-Path $root 'results') -Directory | Sort-Object Name -Descending
function Get-Summary($test) {
  $run = $runs | Where-Object { Test-Path (Join-Path $_.FullName "$test-summary.json") } | Select-Object -First 1
  if ($run) { Get-Content (Join-Path $run.FullName "$test-summary.json") -Raw | ConvertFrom-Json } else { $null }
}
function Get-Metric($summary, $name) {
  if (-not $summary) { return $null }
  $summary.metrics.PSObject.Properties | Where-Object Name -eq $name | ForEach-Object Value
}
function Format-Ms($v) { if ($null -eq $v) { 'not run' } else { '{0:N1} ms' -f $v } }

$environment = @(
  @('Hardware', 'Laptop: Intel Core i5-1235U (10 cores / 12 threads), 39.7 GB RAM, Samsung NVMe SSD'),
  @('Operating system', 'Windows 11 Pro (build 26200)'),
  @('Application', 'OWASP Juice Shop v20.3.0, default configuration, SQLite database, single Node.js process'),
  @('Runtime', 'Node.js v24.21.0'),
  @('Load tool', 'k6 v2.3.0 (see docs\tool-selection.md)'),
  @('Network', 'Loopback (http://localhost:3000). No added latency or bandwidth limits; network time is close to zero, so results show server time.'),
  @('Topology', 'App and load generator on the same machine and competing for CPU (see Limitations in the report)'),
  @('Monitoring', 'k6 metrics and HTML dashboard per run; Juice Shop CPU and memory sampled every 2 s into results\server-metrics.csv')
)

$modules = @(
  @{
    Sheet = 'Product Search'; Test = 'product-search'; Script = 'scripts\product-search.js'
    Objective = 'Confirm that anonymous catalogue browsing (keyword search, empty search results and product details) stays fast and error-free under 50 concurrent shoppers.'
    Load = 'ramping-vus: 0 to 50 users over 1 min, hold 50 users for 3 min, ramp down over 30 s (4 min 30 s total). Think time 1-3 s per iteration.'
    Data = 'data\search-terms.json: 24 terms that match products and 5 that match nothing, chosen at random per request. Product IDs read from the live catalogue in setup (46 products).'
    Steps = "1. Start Juice Shop (run.ps1 does this if needed).`n2. Run .\run.ps1 product-search.`n3. setup() reads the product list.`n4. Each user repeats: pick a request type by the workload split, send it, check the response, pause 1-3 s.`n5. Review the terminal summary, results\product-search-summary.json and results\product-search-dashboard.html."
    Metrics = 'Response time (avg, median, p90, p95, max) per request type; throughput (requests/s); error rate (http_req_failed); check pass rate; Juice Shop CPU and memory.'
    Other = 'No login needed. Search is GET /rest/products/search?q=<term>, which runs a LIKE query against the Products table.'
    Cases = @(
      @{ Id = 'PS-01'; Name = 'Keyword search that finds products'; Request = 'GET /rest/products/search?q=<hit>'; Mix = '70%'; Tag = 'search'
         Expected = 'HTTP 200, at least 1 product; p95 < 500 ms' },
      @{ Id = 'PS-02'; Name = 'Search with no results'; Request = 'GET /rest/products/search?q=<miss>'; Mix = '10%'; Tag = 'search (no match)'
         Expected = 'HTTP 200, empty list; p95 < 500 ms' },
      @{ Id = 'PS-03'; Name = 'Open product details'; Request = 'GET /api/Products/<id>'; Mix = '20%'; Tag = 'product details'
         Expected = 'HTTP 200, correct product returned; p95 < 500 ms' },
      @{ Id = 'PS-04'; Name = 'Module error rate'; Request = 'All of the above'; Mix = '100%'; Tag = $null
         Expected = 'Failed requests < 1%; checks passed > 99%' }
    )
  },
  @{
    Sheet = 'Login'; Test = 'login'; Script = 'scripts\login.js'
    Objective = 'Confirm that authentication (successful login with profile lookup, and rejection of wrong passwords) stays fast and correct under 30 concurrent users.'
    Load = 'ramping-vus: 0 to 30 users over 1 min, hold 30 users for 3 min, ramp down over 30 s (4 min 30 s total). Think time 1-3 s per iteration.'
    Data = '30 fresh accounts (login_<runId>_<n>@test.local / Passw0rd!) registered in setup(), one per virtual user. Wrong-password attempts use the same accounts with an invalid password.'
    Steps = "1. Start Juice Shop.`n2. Run .\run.ps1 login.`n3. setup() registers 30 users (not measured as part of the load).`n4. Each user repeats: 85% log in and call whoami with the token cookie; 15% log in with a wrong password and expect 401; pause 1-3 s.`n5. Review the summary and dashboard."
    Metrics = 'Response time per request type; throughput; error rate (401 on wrong password counts as expected, not as a failure); check pass rate; Juice Shop CPU.'
    Other = 'POST /rest/user/login returns a JWT. GET /rest/user/whoami reads that token from the token cookie, as the browser app sends it.'
    Cases = @(
      @{ Id = 'LG-01'; Name = 'Successful login'; Request = 'POST /rest/user/login'; Mix = '85%'; Tag = 'login'
         Expected = 'HTTP 200 with a token; p95 < 800 ms' },
      @{ Id = 'LG-02'; Name = 'Profile lookup after login'; Request = 'GET /rest/user/whoami'; Mix = '85% (after LG-01)'; Tag = 'whoami'
         Expected = 'Returns the logged-in email; p95 < 500 ms' },
      @{ Id = 'LG-03'; Name = 'Login with wrong password'; Request = 'POST /rest/user/login'; Mix = '15%'; Tag = 'login (wrong password)'
         Expected = 'HTTP 401; p95 < 800 ms' },
      @{ Id = 'LG-04'; Name = 'Module error rate'; Request = 'All of the above'; Mix = '100%'; Tag = $null
         Expected = 'Failed requests < 1%; checks passed > 99%' }
    )
  },
  @{
    Sheet = 'Basket'; Test = 'basket'; Script = 'scripts\basket.js'
    Objective = 'Confirm that the shopping basket (view, add, change quantity, remove) stays fast and consistent under 30 concurrent logged-in shoppers.'
    Load = 'ramping-vus: 0 to 30 users over 1 min, hold 30 users for 3 min, ramp down over 30 s (4 min 30 s total). Think time 1-2 s between actions.'
    Data = '30 fresh accounts registered in setup(), one basket per virtual user so baskets are never shared. Products limited to in-stock items (stock >= 10) that allow at least 2 per customer.'
    Steps = "1. Start Juice Shop.`n2. Run .\run.ps1 basket.`n3. setup() registers 30 users and builds the product pool.`n4. Each user logs in once, then repeats: view basket, add a random product, set quantity to 2, view basket, remove the product.`n5. Review the summary and dashboard."
    Metrics = 'Response time per basket action; throughput; error rate; check pass rate (including that the added product appears in the basket); Juice Shop CPU.'
    Other = 'Writes go to SQLite. Removing the product at the end keeps every basket small, so results are not skewed by baskets growing during the run.'
    Cases = @(
      @{ Id = 'BK-01'; Name = 'View basket'; Request = 'GET /rest/basket/<id>'; Mix = '40%'; Tag = 'basket view'
         Expected = 'HTTP 200, added product is listed; p95 < 800 ms' },
      @{ Id = 'BK-02'; Name = 'Add product to basket'; Request = 'POST /api/BasketItems'; Mix = '20%'; Tag = 'basket add'
         Expected = 'HTTP 200; p95 < 800 ms' },
      @{ Id = 'BK-03'; Name = 'Change quantity'; Request = 'PUT /api/BasketItems/<id>'; Mix = '20%'; Tag = 'basket update'
         Expected = 'HTTP 200, quantity is 2; p95 < 800 ms' },
      @{ Id = 'BK-04'; Name = 'Remove product'; Request = 'DELETE /api/BasketItems/<id>'; Mix = '20%'; Tag = 'basket remove'
         Expected = 'HTTP 200; p95 < 800 ms' },
      @{ Id = 'BK-05'; Name = 'Module error rate'; Request = 'All of the above'; Mix = '100%'; Tag = $null
         Expected = 'Failed requests < 1%; checks passed > 99%' }
    )
  },
  @{
    Sheet = 'Stress - Search'; Test = 'stress'; Script = 'scripts\stress.js'
    Objective = 'Find the request rate at which product search stops meeting its 500 ms p95 target or starts failing, and identify the limiting resource.'
    Load = 'ramping-arrival-rate (open model): 10, 20, 30, 40, 50, 60, 80, 100 requests/s, 1 min per step (5 s climb, 55 s hold), 8 min total. Up to 1,000 virtual users; no think time; 30 s request timeout.'
    Data = 'Keyword searches only, terms chosen at random from the 24 matching terms in data\search-terms.json.'
    Steps = "1. Start Juice Shop.`n2. Run .\run.ps1 stress.`n3. k6 starts requests at each step's rate regardless of how fast the server answers.`n4. Every request is tagged with its step, so the summary reports each step separately.`n5. Compare p95, error rate and achieved throughput per step with Juice Shop CPU in results\server-metrics.csv."
    Metrics = 'p95 response time, error rate and achieved requests/s per step; dropped iterations (requests k6 could not start in time); Juice Shop CPU and memory.'
    Other = 'Thresholds in this script are deliberately unreachable so every step is recorded; each step is judged against the 500 ms p95 target here and in the report. A first run with steps of 50-800 requests/s (results\2026-10-27_12-47-01\stress-overload-*) was overloaded from its first step, which is why these steps zoom in on 10-100.'
    Cases = @(10, 20, 30, 40, 50, 60, 80, 100 | ForEach-Object {
      @{ Id = "ST-$_"; Name = "Search at $_ requests/s"; Request = 'GET /rest/products/search?q=<hit>'; Mix = '100%'; Tag = "step:${_}rps"
         Expected = 'p95 < 500 ms and errors < 1% (target; a step that misses it marks the breaking point)' }
    })
  }
)

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
try {
  $wb = $excel.Workbooks.Add()
  while ($wb.Worksheets.Count -gt 1) { $wb.Worksheets.Item(2).Delete() }

  $headerColor = 0x6B3A1F   # BGR: dark blue
  $labelColor = 0xF7EBDD    # BGR: light blue

  function Set-Header($range) {
    $range.Font.Bold = $true; $range.Font.Color = 0xFFFFFF; $range.Interior.Color = $headerColor
  }

  # Overview sheet
  $ws = $wb.Worksheets.Item(1)
  $ws.Name = 'Overview'
  $ws.Cells.Item(1, 1) = 'Juice Shop Performance Test Scenarios'
  $ws.Cells.Item(1, 1).Font.Size = 16; $ws.Cells.Item(1, 1).Font.Bold = $true
  $rows = @(
    @('Application under test', 'OWASP Juice Shop v20.3.0 (open-source e-commerce web app)'),
    @('Modules tested', 'Product Search, Login, Basket (one sheet each), plus a stress test of Product Search'),
    @('Tool', 'k6 v2.3.0'),
    @('Test types', 'Load test per module (expected peak traffic), stress test (beyond peak until it breaks), smoke test (1 user, script sanity check)'),
    @('Run all tests', '.\run.ps1 all   (or .\run.ps1 <test> for one, .\run.ps1 login,basket for several)'),
    @('Results', 'One folder per run: results\<yyyy-MM-dd_HH-mm-ss>\<test>-summary.json, -dashboard.html and -server-metrics.csv. Analysis in docs\report\performance-test-report.html'),
    @('Actual columns', 'Filled from the newest run folder that contains each test (see the report for which runs were used)')
  ) + $environment
  $r = 3
  foreach ($row in $rows) {
    $ws.Cells.Item($r, 1) = $row[0]; $ws.Cells.Item($r, 2) = $row[1]
    $ws.Cells.Item($r, 1).Font.Bold = $true; $ws.Cells.Item($r, 1).Interior.Color = $labelColor
    $r++
  }
  $ws.Columns.Item(1).ColumnWidth = 26; $ws.Columns.Item(2).ColumnWidth = 110
  $ws.Range("B3:B$r").WrapText = $true

  foreach ($m in $modules) {
    $summary = Get-Summary $m.Test
    $ws = $wb.Worksheets.Add([System.Reflection.Missing]::Value, $wb.Worksheets.Item($wb.Worksheets.Count))
    $ws.Name = $m.Sheet

    $ws.Cells.Item(1, 1) = "Module: $($m.Sheet)"
    $ws.Cells.Item(1, 1).Font.Size = 14; $ws.Cells.Item(1, 1).Font.Bold = $true
    $info = @(
      @('Module name', $m.Sheet),
      @('Test objective', $m.Objective),
      @('Script', $m.Script)
    ) + $environment + @(
      @('Load profile (users, ramp-up, duration)', $m.Load),
      @('Test data and parameters', $m.Data),
      @('Test execution steps', $m.Steps),
      @('Performance metrics measured', $m.Metrics),
      @('Other details', $m.Other)
    )
    $r = 3
    foreach ($row in $info) {
      $ws.Cells.Item($r, 1) = $row[0]; $ws.Cells.Item($r, 2) = $row[1]
      $ws.Cells.Item($r, 1).Font.Bold = $true; $ws.Cells.Item($r, 1).Interior.Color = $labelColor
      $ws.Range($ws.Cells.Item($r, 2), $ws.Cells.Item($r, 9)).Merge()
      $ws.Cells.Item($r, 2).WrapText = $true
      $lines = [math]::Max(1, [math]::Ceiling($row[1].Length / 150)) + ($row[1].Split("`n").Count - 1)
      $ws.Rows.Item($r).RowHeight = 15 * $lines
      $r++
    }

    $r++
    $ws.Cells.Item($r, 1) = 'Test cases and expected results'
    $ws.Cells.Item($r, 1).Font.Bold = $true; $ws.Cells.Item($r, 1).Font.Size = 12
    $r++
    $headers = 'TC ID', 'Scenario', 'Request', 'Workload share', 'Expected result', 'Actual p95', 'Actual avg', 'Actual errors / checks', 'Status'
    for ($c = 0; $c -lt $headers.Count; $c++) { $ws.Cells.Item($r, $c + 1) = $headers[$c] }
    Set-Header $ws.Range($ws.Cells.Item($r, 1), $ws.Cells.Item($r, $headers.Count))
    $first = $r + 1

    foreach ($tc in $m.Cases) {
      $r++
      $p95 = $null; $avg = $null; $errText = ''; $status = 'Not run'
      if ($summary) {
        if ($m.Test -eq 'stress') {
          $d = Get-Metric $summary "http_req_duration{$($tc.Tag)}"
          $f = Get-Metric $summary "http_req_failed{$($tc.Tag)}"
          $n = Get-Metric $summary "http_reqs{$($tc.Tag)}"
          if ($d) {
            $p95 = $d.'p(95)'; $avg = $d.avg
            $errText = '{0:P2} errors; {1:N0} requests, {2:N1}/s completed' -f $f.value, $n.count, ($n.count / 60)
            $status = if ($p95 -lt 500 -and $f.value -lt 0.01) { 'Pass' } else { 'Fail (over capacity)' }
          }
        } elseif ($tc.Tag) {
          $d = Get-Metric $summary "http_req_duration{name:$($tc.Tag)}"
          $p95 = $d.'p(95)'; $avg = $d.avg
          $limit = [double]([regex]::Match($tc.Expected, 'p95 < (\d+)').Groups[1].Value)
          $status = if ($p95 -lt $limit) { 'Pass' } else { 'Fail' }
        } else {
          $failed = (Get-Metric $summary 'http_req_failed').value
          $checks = (Get-Metric $summary 'checks').value
          $errText = '{0:P2} failed requests, {1:P2} checks passed' -f $failed, $checks
          $status = if ($failed -lt 0.01 -and $checks -gt 0.99) { 'Pass' } else { 'Fail' }
        }
      }
      $vals = $tc.Id, $tc.Name, $tc.Request, $tc.Mix, $tc.Expected,
        $(if ($tc.Tag) { Format-Ms $p95 } else { 'n/a' }), $(if ($tc.Tag) { Format-Ms $avg } else { 'n/a' }), $errText, $status
      for ($c = 0; $c -lt $vals.Count; $c++) { $ws.Cells.Item($r, $c + 1) = [string]$vals[$c] }
      $cell = $ws.Cells.Item($r, 9)
      if ($status -like 'Pass*') { $cell.Interior.Color = 0xCEEFC6; $cell.Font.Color = 0x006100 }
      elseif ($status -like 'Fail*') { $cell.Interior.Color = 0xCEC7FF; $cell.Font.Color = 0x06009C }
    }
    $table = $ws.Range($ws.Cells.Item($first - 1, 1), $ws.Cells.Item($r, 9))
    $table.Borders.LineStyle = 1
    $table.WrapText = $true
    $table.VerticalAlignment = -4160   # top

    $widths = 26, 30, 34, 14, 40, 12, 12, 30, 18
    for ($c = 0; $c -lt $widths.Count; $c++) { $ws.Columns.Item($c + 1).ColumnWidth = $widths[$c] }
    $ws.Range("A3:A$r").VerticalAlignment = -4160
  }

  foreach ($s in $wb.Worksheets) { $s.Cells.Font.Name = 'Arial'; $s.Cells.Font.Size = 10 }
  foreach ($s in $wb.Worksheets) { $s.Range('A1').Font.Size = $(if ($s.Name -eq 'Overview') { 16 } else { 14 }) }
  $wb.Worksheets.Item(1).Activate()
  if (Test-Path $outFile) { Remove-Item $outFile }
  $wb.SaveAs($outFile, 51)   # 51 = .xlsx
  $wb.Close($false)
  Write-Host "Saved $outFile"
}
finally {
  $excel.Quit()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($excel)
}
