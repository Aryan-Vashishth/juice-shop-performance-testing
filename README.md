# Juice Shop Performance Testing

Performance testing of [OWASP Juice Shop](https://github.com/juice-shop/juice-shop) v20.3.0, an
open-source e-commerce web app, using [k6](https://k6.io/). Three modules are tested separately
(**Product Search**, **Login** and **Basket**), followed by a stress test that pushes product
search until it breaks.

**Just want to run it?** See [QUICKSTART.md](QUICKSTART.md): clone, run, see the results.

## Deliverables

| Deliverable | Location |
|---|---|
| Performance test report (results, charts, bottlenecks, recommendations, limitations) | [docs/report/performance-test-report.html](docs/report/performance-test-report.html) (PDF next to it) |
| Performance test scenario sheet (one sub-sheet per module, with test cases and actual results) | [docs/scenarios/performance-test-scenarios.xlsx](docs/scenarios/performance-test-scenarios.xlsx) |
| Tool selection and justification | [docs/tool-selection.md](docs/tool-selection.md) |
| Test scripts | [scripts/](scripts/) |
| Raw results of every run | [results/](results/) |

## Requirements

- Windows 10 (1803 or later) or Windows 11, with PowerShell
- Git, to clone the repo
- Internet access on the first run

Nothing else needs to be installed. On the first run, `run.ps1` downloads everything it needs
into this folder: Node.js v24.21.0, Juice Shop v20.3.0 and k6 v2.3.0 (about 190 MB, checksums verified).
Nothing is installed system-wide and no admin rights are needed.

## Quick start

```powershell
git clone https://github.com/Aryan-Vashishth/juice-shop-performance-testing.git
cd juice-shop-performance-testing
.\run.ps1 all
```

`all` runs every test in order and takes about 22 minutes. To run one test, name it instead,
for example `.\run.ps1 login`.

If PowerShell refuses with "running scripts is disabled on this system", use:

```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1 all
```

## Tests

| Test | Script | Load | Pass criteria |
|---|---|---|---|
| `smoke` | [smoke.js](scripts/smoke.js) | 1 user, 1 pass through all three modules | Every check passes, no failed requests |
| `product-search` | [product-search.js](scripts/product-search.js) | Ramp to 50 users over 1 min, hold 3 min, ramp down 30 s. 70% keyword search, 10% search with no results, 20% product details | p95 < 500 ms per request type, < 1% failed requests |
| `login` | [login.js](scripts/login.js) | Ramp to 30 users over 1 min, hold 3 min, ramp down 30 s. 85% login and profile lookup, 15% wrong password | Login p95 < 800 ms, profile p95 < 500 ms, < 1% failed requests |
| `basket` | [basket.js](scripts/basket.js) | Ramp to 30 users over 1 min, hold 3 min, ramp down 30 s. Each user views the basket, adds an item, changes its quantity and removes it | p95 < 800 ms per action, < 1% failed requests |
| `stress` | [stress.js](scripts/stress.js) | Product search at 10, 20, 30, 40, 50, 60, 80 and 100 requests/s, 1 min per step | Measured per step and judged in the report (target: p95 < 500 ms, < 1% errors) |

Every request has a check on its response, not just its status code. Shared helpers are in
[scripts/lib/common.js](scripts/lib/common.js) and search terms in [data/search-terms.json](data/search-terms.json).
The stress steps can be changed with `RATES`, for example
`tools\k6-v2.3.0-windows-amd64\k6.exe run -e RATES=50,100,200 scripts\stress.js`.

## What `run.ps1` does

1. Creates a folder for this run, named by its start time: `results\<yyyy-MM-dd_HH-mm-ss>\`
   and `logs\<yyyy-MM-dd_HH-mm-ss>\`. Runs never overwrite each other.
2. Downloads and unpacks k6 into `tools\` if it isn't there yet.
3. Checks whether Juice Shop answers at `http://localhost:3000`. If it doesn't, it downloads
   Node.js into `tools\` and Juice Shop into `app\` (first run only), starts Juice Shop in the
   background and waits for it to be ready.
4. Runs each test with k6. While a test runs, it records Juice Shop's CPU and memory every 2 seconds.
5. Stops Juice Shop if it started it. Juice Shop resets its database on every start.

If Juice Shop is already running (for example you started it yourself), the script uses it and
leaves it running. To test another host, set `BASE_URL` first, e.g. `$env:BASE_URL = 'http://my-host:3000'`.
The script then starts nothing locally and can't record server CPU and memory.

## Results

Each run folder contains:

| File | Contents |
|---|---|
| `results\<run>\<test>-summary.json` | k6 end-of-test summary: response time percentiles, throughput, error rate, checks, thresholds |
| `results\<run>\<test>-dashboard.html` | k6 HTML report with time-series graphs (open in a browser) |
| `results\<run>\<test>-server-metrics.csv` | Juice Shop CPU (100% = one full core) and memory, every 2 s |
| `results\<run>\run.json` | When the run started and finished, versions, and each test's exit code |
| `logs\<run>\run.log` | Full console output of the run |
| `logs\<run>\juice-shop.log` | Juice Shop's server log, when `run.ps1` started it |

k6 prints a summary at the end of each test. A passing test shows a green tick next to each
threshold and exits with code 0. A failing threshold shows a red cross, and `run.ps1` then exits non-zero.
In `<test>-summary.json`, `"thresholds": { "...": false }` means the threshold was **not** crossed,
so it passed.

`results\` is in git so the report's data can be checked. `logs\` is not.

## How reporting works

Reporting has three layers. Each is built from the one before it, so every number in the
documents can be traced back to a raw result file.

**1. Per test, written by k6 during the run** (in `results\<run>\`):

- The terminal summary, also saved in `logs\<run>\run.log`, shows pass/fail per threshold.
- `<test>-summary.json` holds the numbers the documents are built from: response-time percentiles
  per request type, throughput, error rate and checks.
- `<test>-dashboard.html` is k6's own report, with graphs over time of response time, request rate and
  virtual users. It's handy for looking at a single run.
- `<test>-server-metrics.csv` holds Juice Shop's CPU and memory, recorded by `run.ps1` next to k6.

**2. The run folder.** Every run of `run.ps1` creates a new `results\<yyyy-MM-dd_HH-mm-ss>\`, so
results are never overwritten. `run.json` in that folder records what ran, when, and each test's exit code.

**3. The documents, generated from the run folders:**

| Document | Built by | What it takes from the results |
|---|---|---|
| [Report](docs/report/performance-test-report.html) (HTML, with a PDF copy) | [docs/report/build-report.js](docs/report/build-report.js) | Every table and chart: per-request response times against their limits, server CPU per module, the stress test per step, memory over time |
| [Scenario sheet](docs/scenarios/performance-test-scenarios.xlsx) | [docs/build-scenario-sheet.ps1](docs/build-scenario-sheet.ps1) | The "Actual p95", "Actual avg", errors and Pass/Fail columns of each test case |

For each test, both generators use the **newest run folder that contains it**. A stress rerun
therefore updates the stress sections without rerunning the load tests. The report ends with a
list of the run folders it used.

The charts are SVG drawn by `build-report.js` from the data, with no chart library. Hover a bar or
point to see its value. The report follows the viewer's light or dark mode and prints cleanly.

The written analysis (summary, bottlenecks, recommendations, limitations) is the only hand-written
part. It is in [docs/report/analysis.js](docs/report/analysis.js), kept apart from the code that reads the numbers.

### Rebuilding the documents after a new run

```powershell
# Report (HTML)
tools\node-v24.21.0-win-x64\node.exe docs\report\build-report.js

# Report (PDF), printed with Edge
& "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe" --headless=new --disable-gpu `
  --no-pdf-header-footer --print-to-pdf="$PWD\docs\report\performance-test-report.pdf" `
  "$PWD\docs\report\performance-test-report.html"

# Scenario sheet (needs Microsoft Excel)
powershell -ExecutionPolicy Bypass -File docs\build-scenario-sheet.ps1
```

If the new numbers change a conclusion, update `analysis.js` before rebuilding. The generated
tables and charts update by themselves, but the written text doesn't.

## Running Juice Shop by hand

To explore the app in a browser, start it yourself after the first run:

```powershell
cd app\juice-shop_20.3.0
..\..\tools\node-v24.21.0-win-x64\node.exe build/app
```

Open http://localhost:3000 and stop it with Ctrl+C.

## Layout

| Path | Contents |
|---|---|
| `scripts/` | k6 test scripts, one per module, plus smoke and stress |
| `data/` | Test data (search terms) |
| `docs/` | Report, scenario sheet, tool selection, and the scripts that build them |
| `results/` | One folder per run with summaries, HTML dashboards and server metrics |
| `run.ps1` | Sets up, starts Juice Shop and runs tests by name |
| `app/`, `tools/` | Juice Shop, Node.js and k6, downloaded on first run (not in git) |
| `logs/` | One folder per run with console and server logs (not in git) |
